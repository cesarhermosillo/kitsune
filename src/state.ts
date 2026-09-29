import type { EventBus, KitsuneEvent } from "./events.js";
import type { Store } from "./store.js";

export interface PendingItem { id: string; title: string; url: string; repo: string; workflow: string; createdAt: number }
export interface SessionItem { name: string; stage: string | null; stagesDone: number; stagesTotal: number; needsInput: boolean; question?: string }
export interface PetState { triaging: boolean; pending: PendingItem[]; sessions: SessionItem[]; lastError: { message: string; at: number } | null }
export interface StateTracker { snapshot(): PetState; dispose(): void }

const MAX = 500;
const clip = (text: string) => (text.length > MAX ? text.slice(0, MAX) : text);

export function createStateTracker(deps: { store: Store; bus: EventBus }): StateTracker {
  let triaging = false;
  let lastError: PetState["lastError"] = null;
  const live = new Map<string, Omit<SessionItem, "name">>();

  const off = deps.bus.subscribe((e: KitsuneEvent) => {
    switch (e.type) {
      case "triage_started": triaging = true; break;
      case "event_triaged": triaging = false; break;
      case "session_update": live.set(e.name, { stage: e.stage === null ? null : clip(e.stage), stagesDone: e.stagesDone, stagesTotal: e.stagesTotal, needsInput: false }); break;
      case "session_question": {
        const prev = live.get(e.name) ?? { stage: null, stagesDone: 0, stagesTotal: 0, needsInput: false };
        live.set(e.name, { ...prev, needsInput: true, question: clip(e.question) });
        break;
      }
      case "session_done":
      case "session_dead": live.delete(e.name); break;
      case "error": lastError = { message: clip(e.message), at: e.at }; break;
      default: break;
    }
  });

  return {
    snapshot() {
      const pending = deps.store.listPending().map((p) => ({
        id: p.id, title: clip(p.title || p.origin), url: clip(p.url), repo: clip(p.repo), workflow: clip(p.workflowName), createdAt: p.createdAt,
      }));
      const sessions = deps.store.listActiveSessions().map((t) => {
        const s = live.get(t.name);
        const item: SessionItem = { name: clip(t.name), stage: s?.stage ?? null, stagesDone: s?.stagesDone ?? 0, stagesTotal: s?.stagesTotal ?? 0, needsInput: s?.needsInput ?? false };
        if (s?.question) item.question = s.question;
        return item;
      });
      return { triaging, pending, sessions, lastError };
    },
    dispose: off,
  };
}
