import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InvalidTransition } from "./proposals.js";
import { openStore } from "./store.js";
import type { InboxEvent } from "./types.js";

const EVENT: InboxEvent = {
  source: "clickup", id: "task_assigned:86abc", kind: "task_assigned", title: "Valida títulos", body: "…",
  url: "https://app.clickup.com/t/86abc", author: "ana", at: "2026-09-28T10:00:00.000Z",
  meta: { taskId: "86abc", listId: "901", listName: "Backlog", tags: [] },
};
const NEW = { eventId: EVENT.id, repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia", request: "valida", origin: "clickup:86abc", title: "Valida títulos", url: "https://app.clickup.com/t/86abc" };

test("eventos: hasEvent y saveEvent", () => {
  const store = openStore(":memory:");
  assert.equal(store.hasEvent(EVENT.id), false);
  store.saveEvent(EVENT, 1);
  assert.equal(store.hasEvent(EVENT.id), true);
  store.setTriage(EVENT.id, { action: "ignore", reason: "ruido" }, "done");
  store.close();
});

test("propuestas: crear, transicionar y rechazar transiciones inválidas", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const p = store.createProposal(NEW, 10);
  assert.equal(p.status, "pending");
  assert.match(p.id, /^[a-z0-9]{10}$/);
  const approved = store.transition(p.id, "approved", 20);
  assert.equal(approved.status, "approved");
  assert.equal(approved.updatedAt, 20);
  assert.throws(() => store.transition(p.id, "approved", 21), InvalidTransition);
  const launched = store.transition(p.id, "launched", 30, { sessionName: "cowork-valida" });
  assert.equal(launched.sessionName, "cowork-valida");
  store.close();
});

test("transition con from esperado detecta carreras (transición no atómica)", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const p = store.createProposal(NEW, 10);
  assert.throws(() => store.transition(p.id, "approved", 20, undefined, "failed"), InvalidTransition);
  const approved = store.transition(p.id, "approved", 21, undefined, "pending");
  assert.equal(approved.status, "approved");
  store.transition(p.id, "failed", 22, { error: "no responde" });
  const retried = store.transition(p.id, "approved", 23, undefined, "failed");
  assert.equal(retried.status, "approved");
  assert.throws(() => store.transition(p.id, "approved", 24, undefined, "pending"), InvalidTransition);
  store.close();
});

test("updatePending solo aplica a propuestas pendientes", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const p = store.createProposal(NEW, 10);
  assert.equal(store.updatePending(p.id, { request: "nuevo" }, 11).request, "nuevo");
  store.transition(p.id, "rejected", 12);
  assert.throws(() => store.updatePending(p.id, { request: "x" }, 13), InvalidTransition);
  store.close();
});

test("listPending, messageId, sesiones seguidas y ediciones pendientes", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const p = store.createProposal(NEW, 10);
  store.setMessageId(p.id, 555);
  assert.equal(store.getProposal(p.id)?.telegramMessageId, 555);
  assert.deepEqual(store.listPending().map((x) => x.id), [p.id]);
  store.trackSession("cowork-valida", p.id);
  store.updateSession("cowork-valida", { lastQuestion: "¿sigo?", questionMessageId: 777 });
  assert.equal(store.findSessionByQuestion(777)?.name, "cowork-valida");
  store.updateSession("cowork-valida", { notifiedDone: true });
  assert.deepEqual(store.listActiveSessions(), []);
  store.setPendingEdit(900, p.id);
  assert.equal(store.takePendingEdit(900), p.id);
  assert.equal(store.takePendingEdit(900), null);
  store.close();
});

test("cursores y auditoría", () => {
  const store = openStore(":memory:");
  assert.equal(store.getCursor("clickup"), null);
  store.setCursor("clickup", "123");
  store.setCursor("clickup", "456");
  assert.equal(store.getCursor("clickup"), "456");
  store.audit("user", "approve", "p1", { chat: 42 }, 99);
  assert.deepEqual(store.listAudit(10), [{ ts: 99, actor: "user", action: "approve", target: "p1", detail: { chat: 42 } }]);
  store.close();
});

