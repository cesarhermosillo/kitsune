import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "./channels/telegram.js";
import { createEventBus, type KitsuneEvent } from "./events.js";
import type { RoninClient } from "./ronin-client.js";
import { openStore } from "./store.js";
import type { SessionStatus } from "./types.js";
import { createWatcher } from "./watcher.js";

const base: SessionStatus = { name: "cowork-a", workflow: "w", stage: "implementing", stagesDone: 1, stagesTotal: 4, attention: "working", needsInput: false, gate: null };

function setup(statuses: () => SessionStatus[]) {
  const store = openStore(":memory:");
  store.saveEvent({ source: "clickup", id: "e", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "clickup:1", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  const log: string[] = [];
  const receivedOptions: (string[] | undefined)[] = [];
  let msg = 500;
  const channel = {
    sendNotice: async (t: string) => { log.push(`notice:${t}`); return ++msg; },
    sendQuestion: async (s: string, q: string, opts?: string[]) => {
      log.push(`question:${s}:${q}`);
      receivedOptions.push(opts);
      return ++msg;
    },
  } as unknown as Channel;
  const asked: Array<string[] | undefined> = [];
  const ronin = { sessionStatus: async (names?: string[]) => { asked.push(names); return statuses(); } } as unknown as RoninClient;
  return { store, log, asked, receivedOptions, watcher: createWatcher({ store, ronin, channel }) };
}

test("sin cambios no avisa nada y pide solo las sesiones seguidas", async () => {
  const h = setup(() => [base]);
  await h.watcher.tick();
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.asked, [["cowork-a"]]);
});

test("una pregunta nueva se envía una sola vez y guarda el message id", async () => {
  const h = setup(() => [{ ...base, attention: "decision", needsInput: true, question: "¿Sigo?" }]);
  await h.watcher.tick();
  await h.watcher.tick();
  assert.deepEqual(h.log, ["question:cowork-a:¿Sigo?"]);
  assert.equal(h.store.findSessionByQuestion(501)?.name, "cowork-a");
});

test("una pregunta con opciones se envía con las opciones", async () => {
  const h = setup(() => [{ ...base, attention: "decision", needsInput: true, question: "¿Aplico?", options: ["Sí", "No"] }]);
  await h.watcher.tick();
  assert.deepEqual(h.log, ["question:cowork-a:¿Aplico?"]);
  assert.deepEqual(h.receivedOptions, [["Sí", "No"]]);
});

test("gate fallido se avisa una vez", async () => {
  const h = setup(() => [{ ...base, gate: { stage: "tests", attempts: 2 } }]);
  await h.watcher.tick();
  await h.watcher.tick();
  assert.deepEqual(h.log, ["notice:⚠️ El gate de tests falló en cowork-a (2 intentos)"]);
});

test("al terminar avisa y deja de seguir la sesión", async () => {
  const h = setup(() => [{ ...base, stage: null, stagesDone: 4, stagesTotal: 4, attention: "idle" }]);
  await h.watcher.tick();
  assert.deepEqual(h.log, ["notice:✅ cowork-a terminó: 4/4 etapas"]);
  assert.deepEqual(h.store.listActiveSessions(), []);
});

test("sesión desaparecida se avisa y se deja de seguir", async () => {
  const h = setup(() => []);
  await h.watcher.tick();
  assert.deepEqual(h.log, ["notice:🫥 La sesión cowork-a ya no existe"]);
  assert.deepEqual(h.store.listActiveSessions(), []);
});

test("sin sesiones seguidas no llama a Ronin", async () => {
  const h = setup(() => [base]);
  h.store.updateSession("cowork-a", { notifiedDone: true });
  await h.watcher.tick();
  assert.deepEqual(h.asked, []);
});

test("I3: la misma pregunta, tras contestarse, se reenvía si vuelve a aparecer", async () => {
  const asking: SessionStatus = { ...base, attention: "decision", needsInput: true, question: "¿Sigo?" };
  const seq = [asking, base, asking];
  let i = 0;
  const h = setup(() => [seq[Math.min(i++, seq.length - 1)]]);
  await h.watcher.tick();
  await h.watcher.tick();
  const cleared = h.store.listActiveSessions()[0];
  assert.deepEqual([cleared.lastQuestion, cleared.questionMessageId], [null, null]);
  await h.watcher.tick();
  assert.deepEqual(h.log, ["question:cowork-a:¿Sigo?", "question:cowork-a:¿Sigo?"]);
  assert.equal(h.store.findSessionByQuestion(502)?.name, "cowork-a");
});

test("B: shell en un solo tick no avisa", async () => {
  const h = setup(() => [{ ...base, attention: "shell", stage: null, stagesDone: 0, stagesTotal: 4 }]);
  await h.watcher.tick();
  assert.deepEqual(h.log, []);
  assert.notDeepEqual(h.store.listActiveSessions(), []);
});

test("B: shell en dos ticks consecutivos avisa que la sesión se detuvo y deja de seguirla", async () => {
  const h = setup(() => [{ ...base, attention: "shell", stage: null, stagesDone: 0, stagesTotal: 4 }]);
  await h.watcher.tick();
  await h.watcher.tick();
  assert.deepEqual(h.log, ["notice:💤 La sesión cowork-a se detuvo: el agente ya no está activo (etapa sin iniciar, 0/4). Revísala en Ronin."]);
  assert.deepEqual(h.store.listActiveSessions(), []);
});

test("B: gone en dos ticks consecutivos también avisa (con etapa en curso)", async () => {
  const h = setup(() => [{ ...base, attention: "gone", stage: "implementing", stagesDone: 1, stagesTotal: 4 }]);
  await h.watcher.tick();
  await h.watcher.tick();
  assert.deepEqual(h.log, ["notice:💤 La sesión cowork-a se detuvo: el agente ya no está activo (etapa implementing, 1/4). Revísala en Ronin."]);
});

test("B: flujo terminado (stagesDone === stagesTotal) no avisa 'se detuvo' aunque attention sea shell", async () => {
  const h = setup(() => [{ ...base, attention: "shell", stage: null, stagesDone: 4, stagesTotal: 4, needsInput: false }]);
  await h.watcher.tick();
  await h.watcher.tick();
  assert.ok(!h.log.some((l) => l.includes("se detuvo")));
});

test("B: el contador se reinicia si la sesión vuelve a estar activa entre dos ticks en shell", async () => {
  const seq: SessionStatus[] = [
    { ...base, attention: "shell" },
    { ...base, attention: "working" },
    { ...base, attention: "shell" },
    { ...base, attention: "shell" },
  ];
  let i = 0;
  const h = setup(() => [seq[Math.min(i++, seq.length - 1)]]);
  await h.watcher.tick();
  await h.watcher.tick();
  await h.watcher.tick();
  assert.deepEqual(h.log, []);
  await h.watcher.tick();
  assert.deepEqual(h.log, ["notice:💤 La sesión cowork-a se detuvo: el agente ya no está activo (etapa implementing, 1/4). Revísala en Ronin."]);
});

test("I3: sin pregunta previa no escribe en la sesión", async () => {
  const h = setup(() => [base]);
  const writes: unknown[] = [];
  const original = h.store.updateSession;
  h.store.updateSession = (name, patch) => { writes.push(patch); original(name, patch); };
  await h.watcher.tick();
  assert.deepEqual(writes, []);
});

function withBus(seq: SessionStatus[][]) {
  const store = openStore(":memory:");
  store.saveEvent({ source: "clickup", id: "e", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "clickup:1", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  const bus = createEventBus(() => 1);
  const events: KitsuneEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let i = 0;
  const ronin = { sessionStatus: async () => seq[Math.min(i++, seq.length - 1)] } as unknown as RoninClient;
  let msg = 500;
  const channel = { sendNotice: async () => ++msg, sendQuestion: async () => ++msg } as unknown as Channel;
  return { events, watcher: createWatcher({ store, ronin, channel, events: bus }) };
}

test("publica session_update en el primer tick y solo cuando cambia la etapa", async () => {
  const h = withBus([[base], [base], [{ ...base, stage: "tests", stagesDone: 2 }]]);
  await h.watcher.tick(); await h.watcher.tick(); await h.watcher.tick();
  const updates = h.events.filter((e) => e.type === "session_update");
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((e) => (e as Extract<KitsuneEvent, { type: "session_update" }>).stage), ["implementing", "tests"]);
});

test("publica session_question con la pregunta", async () => {
  const h = withBus([[{ ...base, attention: "decision", needsInput: true, question: "¿Sigo?" }]]);
  await h.watcher.tick();
  assert.ok(h.events.some((e) => e.type === "session_question" && e.question === "¿Sigo?"));
});

test("publica session_done al terminar", async () => {
  const h = withBus([[{ ...base, stage: null, stagesDone: 4, stagesTotal: 4, attention: "idle" }]]);
  await h.watcher.tick();
  assert.ok(h.events.some((e) => e.type === "session_done" && e.name === "cowork-a"));
});

test("publica session_dead cuando la sesión desaparece", async () => {
  const h = withBus([[]]);
  await h.watcher.tick();
  assert.ok(h.events.some((e) => e.type === "session_dead" && e.reason === "ya no existe"));
});

test("publica session_dead con reason 'el agente se detuvo' cuando hay stall", async () => {
  const shellState = { ...base, attention: "shell", stage: null, stagesDone: 0, stagesTotal: 4 };
  const h = withBus([[shellState], [shellState]]);
  await h.watcher.tick();
  await h.watcher.tick();
  const deadEvents = h.events.filter((e) => e.type === "session_dead" && e.reason === "el agente se detuvo");
  assert.equal(deadEvents.length, 1);
  assert.equal((deadEvents[0] as Extract<KitsuneEvent, { type: "session_dead" }>).name, "cowork-a");
});

test("publica error cuando falla un gate", async () => {
  const h = withBus([[{ ...base, gate: { stage: "tests", attempts: 2 } }]]);
  await h.watcher.tick();
  const errorEvents = h.events.filter((e) => e.type === "error" && e.message === "Falló el gate de tests en cowork-a");
  assert.equal(errorEvents.length, 1);
});

test("I2: publica session_update cuando needsInput vuelve a false aunque la etapa no cambie", async () => {
  const asking: SessionStatus = { ...base, attention: "decision", needsInput: true, question: "¿Sigo?" };
  const h = withBus([[asking], [base]]);
  await h.watcher.tick();
  const before = h.events.length;
  await h.watcher.tick();
  const after = h.events.slice(before);
  assert.deepEqual(after.map((e) => e.type), ["session_update"]);
  assert.equal((after[0] as Extract<KitsuneEvent, { type: "session_update" }>).stage, "implementing");
});

test("m4: tras reiniciar, una pregunta ya enviada se vuelve a publicar en el bus (no en Telegram) después del session_update", async () => {
  const asking: SessionStatus = { ...base, attention: "decision", needsInput: true, question: "¿Sigo?" };
  const store = openStore(":memory:");
  store.saveEvent({ source: "clickup", id: "e", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "clickup:1", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  store.updateSession("cowork-a", { lastQuestion: "¿Sigo?", questionMessageId: 42 });
  const bus = createEventBus(() => 1);
  const events: KitsuneEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const sent: string[] = [];
  const channel = { sendNotice: async () => 1, sendQuestion: async (_s: string, q: string) => { sent.push(q); return 1; } } as unknown as Channel;
  const ronin = { sessionStatus: async () => [asking] } as unknown as RoninClient;
  const watcher = createWatcher({ store, ronin, channel, events: bus });
  await watcher.tick();
  assert.deepEqual(events.map((e) => e.type), ["session_update", "session_question"]);
  assert.deepEqual(sent, []);
  await watcher.tick();
  assert.equal(events.length, 2);
});
