import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "./events.js";
import { createStateTracker } from "./state.js";
import { openStore } from "./store.js";

function setup() {
  const store = openStore(":memory:");
  const bus = createEventBus(() => 50);
  return { store, bus, tracker: createStateTracker({ store, bus }) };
}

test("pending sale del store con título, repo y workflow", () => {
  const { store, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "T", body: "", url: "https://u", author: "", at: "", meta: { taskId: "1", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd", request: "x", origin: "clickup:1", title: "T", url: "https://u" }, 10);
  assert.deepEqual(tracker.snapshot().pending, [{ id: p.id, title: "T", url: "https://u", repo: "todo-api", workflow: "plan-tdd", createdAt: 10, status: "pending" }]);
});

test("triaging, sesiones, preguntas y lastError siguen al bus", () => {
  const { store, bus, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "o", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  bus.publish({ type: "triage_started", title: "t" });
  assert.equal(tracker.snapshot().triaging, true);
  bus.publish({ type: "event_triaged", title: "t", action: "ignore" });
  assert.equal(tracker.snapshot().triaging, false);
  bus.publish({ type: "session_update", name: "cowork-a", stage: "tests", stagesDone: 2, stagesTotal: 4 });
  bus.publish({ type: "session_question", name: "cowork-a", question: "¿Sigo?" });
  assert.deepEqual(tracker.snapshot().sessions, [{ name: "cowork-a", stage: "tests", stagesDone: 2, stagesTotal: 4, needsInput: true, question: "¿Sigo?" }]);
  bus.publish({ type: "error", message: "x".repeat(600) });
  assert.equal(tracker.snapshot().lastError?.message.length, 500);
  bus.publish({ type: "session_done", name: "cowork-a" });
  assert.equal(tracker.snapshot().sessions[0].needsInput, false);
});

test("nombre y stage de la sesión se acotan a 500", () => {
  const { store, bus, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "o", title: "", url: "" }, 1);
  const longName = "n".repeat(600);
  store.trackSession(longName, p.id);
  bus.publish({ type: "session_update", name: longName, stage: "s".repeat(600), stagesDone: 1, stagesTotal: 2 });
  const session = tracker.snapshot().sessions[0];
  assert.equal(session.name.length, 500);
  assert.equal(session.stage?.length, 500);
});

test("dispose deja de escuchar el bus", () => {
  const { bus, tracker } = setup();
  tracker.dispose();
  bus.publish({ type: "triage_started", title: "t" });
  assert.equal(tracker.snapshot().triaging, false);
});

test("m4: sin datos en vivo, la pregunta pendiente sale del store (reinicio del daemon)", () => {
  const { store, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "o", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  store.updateSession("cowork-a", { lastQuestion: "q".repeat(600), questionMessageId: 7 });
  const [s] = tracker.snapshot().sessions;
  assert.equal(s.needsInput, true);
  assert.equal(s.question, "q".repeat(500));
});

test("m4: los datos en vivo mandan sobre la pregunta guardada", () => {
  const { store, bus, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "o", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  store.updateSession("cowork-a", { lastQuestion: "¿Sigo?", questionMessageId: 7 });
  bus.publish({ type: "session_update", name: "cowork-a", stage: "tests", stagesDone: 2, stagesTotal: 4 });
  const [s] = tracker.snapshot().sessions;
  assert.equal(s.needsInput, false);
  assert.equal(s.question, undefined);
});

test("pending incluye propuestas fallidas recientes con status 'failed'", () => {
  const store = openStore(":memory:");
  const now = () => 100_000;
  const tracker = createStateTracker({ store, bus: createEventBus(now), now });
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "T1", body: "", url: "https://u1", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  store.saveEvent({ source: "clickup", id: "e2", kind: "task_assigned", title: "T2", body: "", url: "https://u2", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 2);
  const p = store.createProposal({ eventId: "e1", repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd", request: "x", origin: "clickup:1", title: "T1", url: "https://u1" }, 10);
  const f = store.createProposal({ eventId: "e2", repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd", request: "x", origin: "clickup:2", title: "T2", url: "https://u2" }, 20);
  const hour24Ms = 24 * 3_600_000;
  store.transition(f.id, "approved", 25);
  store.transition(f.id, "failed", now() - 1000, { error: "test error" });
  const pending = tracker.snapshot().pending;
  assert.equal(pending.length, 2);
  const byId = new Map(pending.map((item) => [item.id, item]));
  assert.equal(byId.get(p.id)?.status, "pending");
  assert.equal(byId.get(f.id)?.status, "failed");
});
