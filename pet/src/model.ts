import type { KitsuneEvent, PetAnimation, PetState, PetStatus, SessionItem } from "./types";

export const BUBBLE_MS = 6000;
export const SAD_MS = 60000;
export const CELEBRATE_MS = 3000;
export const SLEEP_AFTER_MS = 600000;
export const QUESTION_MAX = 140;

export interface Bubble {
  text: string;
  sticky: boolean;
  until: number;
  session?: string;
}

export interface Model {
  connected: boolean;
  state: PetState;
  sadUntil: number;
  celebrateUntil: number;
  lastActivityAt: number;
  bubble: Bubble | null;
  dnd: boolean;
  /** Motivo de la última desconexión; null mientras hay conexión o antes del primer intento. */
  offlineReason: string | null;
}

export const OFFLINE_TEXT = "Kitsune no está corriendo";

export const EMPTY_STATE: PetState = {
  triaging: false,
  pending: [],
  sessions: [],
  lastError: null,
};

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function initialModel(now: number): Model {
  return {
    connected: false,
    state: EMPTY_STATE,
    sadUntil: 0,
    celebrateUntil: 0,
    lastActivityAt: now,
    bubble: null,
    dnd: false,
    offlineReason: null,
  };
}

export function setConnected(
  m: Model,
  connected: boolean,
  now: number,
  reason?: string
): Model {
  return {
    ...m,
    connected,
    offlineReason: connected ? null : (reason ?? ""),
    lastActivityAt: connected ? now : m.lastActivityAt,
  };
}

/** Spec §3/§7: texto de la burbuja mientras no hay conexión (null si hay conexión o aún no se intentó). */
export function offlineText(m: Model): string | null {
  if (m.connected || m.offlineReason === null) return null;
  return /token/i.test(m.offlineReason) ? m.offlineReason : OFFLINE_TEXT;
}

export function applySnapshot(m: Model, s: PetState, _now: number): Model {
  // Tras reconectar, una pregunta fija que ya se contestó (o cuya sesión terminó) no debe quedarse.
  const b = m.bubble;
  const stale =
    b?.sticky &&
    !s.sessions.some((x) => x.name === b.session && x.needsInput);
  return { ...m, state: s, bubble: stale ? null : b };
}

export function applyEvent(m: Model, e: KitsuneEvent, now: number): Model {
  let state = m.state;
  let { sadUntil, celebrateUntil, bubble } = m;

  const say = (text: string, sticky = false, session?: string) => {
    if (!m.dnd)
      bubble = {
        text,
        sticky,
        until: sticky ? Number.POSITIVE_INFINITY : now + BUBBLE_MS,
        ...(session ? { session } : {}),
      };
  };

  const upsert = (name: string, patch: Partial<SessionItem>) => {
    const prev =
      state.sessions.find((s) => s.name === name) ??
      { name, stage: null, stagesDone: 0, stagesTotal: 0, needsInput: false };
    const { question: _drop, ...base } = prev;
    const next: SessionItem = { ...base, ...patch, name };
    if (!next.needsInput) delete next.question;
    state = {
      ...state,
      sessions: [
        ...state.sessions.filter((s) => s.name !== name),
        next,
      ],
    };
  };

  const drop = (name: string) => {
    state = { ...state, sessions: state.sessions.filter((s) => s.name !== name) };
  };

  const clearSticky = (name: string) => {
    if (bubble?.sticky && bubble.session === name) bubble = null;
  };

  switch (e.type) {
    case "triage_started":
      state = { ...state, triaging: true };
      say("Revisando…");
      break;
    case "event_triaged":
      state = { ...state, triaging: false };
      if (e.action === "failed") sadUntil = now + SAD_MS;
      break;
    case "proposal_created":
      if (!state.pending.some((p) => p.id === e.id)) {
        state = {
          ...state,
          pending: [
            ...state.pending,
            {
              id: e.id,
              title: e.title,
              url: e.url,
              repo: e.repo,
              workflow: e.workflow,
              createdAt: e.at,
            },
          ],
        };
      }
      say(`Nueva tarea: ${e.title}`);
      break;
    case "proposal_resolved":
      state = {
        ...state,
        pending: state.pending.filter((p) => p.id !== e.id),
      };
      break;
    case "session_update":
      upsert(e.name, {
        stage: e.stage,
        stagesDone: e.stagesDone,
        stagesTotal: e.stagesTotal,
        needsInput: false,
      });
      clearSticky(e.name);
      break;
    case "session_question":
      upsert(e.name, {
        needsInput: true,
        question: e.question,
      });
      say(
        `${e.name} pregunta: ${clip(e.question, QUESTION_MAX)}`,
        true,
        e.name
      );
      break;
    case "session_done":
      drop(e.name);
      clearSticky(e.name);
      celebrateUntil = now + CELEBRATE_MS;
      say(`✅ ${e.name} terminó`);
      break;
    case "session_dead":
      drop(e.name);
      clearSticky(e.name);
      sadUntil = now + SAD_MS;
      say(`💤 ${e.name}: ${e.reason}`);
      break;
    case "error":
      state = {
        ...state,
        lastError: { message: e.message, at: e.at },
      };
      sadUntil = now + SAD_MS;
      say(`⚠️ ${clip(e.message, QUESTION_MAX)}`);
      break;
  }

  return { ...m, state, sadUntil, celebrateUntil, bubble, lastActivityAt: now };
}

export function computeStatus(m: Model, now: number): PetStatus {
  if (!m.connected) return "offline";
  if (m.dnd) return "sleeping";
  if (m.state.sessions.some((s) => s.needsInput && s.question))
    return "asking";
  if (m.state.pending.length > 0) return "alert";
  if (now < m.sadUntil) return "sad";
  if (m.state.sessions.length > 0) return "working";
  if (m.state.triaging) return "sniffing";
  return now - m.lastActivityAt < SLEEP_AFTER_MS ? "idle" : "sleeping";
}

export function currentAnimation(
  m: Model,
  now: number
): PetAnimation | "offline" {
  if (!m.connected) return "offline";
  if (!m.dnd && now < m.celebrateUntil) return "celebrate";
  return computeStatus(m, now) as PetAnimation;
}

export function visibleBubble(m: Model, now: number): Bubble | null {
  if (m.dnd || !m.bubble) return null;
  return m.bubble.sticky || now < m.bubble.until ? m.bubble : null;
}

export function summary(s: PetState): string {
  const parts: string[] = [];
  const n = s.sessions.length;
  const p = s.pending.length;
  if (n) parts.push(`${n} ${n === 1 ? "sesión trabajando" : "sesiones trabajando"}`);
  if (p) parts.push(`${p} ${p === 1 ? "propuesta pendiente" : "propuestas pendientes"}`);
  return parts.join(" · ") || "Todo tranquilo";
}