test("los datos sobreviven a reabrir la base", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitsune-db-"));
  try {
    const path = join(dir, "k.db");
    const a = openStore(path);
    a.saveEvent(EVENT, 1);
    const p = a.createProposal(NEW, 10);
    a.close();
    const b = openStore(path);
    assert.equal(b.hasEvent(EVENT.id), true);
    assert.equal(b.getProposal(p.id)?.status, "pending");
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("approveWith exige pending, fija el workflow y transiciona a approved de forma atómica", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const p = store.createProposal(NEW, 10);
  const approved = store.approveWith(p.id, { workflowId: "wf-2", workflowName: "hotfix" }, 20);
  assert.deepEqual([approved.status, approved.workflowId, approved.workflowName, approved.updatedAt], ["approved", "wf-2", "hotfix", 20]);
  assert.throws(() => store.approveWith(p.id, { workflowId: "wf-3", workflowName: "otro" }, 21), InvalidTransition);
  assert.equal(store.getProposal(p.id)?.workflowId, "wf-2");
  store.close();
});

test("C: una base creada antes de title/url migra las columnas con ALTER TABLE", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitsune-db-"));
  try {
    const path = join(dir, "k.db");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE proposals (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, repo TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, request TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, telegram_message_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_name TEXT, error TEXT)`);
    raw.prepare(`INSERT INTO proposals (id, event_id, repo, workflow_id, workflow_name, request, origin, status, created_at, updated_at) VALUES ('p1','e1','repo','wf-1','name','req','clickup:1','pending',1,1)`).run();
    raw.close();
    const store = openStore(path);
    const p = store.getProposal("p1")!;
    assert.deepEqual([p.title, p.url], ["", ""]);
    const created = store.createProposal({ ...NEW, eventId: EVENT.id }, 2);
    assert.deepEqual([created.title, created.url], [NEW.title, NEW.url]);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failInterrupted pasa approved a failed con error 'interrumpida' y no toca las demás", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const a = store.createProposal(NEW, 10);
  const b = store.createProposal(NEW, 11);
  store.transition(a.id, "approved", 12);
  const out = store.failInterrupted(50);
  assert.deepEqual(out.map((p) => [p.id, p.status, p.error, p.updatedAt]), [[a.id, "failed", "interrumpida", 50]]);
  assert.equal(store.getProposal(b.id)?.status, "pending");
  assert.equal(store.transition(a.id, "approved", 51, undefined, "failed").status, "approved");
  store.close();
});

test("listRecentFailed incluye propuestas fallidas recientes y excluye las de hace más de 24h", () => {
  const store = openStore(":memory:");
  store.saveEvent(EVENT, 1);
  const p1 = store.createProposal(NEW, 10);
  const p2 = store.createProposal(NEW, 11);
  const p3 = store.createProposal(NEW, 12);
  // Fallar p1 y p2 recientes, p3 vieja
  const hour24Ms = 24 * 3_600_000;
  const now = 100_000;
  store.transition(p1.id, "approved", 20);
  store.transition(p1.id, "failed", now - hour24Ms / 2, { error: "recent" });
  store.transition(p2.id, "approved", 21);
  store.transition(p2.id, "failed", now - 1000, { error: "very recent" });
  store.transition(p3.id, "approved", 22);
  store.transition(p3.id, "failed", now - hour24Ms - 1000, { error: "old" });
  const recent = store.listRecentFailed(now - hour24Ms);
  // Should be sorted by created_at (p1 = 10, p2 = 11)
  assert.deepEqual(recent.map((p) => [p.id, p.status, p.error, p.createdAt]), [
    [p1.id, "failed", "recent", p1.createdAt],
    [p2.id, "failed", "very recent", p2.createdAt],
  ]);
  // Verify p3 is NOT included
  assert.equal(recent.length, 2);
  assert(!recent.some((p) => p.id === p3.id));
  store.close();
});
