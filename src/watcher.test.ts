import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "./channels/telegram.js";
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
