import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InvalidTransition } from "./proposals.js";
import { openStore } from "./store.js";
import type { InboxEvent } from "./types.js";

const EVENT: InboxEvent = {
  source: "clickup", id: "task_assigned:86abc", kind: "task_assigned", title: "Valida títulos", body: "…",
  url: "https://app.clickup.com/t/86abc", author: "ana", at: "2026-09-28T10:00:00.000Z",
  meta: { taskId: "86abc", listId: "901", listName: "Backlog", tags: [] },
};
const NEW = { eventId: EVENT.id, repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia", request: "valida", origin: "clickup:86abc" };

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
