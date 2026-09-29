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
  assert.deepEqual(tracker.snapshot().pending, [{ id: p.id, title: "T", url: "https://u", repo: "todo-api", workflow: "plan-tdd", createdAt: 10 }]);
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

test("dispose deja de escuchar el bus", () => {
  const { bus, tracker } = setup();
  tracker.dispose();
  bus.publish({ type: "triage_started", title: "t" });
  assert.equal(tracker.snapshot().triaging, false);
});
