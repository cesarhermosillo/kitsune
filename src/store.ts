import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canTransition, InvalidTransition } from "./proposals.js";
import type { InboxEvent, Proposal, ProposalStatus, Triage } from "./types.js";

export interface TrackedSession {
  name: string; proposalId: string; lastQuestion: string | null; lastGate: string | null;
  questionMessageId: number | null; notifiedDone: boolean;
}
export interface NewProposal { eventId: string; repo: string; workflowId: string; workflowName: string; request: string; origin: string; title: string; url: string }
export interface Store {
  hasEvent(id: string): boolean;
  saveEvent(event: InboxEvent, now: number): void;
  setTriage(id: string, triage: Triage | null, status: "done" | "failed"): void;
  createProposal(input: NewProposal, now: number): Proposal;
  getProposal(id: string): Proposal | null;
  transition(id: string, to: ProposalStatus, now: number, patch?: { sessionName?: string; error?: string | null }, from?: ProposalStatus): Proposal;
  updatePending(id: string, patch: Partial<Pick<Proposal, "repo" | "workflowId" | "workflowName" | "request">>, now: number): Proposal;
  /** Exige `pending`: fija workflowId/workflowName y transiciona a `approved` en una sola transacción atómica. */
  approveWith(id: string, patch: { workflowId: string; workflowName: string }, now: number): Proposal;
  setMessageId(id: string, messageId: number): void;
  listPending(): Proposal[];
  /** Propuestas pendientes que nunca llegaron a Telegram (telegram_message_id NULL). */
  listUndelivered(): Proposal[];
  /** Pasa todas las propuestas en `approved` a `failed` con error "interrumpida" y las devuelve. */
  failInterrupted(now: number): Proposal[];
  trackSession(name: string, proposalId: string): void;
  listActiveSessions(): TrackedSession[];
  updateSession(name: string, patch: Partial<Omit<TrackedSession, "name" | "proposalId">>): void;
  findSessionByQuestion(messageId: number): TrackedSession | null;
  setPendingEdit(messageId: number, proposalId: string): void;
  takePendingEdit(messageId: number): string | null;
  getCursor(source: string): string | null;
  setCursor(source: string, value: string): void;
  audit(actor: "kitsune" | "user" | "ronin", action: string, target: string, detail: unknown, now: number): void;
  listAudit(limit: number): Array<{ ts: number; actor: string; action: string; target: string; detail: unknown }>;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, seen_at INTEGER NOT NULL, triage_json TEXT, triage_status TEXT);
CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, repo TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, request TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, telegram_message_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_name TEXT, error TEXT, title TEXT, url TEXT);
CREATE TABLE IF NOT EXISTS sessions (name TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, last_question TEXT, last_gate TEXT, question_message_id INTEGER, notified_done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pending_edits (message_id INTEGER PRIMARY KEY, proposal_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

function toProposal(row: Row): Proposal {
  return {
    id: String(row.id), eventId: String(row.event_id), repo: String(row.repo),
    workflowId: String(row.workflow_id), workflowName: String(row.workflow_name),
    request: String(row.request), origin: String(row.origin),
    title: row.title === null || row.title === undefined ? "" : String(row.title),
    url: row.url === null || row.url === undefined ? "" : String(row.url),
    status: row.status as ProposalStatus,
    telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    sessionName: row.session_name === null ? null : String(row.session_name),
    error: row.error === null ? null : String(row.error),
  };
}

function toSession(row: Row): TrackedSession {
  return {
    name: String(row.name), proposalId: String(row.proposal_id),
    lastQuestion: row.last_question === null ? null : String(row.last_question),
    lastGate: row.last_gate === null ? null : String(row.last_gate),
    questionMessageId: row.question_message_id === null ? null : Number(row.question_message_id),
    notifiedDone: Number(row.notified_done) === 1,
  };
}

function newId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join("");
}

/** Añade una columna si falta (bases creadas antes de que existiera), detectado con PRAGMA table_info. */
function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (!cols.some((c) => String(c.name) === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  ensureColumn(db, "proposals", "title", "title TEXT");
  ensureColumn(db, "proposals", "url", "url TEXT");

  const getProposal = (id: string): Proposal | null => {
    const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return row ? toProposal(row) : null;
  };
  const inTx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
  };

  return {
    hasEvent: (id) => db.prepare("SELECT 1 FROM events WHERE id = ?").get(id) !== undefined,
    saveEvent: (event, now) => {
      db.prepare("INSERT OR IGNORE INTO events (id, source, kind, payload_json, seen_at) VALUES (?, ?, ?, ?, ?)")
        .run(event.id, event.source, event.kind, JSON.stringify(event), now);
    },
    setTriage: (id, triage, status) => {
      db.prepare("UPDATE events SET triage_json = ?, triage_status = ? WHERE id = ?").run(triage ? JSON.stringify(triage) : null, status, id);
    },
    createProposal: (input, now) => {
      const id = newId();
      db.prepare(`INSERT INTO proposals (id, event_id, repo, workflow_id, workflow_name, request, origin, title, url, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, input.eventId, input.repo, input.workflowId, input.workflowName, input.request, input.origin, input.title, input.url, now, now);
      return getProposal(id)!;
    },
    getProposal,
    transition: (id, to, now, patch = {}, from) => inTx(() => {
      const current = getProposal(id);
      if (!current) throw new Error(`propuesta desconocida: ${id}`);
      if (from !== undefined && current.status !== from) throw new InvalidTransition(current.status, to);
      if (!canTransition(current.status, to)) throw new InvalidTransition(current.status, to);
      db.prepare("UPDATE proposals SET status = ?, updated_at = ?, session_name = COALESCE(?, session_name), error = ? WHERE id = ?")
        .run(to, now, patch.sessionName ?? null, patch.error === undefined ? current.error : patch.error, id);
      return getProposal(id)!;
    }),
    updatePending: (id, patch, now) => inTx(() => {
      const current = getProposal(id);
      if (!current) throw new Error(`propuesta desconocida: ${id}`);
      if (current.status !== "pending") throw new InvalidTransition(current.status, "pending");
      const next = { ...current, ...patch };
      db.prepare("UPDATE proposals SET repo = ?, workflow_id = ?, workflow_name = ?, request = ?, updated_at = ? WHERE id = ?")
        .run(next.repo, next.workflowId, next.workflowName, next.request, now, id);
      return getProposal(id)!;
    }),
    approveWith: (id, patch, now) => inTx(() => {
      const current = getProposal(id);
      if (!current) throw new Error(`propuesta desconocida: ${id}`);
      if (current.status !== "pending" || !canTransition(current.status, "approved")) throw new InvalidTransition(current.status, "approved");
      db.prepare("UPDATE proposals SET workflow_id = ?, workflow_name = ?, status = 'approved', updated_at = ? WHERE id = ?")
        .run(patch.workflowId, patch.workflowName, now, id);
      return getProposal(id)!;
    }),
    setMessageId: (id, messageId) => { db.prepare("UPDATE proposals SET telegram_message_id = ? WHERE id = ?").run(messageId, id); },
    listPending: () => (db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at").all() as Row[]).map(toProposal),
    listUndelivered: () => (db.prepare("SELECT * FROM proposals WHERE status = 'pending' AND telegram_message_id IS NULL ORDER BY created_at").all() as Row[]).map(toProposal),
    failInterrupted: (now) => inTx(() => {
      const ids = (db.prepare("SELECT id FROM proposals WHERE status = 'approved' ORDER BY created_at").all() as Row[]).map((r) => String(r.id));
      db.prepare("UPDATE proposals SET status = 'failed', error = 'interrumpida', updated_at = ? WHERE status = 'approved'").run(now);
      return ids.map((id) => getProposal(id)!);
    }),
    trackSession: (name, proposalId) => { db.prepare("INSERT OR REPLACE INTO sessions (name, proposal_id) VALUES (?, ?)").run(name, proposalId); },
    listActiveSessions: () => (db.prepare("SELECT * FROM sessions WHERE notified_done = 0 ORDER BY name").all() as Row[]).map(toSession),
    updateSession: (name, patch) => {
      const row = db.prepare("SELECT * FROM sessions WHERE name = ?").get(name) as Row | undefined;
      if (!row) return;
      const next = { ...toSession(row), ...patch };
      db.prepare("UPDATE sessions SET last_question = ?, last_gate = ?, question_message_id = ?, notified_done = ? WHERE name = ?")
        .run(next.lastQuestion, next.lastGate, next.questionMessageId, next.notifiedDone ? 1 : 0, name);
    },
    findSessionByQuestion: (messageId) => {
      const row = db.prepare("SELECT * FROM sessions WHERE question_message_id = ?").get(messageId) as Row | undefined;
      return row ? toSession(row) : null;
    },
    setPendingEdit: (messageId, proposalId) => { db.prepare("INSERT OR REPLACE INTO pending_edits (message_id, proposal_id) VALUES (?, ?)").run(messageId, proposalId); },
    takePendingEdit: (messageId) => {
      const row = db.prepare("SELECT proposal_id FROM pending_edits WHERE message_id = ?").get(messageId) as Row | undefined;
      if (!row) return null;
      db.prepare("DELETE FROM pending_edits WHERE message_id = ?").run(messageId);
      return String(row.proposal_id);
    },
    getCursor: (source) => {
      const row = db.prepare("SELECT value FROM cursors WHERE source = ?").get(source) as Row | undefined;
      return row ? String(row.value) : null;
    },
    setCursor: (source, value) => { db.prepare("INSERT OR REPLACE INTO cursors (source, value) VALUES (?, ?)").run(source, value); },
    audit: (actor, action, target, detail, now) => {
      db.prepare("INSERT INTO audit (ts, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)").run(now, actor, action, target, JSON.stringify(detail ?? null));
    },
    listAudit: (limit) => (db.prepare("SELECT * FROM audit ORDER BY rowid DESC LIMIT ?").all(limit) as Row[])
      .map((row) => ({ ts: Number(row.ts), actor: String(row.actor), action: String(row.action), target: String(row.target), detail: JSON.parse(String(row.detail_json)) })),
    close: () => db.close(),
  };
}
