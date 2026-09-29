import assert from "node:assert/strict";
import test from "node:test";
import { createKitsuneApp, processUpdates, sessionNameFor, type KitsuneApp } from "./app.js";
import { TriageError, type Brain } from "./brain.js";
import { workflowCheck, type Channel } from "./channels/telegram.js";
import { createEventBus, type EventBus, type KitsuneEvent } from "./events.js";
import { createPolicy } from "./policy.js";
import { RoninError, type RoninClient } from "./ronin-client.js";
import { openStore } from "./store.js";
import type { Catalog, InboxEvent, Triage } from "./types.js";

const CATALOG: Catalog = { repos: ["todo-api", "web"], workflows: [
  { id: "wf-1", name: "plan-tdd-evidencia", stages: [] },
  { id: "wf-2", name: "hotfix", stages: [] },
  { id: "wf-3", name: "pr-review-merge-dev", stages: ["review", "merge"] },
  { id: "wf-4", name: "claude-plan-codex-impl", stages: [] },
] };
const EVENT: InboxEvent = {
  source: "clickup", id: "task_assigned:t1", kind: "task_assigned", title: "Rechazar títulos vacíos", body: "detalle",
  url: "https://app.clickup.com/t/t1", author: "ana", at: "2026-09-28T10:00:00.000Z",
  meta: { taskId: "t1", listId: "901", listName: "Backlog", tags: [] },
};
const PROPOSE: Triage = { action: "propose_session", repo: "todo-api", workflow: "plan-tdd-evidencia", request: "Valida títulos", reason: "claro" };

function harness(opts: { triage?: Triage | Error; launch?: () => Promise<{ name: string }>; now?: number; channel?: Partial<Channel>; reply?: () => Promise<void>; favoriteWorkflows?: string[]; catalog?: () => Catalog; events?: EventBus } = {}) {
  const store = openStore(":memory:");
  const log: string[] = [];
  let clock = opts.now ?? 1_000;
  let msg = 100;
  const channel: Channel = {
    sendProposal: async (p) => { log.push(`proposal:${p.id}`); return ++msg; },
    updateProposal: async (p, note) => { log.push(`update:${p.status}:${note}`); },
    sendEditMenu: async () => { log.push("editmenu"); return ++msg; },
    askForRequest: async () => { log.push("ask"); return ++msg; },
    sendChoices: async (_p, field, options) => { log.push(`choices:${field}:${options.join(",")}`); return ++msg; },
    sendWorkflowChoice: async (_p, title, options, extra) => {
      const labels = options.map((o) => `${o.index}:${o.label}`).join(",");
      log.push(`wfchoice:${title}:${labels}:other=${extra.other ? 1 : 0}:cancel=${extra.cancel ? 1 : 0}`);
      return ++msg;
    },
    editRaw: async (messageId, text) => { log.push(`editraw:${messageId}:${text}`); },
    sendNotice: async (text) => { log.push(`notice:${text}`); return ++msg; },
    sendQuestion: async () => ++msg,
    ackCallback: async (_id, text) => { log.push(`ack:${text ?? ""}`); },
    ...opts.channel,
  };
  const launches: unknown[] = [];
  const ronin: RoninClient = {
    catalog: async () => (opts.catalog ? opts.catalog() : CATALOG),
    createSession: async (input) => { launches.push(input); return opts.launch ? opts.launch() : { name: "cowork-valida" }; },
    sessionStatus: async () => [],
    replySession: opts.reply ?? (async () => {}),
  };
  const brain: Brain = { triage: async () => { if (opts.triage instanceof Error) throw opts.triage; return opts.triage ?? PROPOSE; } };
  const app = createKitsuneApp({
    store, brain, ronin, channel, policy: createPolicy({ chatId: 42 }), now: () => clock, ttlMs: 60_000,
    favoriteWorkflows: opts.favoriteWorkflows ?? [], events: opts.events,
  });
  return { app, store, log, launches, advance: (ms: number) => { clock += ms; } };
}

const cb = (action: string, proposalId: string, extra: Record<string, unknown> = {}) => ({ type: "callback" as const, callbackId: "cb", chatId: 42, messageId: 999, action: action as never, proposalId, ...extra });
// Por defecto, el check corresponde al workflow que hoy vive en ese índice de CATALOG (lo que produciría un selector recién mostrado).
// Los tests que quieren simular un catálogo que cambió de orden pasan `check` explícito.
const launchWith = (proposalId: string, index: number, check = CATALOG.workflows[index] ? workflowCheck(CATALOG.workflows[index].name) : "sin_match") =>
  cb("launch_with", proposalId, { index, check });

test("evento nuevo con propuesta crea proposal pendiente y la envía", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.equal(p.workflowId, "wf-1");
  assert.equal(p.origin, "clickup:t1");
  assert.equal(p.telegramMessageId, 101);
  assert.equal(p.title, EVENT.title);
  assert.equal(p.url, EVENT.url);
  assert.deepEqual(h.log, [`proposal:${p.id}`]);
});

test("evento ya visto se ignora", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  await h.app.onInboxEvent(EVENT);
  assert.equal(h.store.listPending().length, 1);
});

test("notify envía un aviso con el enlace; ignore solo audita", async () => {
  const n = harness({ triage: { action: "notify", summary: "Te mencionaron", reason: "r" } });
  await n.app.onInboxEvent(EVENT);
  assert.match(n.log[0], /^notice:🦊 Te mencionaron[\s\S]*https:\/\/app\.clickup\.com\/t\/t1/);
  const i = harness({ triage: { action: "ignore", reason: "ruido" } });
  await i.app.onInboxEvent(EVENT);
  assert.deepEqual(i.log, []);
});

test("si el motor falla, el evento llega como aviso y nunca se lanza nada", async () => {
  const h = harness({ triage: new TriageError("JSON inválido") });
  await h.app.onInboxEvent(EVENT);
  assert.equal(h.store.listPending().length, 0);
  assert.match(h.log[0], /^notice:⚠️ No pude clasificar/);
});

test("A: approve no lanza; envía el selector con favoritos en orden, ⭐ en el sugerido, ⚠️ en merge/deploy, Otro… y Cancelar", async () => {
  const h = harness({ favoriteWorkflows: ["hotfix", "pr-review-merge-dev"] });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.ok(h.log.includes("ack:Elige el workflow"));
  const entry = h.log.find((l) => l.startsWith("wfchoice:"))!;
  assert.equal(entry, "wfchoice:¿Con qué workflow lanzo «Rechazar títulos vacíos»?:0:⭐ plan-tdd-evidencia,1:hotfix,2:pr-review-merge-dev ⚠️ merge/deploy:other=1:cancel=1");
});

test("A: el sugerido fuera de favoritos va primero; un favorito ausente del catálogo se omite", async () => {
  const h = harness({ favoriteWorkflows: ["workflow-borrado", "hotfix"] });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  const entry = h.log.find((l) => l.startsWith("wfchoice:"))!;
  assert.equal(entry, "wfchoice:¿Con qué workflow lanzo «Rechazar títulos vacíos»?:0:⭐ plan-tdd-evidencia,1:hotfix:other=1:cancel=1");
});

test("A: elegir un workflow del selector (launch_with) lanza una sola vez y queda launched con ese workflow", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 1)); // hotfix
  assert.deepEqual(h.launches, [{ repo: "todo-api", workflowId: "wf-2", request: "Valida títulos", origen: "clickup:t1", name: `cowork-valida-titulos-${p.id.slice(0, 6)}` }]);
  const after = h.store.getProposal(p.id)!;
  assert.deepEqual([after.status, after.workflowId, after.workflowName], ["launched", "wf-2", "hotfix"]);
  assert.deepEqual(h.store.listActiveSessions().map((s) => s.name), ["cowork-valida"]);
  assert.ok(h.log.includes("update:launched:✅ Sesión cowork-valida creada"));
  assert.ok(h.log.includes("editraw:999:🚀 Lanzada con hotfix"));
});

test("A: dos launch_with distintos (doble toque) lanzan una sola sesión; el segundo ack 'Ya no está vigente'", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 1));
  await h.app.onChannelEvent(launchWith(p.id, 2));
  assert.equal(h.launches.length, 1);
  assert.equal(h.store.getProposal(p.id)?.workflowId, "wf-2");
  assert.ok(h.log.includes("ack:Ya no está vigente"));
});

test("A: launch_with con índice fuera de rango responde 'Opción inválida, vuelve a tocar ✅' y no lanza", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 99));
  assert.ok(h.log.includes("ack:Opción inválida, vuelve a tocar ✅"));
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
});

test("A: launch_with cuyo check no coincide con el catálogo re-leído (cambió de orden) responde 'Opción inválida, vuelve a tocar ✅' y no lanza", async () => {
  let current = CATALOG;
  const h = harness({ catalog: () => current });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  // El selector se mostró con el catálogo original: índice 1 = hotfix.
  const checkShown = workflowCheck(CATALOG.workflows[1].name);
  // Antes de procesar el toque, el catálogo de Ronin cambió de orden (p. ej. se agregó un workflow antes).
  current = { repos: CATALOG.repos, workflows: [CATALOG.workflows[0], CATALOG.workflows[2], CATALOG.workflows[1], CATALOG.workflows[3]] };
  await h.app.onChannelEvent(cb("launch_with", p.id, { index: 1, check: checkShown }));
  assert.ok(h.log.includes("ack:Opción inválida, vuelve a tocar ✅"));
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
});

test("A: other_workflows lista todo el catálogo con botones launch_with", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("other_workflows", p.id));
  const entry = h.log.find((l) => l.startsWith("wfchoice:"))!;
  assert.equal(entry, "wfchoice:¿Con qué workflow lanzo «Rechazar títulos vacíos»?:0:⭐ plan-tdd-evidencia,1:hotfix,2:pr-review-merge-dev ⚠️ merge/deploy,3:claude-plan-codex-impl:other=0:cancel=0");
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
});

test("A: cancel_launch ack 'Cancelado' y deja la propuesta pending sin lanzar", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("cancel_launch", p.id));
  assert.ok(h.log.includes("ack:Cancelado"));
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.equal(h.launches.length, 0);
});

test("B: approve con Ronin caído avisa 'Ronin no responde, intenta de nuevo' y deja la propuesta pending sin lanzar", async () => {
  let down = false;
  const h = harness({ catalog: () => { if (down) throw new RoninError("UNREACHABLE", "Ronin no responde"); return CATALOG; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  down = true;
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.ok(h.log.includes("ack:Ronin no responde, intenta de nuevo"));
  assert.ok(!h.log.some((l) => l.startsWith("wfchoice:")));
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.equal(h.launches.length, 0);
});

test("B: other_workflows con Ronin caído avisa 'Ronin no responde, intenta de nuevo' y no lanza", async () => {
  let down = false;
  const h = harness({ catalog: () => { if (down) throw new RoninError("UNREACHABLE", "Ronin no responde"); return CATALOG; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  down = true;
  await h.app.onChannelEvent(cb("other_workflows", p.id));
  assert.ok(h.log.includes("ack:Ronin no responde, intenta de nuevo"));
  assert.ok(!h.log.some((l) => l.startsWith("wfchoice:")));
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
});

test("B: launch_with con Ronin caído avisa 'Ronin no responde, intenta de nuevo' y no lanza ni cambia la propuesta", async () => {
  let down = false;
  const h = harness({ catalog: () => { if (down) throw new RoninError("UNREACHABLE", "Ronin no responde"); return CATALOG; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  down = true;
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.ok(h.log.includes("ack:Ronin no responde, intenta de nuevo"));
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
});

test("A: launch_with de un chat ajeno no hace nada y queda auditado", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent({ ...launchWith(p.id, 0), chatId: 666 });
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.equal(h.store.listAudit(1)[0].action, "unauthorized");
});

test("fallo de Ronin deja la propuesta failed y retry la relanza", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-valida" }; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  assert.ok(h.log.some((l) => l.startsWith("update:failed:⚠️ No se pudo lanzar: Ronin no responde")));
  fail = false;
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
});

test("approve tras fallo no relanza ni reabre el selector; solo retry puede", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-valida" }; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  assert.equal(h.launches.length, 1);
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.launches.length, 1);
  assert.ok(h.log.includes("ack:Ya no está vigente"));
});

test("retry en una propuesta pendiente no lanza nada", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.ok(h.log.includes("ack:Ya no está vigente"));
});

test("reject cierra la propuesta", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("reject", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "rejected");
  assert.equal(h.launches.length, 0);
});

test("callback de un chat ajeno no hace nada y queda auditado", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent({ ...cb("approve", p.id), chatId: 666 });
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.equal(h.store.listAudit(1)[0].action, "unauthorized");
  assert.ok(!h.log.some((l) => l.startsWith("ack:")));
});

test("editar la petición por respuesta y volver a proponer", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("edit", p.id));
  await h.app.onChannelEvent(cb("edit_request", p.id));
  const askId = 103; // proposal=101, editmenu=102, ask=103
  await h.app.onChannelEvent({ type: "message", chatId: 42, messageId: 200, text: "Valida también null", replyToMessageId: askId });
  const updated = h.store.getProposal(p.id)!;
  assert.equal(updated.request, "Valida también null");
  assert.equal(updated.telegramMessageId, 104);
});

test("editar repo y workflow con opciones del catálogo", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("edit_repo", p.id));
  assert.ok(h.log.includes("choices:repo:todo-api,web"));
  await h.app.onChannelEvent(cb("set_repo", p.id, { index: 1 }));
  await h.app.onChannelEvent(cb("edit_workflow", p.id));
  await h.app.onChannelEvent(cb("set_workflow", p.id, { index: 1 }));
  const updated = h.store.getProposal(p.id)!;
  assert.deepEqual([updated.repo, updated.workflowId, updated.workflowName], ["web", "wf-2", "hotfix"]);
});

test("sweepExpired expira propuestas viejas y sus botones dejan de servir", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  h.advance(60_001);
  assert.equal(await h.app.sweepExpired(), 1);
  assert.equal(h.store.getProposal(p.id)?.status, "expired");
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.launches.length, 0);
  assert.ok(h.log.includes("ack:Expirada"));
});

test("respuesta a una pregunta de sesión se reenvía a Ronin", async () => {
  const h = harness();
  const replies: Array<[string, string]> = [];
  (h as any).app = createKitsuneApp({
    store: h.store, brain: { triage: async () => PROPOSE }, now: () => 1, ttlMs: 1, policy: createPolicy({ chatId: 42 }), favoriteWorkflows: [],
    ronin: { catalog: async () => CATALOG, createSession: async () => ({ name: "x" }), sessionStatus: async () => [], replySession: async (n, t) => { replies.push([n, t]); } },
    channel: { sendNotice: async (t: string) => { h.log.push(`notice:${t}`); return 1; } } as unknown as Channel,
  });
  h.store.saveEvent(EVENT, 1);
  const p = h.store.createProposal({ eventId: EVENT.id, repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia", request: "x", origin: "clickup:t1", title: "Rechazar títulos vacíos", url: "https://app.clickup.com/t/t1" }, 1);
  h.store.trackSession("cowork-valida", p.id);
  h.store.updateSession("cowork-valida", { questionMessageId: 300 });
  await h.app.onChannelEvent({ type: "message", chatId: 42, messageId: 301, text: "sí, sigue", replyToMessageId: 300 });
  assert.deepEqual(replies, [["cowork-valida", "sí, sigue"]]);
  assert.ok(h.log.includes("notice:📨 Enviado a cowork-valida"));
});

test("C1: ✅ viejo (ack lanza 'query is too old') igual lanza una sola vez", async () => {
  const h = harness({ channel: { ackCallback: async () => { throw new Error("Telegram answerCallbackQuery: Bad Request: query is too old"); } } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.launches.length, 1);
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  await h.app.onChannelEvent(launchWith(p.id, 1));
  assert.equal(h.launches.length, 1);
});

test("C1: 🔁 con Ronin caído y edición 'message is not modified' deja failed y no lanza", async () => {
  const h = harness({
    launch: async () => { throw new RoninError("UNREACHABLE", "Ronin no responde"); },
    channel: { updateProposal: async () => { throw new Error("Telegram editMessageText: Bad Request: message is not modified"); } },
  });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  assert.equal(h.launches.length, 2);
});

test("C1: una edición fallida tras lanzar no cambia el estado ni lanza", async () => {
  const h = harness({ channel: { updateProposal: async () => { throw new Error("Telegram editMessageText: boom"); } } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  assert.deepEqual(h.store.listActiveSessions().map((s) => s.name), ["cowork-valida"]);
});

test("C1: el ack se hace antes de cambiar el estado", async () => {
  let statusAtAck: string | undefined;
  const h = harness();
  const ref: { id?: string } = {};
  (h as any).app = createKitsuneApp({
    store: h.store, brain: { triage: async () => PROPOSE }, now: () => 1, ttlMs: 60_000, policy: createPolicy({ chatId: 42 }), favoriteWorkflows: [],
    ronin: { catalog: async () => CATALOG, createSession: async () => ({ name: "cowork-x" }), sessionStatus: async () => [], replySession: async () => {} },
    channel: {
      sendProposal: async () => 1, updateProposal: async () => {}, sendNotice: async () => 1, editRaw: async () => {},
      ackCallback: async () => { statusAtAck = h.store.getProposal(ref.id!)?.status; },
    } as unknown as Channel,
  });
  await h.app.onInboxEvent(EVENT);
  ref.id = h.store.listPending()[0].id;
  await h.app.onChannelEvent({ type: "callback", callbackId: "cb", chatId: 42, messageId: 999, action: "launch_with", proposalId: ref.id, index: 0, check: workflowCheck(CATALOG.workflows[0].name) } as never);
  assert.equal(statusAtAck, "pending");
});

test("C1: al arrancar, las propuestas en approved pasan a failed (interrumpida) con 🔁", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  h.store.transition(p.id, "approved", 2);
  assert.equal(await h.app.recoverInterrupted(), 1);
  const after = h.store.getProposal(p.id)!;
  assert.equal(after.status, "failed");
  assert.equal(after.error, "interrumpida");
  assert.ok(h.log.some((l) => l.startsWith("update:failed:")));
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
});

test("C1: un mensaje de un chat ajeno se ignora y se audita", async () => {
  const h = harness();
  await h.app.onChannelEvent({ type: "message", chatId: 666, messageId: 1, text: "hola" });
  assert.deepEqual(h.log, []);
  const [row] = h.store.listAudit(1);
  assert.deepEqual([row.action, row.target, row.detail], ["unauthorized", "666", { type: "message" }]);
});

test("C1: si responder a la sesión falla se envía el aviso ⚠️", async () => {
  const h = harness({ reply: async () => { throw new RoninError("SESSION_NOT_WAITING", "la sesión no está esperando una respuesta"); } });
  h.store.saveEvent(EVENT, 1);
  const p = h.store.createProposal({ eventId: EVENT.id, repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia", request: "x", origin: "clickup:t1", title: "Rechazar títulos vacíos", url: "https://app.clickup.com/t/t1" }, 1);
  h.store.trackSession("cowork-valida", p.id);
  h.store.updateSession("cowork-valida", { questionMessageId: 300 });
  await h.app.onChannelEvent({ type: "message", chatId: 42, messageId: 301, text: "sí", replyToMessageId: 300 });
  assert.ok(h.log.includes("notice:⚠️ No pude responder a cowork-valida: la sesión no está esperando una respuesta"));
});

test("C1: processUpdates avanza el offset aunque un update falle y lo audita", async () => {
  const store = openStore(":memory:");
  const handled: number[] = [];
  const app = {
    onChannelEvent: async (e: { messageId?: number }) => { if (e.messageId === 1) throw new Error("boom"); handled.push(e.messageId!); },
  } as unknown as KitsuneApp;
  const lines: string[] = [];
  const msg = (id: number) => ({ update_id: 10 + id, message: { message_id: id, chat: { id: 42 }, text: "x" } });
  await processUpdates([msg(1), msg(2)], { app, store, log: (l) => lines.push(l), now: () => 5 });
  assert.equal(store.getCursor("telegram"), "13");
  assert.deepEqual(handled, [2]);
  const audit = store.listAudit(10).find((a) => a.action === "update_failed");
  assert.deepEqual([audit?.actor, audit?.target, audit?.detail], ["kitsune", "11", { error: "boom" }]);
  assert.ok(lines.some((l) => l.includes("boom")));
});

test("I2: sessionNameFor es determinista, válido para Ronin y ≤ 60", () => {
  const base = { id: "abc123defg", request: "Valida los títulos VACÍOS en la API de tareas, por favor ahora" } as never;
  assert.equal(sessionNameFor(base), "cowork-valida-los-titulos-vacios-en-la-abc123");
  const long = sessionNameFor({ id: "zzz999qqqq", request: "Supercalifragilisticoespialidoso ".repeat(10) } as never);
  assert.ok(long.length <= 60, long);
  assert.match(long, /^cowork-[a-z0-9-]+-zzz999$/);
  assert.doesNotMatch(long, /--/);
  assert.equal(sessionNameFor({ id: "abc123defg", request: "¿¡ !!" } as never), "cowork-tarea-abc123");
  for (const n of [long, sessionNameFor(base)]) assert.match(n, /^cowork-[A-Za-z0-9._@-]{1,73}$/);
});

test("I2: dos tareas que empiezan igual reciben nombres distintos; el reintento usa el mismo", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-x" }; } });
  await h.app.onInboxEvent(EVENT);
  await h.app.onInboxEvent({ ...EVENT, id: "task_assigned:t2" });
  const [a, b] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(a.id, 0));
  fail = false;
  await h.app.onChannelEvent(cb("retry", a.id));
  await h.app.onChannelEvent(launchWith(b.id, 0));
  const names = (h.launches as Array<{ name: string }>).map((l) => l.name);
  assert.equal(names[0], names[1]);
  assert.notEqual(names[0], names[2]);
});

test("I2: reintento con SESSION_ALREADY_EXISTS para ese nombre se toma como lanzada y se sigue", async () => {
  let attempt = 0;
  const h = harness({ launch: async () => {
    attempt++;
    if (attempt === 1) throw new RoninError("TIMEOUT", "Ronin no respondió a tiempo");
    throw new RoninError("SESSION_ALREADY_EXISTS", "ya existe una sesión tmux con ese nombre");
  } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  await h.app.onChannelEvent(cb("retry", p.id));
  const after = h.store.getProposal(p.id)!;
  const expected = sessionNameFor(p);
  assert.equal(after.status, "launched");
  assert.equal(after.sessionName, expected);
  assert.deepEqual(h.store.listActiveSessions().map((s) => s.name), [expected]);
});

test("I4: si enviar la propuesta falla no lanza, queda sin message id y redeliver la reenvía", async () => {
  let down = true;
  const h = harness({ channel: { sendProposal: async (p) => { if (down) throw new Error("Telegram sendMessage: fetch failed"); h.log.push(`proposal:${p.id}`); return 777; } } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.equal(p.telegramMessageId, null);
  assert.deepEqual(h.store.listUndelivered().map((x) => x.id), [p.id]);
  assert.equal(await h.app.redeliver(), 0);
  down = false;
  assert.equal(await h.app.redeliver(), 1);
  assert.equal(h.store.getProposal(p.id)?.telegramMessageId, 777);
  assert.deepEqual(h.store.listUndelivered(), []);
  assert.equal(await h.app.redeliver(), 0);
});

test("I4: redeliver ignora propuestas que ya no están pendientes", async () => {
  const h = harness({ channel: { sendProposal: async () => { throw new Error("caído"); } } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  h.store.transition(p.id, "rejected", 2);
  assert.deepEqual(h.store.listUndelivered(), []);
});

test("I4: un aviso que falla no lanza fuera de onInboxEvent (best-effort)", async () => {
  const h = harness({ triage: { action: "notify", summary: "hola", reason: "r" }, channel: { sendNotice: async () => { throw new Error("caído"); } } });
  await h.app.onInboxEvent(EVENT);
  assert.equal(h.store.hasEvent(EVENT.id), true);
});

test("I5: la petición editada por el usuario se acota igual que la del motor", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("edit_request", p.id));
  await h.app.onChannelEvent({ type: "message", chatId: 42, messageId: 200, text: "€".repeat(5000), replyToMessageId: 102 });
  const request = h.store.getProposal(p.id)!.request;
  assert.ok(request.length <= 3500 && Buffer.byteLength(request, "utf8") <= 8000);
});

function captured() {
  const bus = createEventBus(() => 1);
  const events: KitsuneEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { bus, events, types: () => events.map((e) => e.type) };
}

test("un evento con propuesta publica triage_started, event_triaged y proposal_created", async () => {
  const c = captured();
  const h = harness({ events: c.bus });
  await h.app.onInboxEvent(EVENT);
  assert.deepEqual(c.types(), ["triage_started", "event_triaged", "proposal_created"]);
  const created = c.events[2] as Extract<KitsuneEvent, { type: "proposal_created" }>;
  assert.equal(created.title, EVENT.title);
  assert.equal(created.repo, "todo-api");
});

test("fallo de clasificación publica event_triaged failed y error", async () => {
  const c = captured();
  const h = harness({ events: c.bus, triage: new TriageError("JSON inválido") });
  await h.app.onInboxEvent(EVENT);
  assert.deepEqual(c.types(), ["triage_started", "event_triaged", "error"]);
  assert.equal((c.events[1] as Extract<KitsuneEvent, { type: "event_triaged" }>).action, "failed");
});

test("proposal_resolved launched incluye el sessionName del fake de Ronin", async () => {
  const c = captured();
  const h = harness({ events: c.bus });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  const resolved = c.events.filter((e) => e.type === "proposal_resolved") as Extract<KitsuneEvent, { type: "proposal_resolved" }>[];
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "launched");
  assert.equal(resolved[0].sessionName, "cowork-valida");
});

test("proposal_resolved failed cuando Ronin no puede lanzar, con su evento error", async () => {
  const c = captured();
  const h = harness({ events: c.bus, launch: async () => { throw new RoninError("UNREACHABLE", "Ronin no responde"); } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 0));
  const resolved = c.events.filter((e) => e.type === "proposal_resolved") as Extract<KitsuneEvent, { type: "proposal_resolved" }>[];
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "failed");
  const err = c.events.find((e) => e.type === "error") as Extract<KitsuneEvent, { type: "error" }> | undefined;
  assert.ok(err?.message.startsWith("No se pudo lanzar"));
});

test("proposal_resolved rejected al rechazar la propuesta", async () => {
  const c = captured();
  const h = harness({ events: c.bus });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("reject", p.id));
  const resolved = c.events.filter((e) => e.type === "proposal_resolved") as Extract<KitsuneEvent, { type: "proposal_resolved" }>[];
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "rejected");
});

test("proposal_resolved expired al expirar la propuesta", async () => {
  const c = captured();
  const h = harness({ events: c.bus });
  await h.app.onInboxEvent(EVENT);
  h.advance(60_001);
  await h.app.sweepExpired();
  const resolved = c.events.filter((e) => e.type === "proposal_resolved") as Extract<KitsuneEvent, { type: "proposal_resolved" }>[];
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "expired");
});

// ── Acciones compartidas (mascota + Telegram) ──

const DANGER_CATALOG: Catalog = { repos: CATALOG.repos, workflows: [
  { id: "wf-1", name: "plan-tdd-evidencia", stages: [] },
  { id: "wf-2", name: "hotfix", stages: ["build", "merge"] },
  { id: "wf-3", name: "pr-review-merge-dev", stages: ["review", "merge"] },
  { id: "wf-4", name: "claude-plan-codex-impl", stages: [] },
] };

test("workflowOptions: sugerido y favoritos en main, resto en other, con dangerous", async () => {
  const h = harness({ favoriteWorkflows: ["hotfix"], catalog: () => DANGER_CATALOG });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  const r = await h.app.workflowOptions(p.id);
  assert.deepEqual(r, { ok: true, title: "Rechazar títulos vacíos", choices: [
    { id: "wf-1", name: "plan-tdd-evidencia", suggested: true, favorite: false, dangerous: false, group: "main" },
    { id: "wf-2", name: "hotfix", suggested: false, favorite: true, dangerous: true, group: "main" },
    { id: "wf-3", name: "pr-review-merge-dev", suggested: false, favorite: false, dangerous: true, group: "other" },
    { id: "wf-4", name: "claude-plan-codex-impl", suggested: false, favorite: false, dangerous: false, group: "other" },
  ] });
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.equal(h.launches.length, 0);
});

test("workflowOptions: el sugerido favorito va en la posición de favoritos; sin title usa origin; Ronin caído → ronin_unavailable", async () => {
  let down = false;
  const h = harness({ favoriteWorkflows: ["hotfix", "plan-tdd-evidencia", "borrado"], catalog: () => { if (down) throw new RoninError("UNREACHABLE", "Ronin no responde"); return CATALOG; } });
  await h.app.onInboxEvent({ ...EVENT, title: "" });
  const [p] = h.store.listPending();
  const r = await h.app.workflowOptions(p.id);
  assert.ok(r.ok);
  assert.equal(r.title, "clickup:t1");
  assert.deepEqual(r.choices.filter((c) => c.group === "main").map((c) => [c.name, c.suggested, c.favorite]),
    [["hotfix", false, true], ["plan-tdd-evidencia", true, true]]);
  assert.deepEqual(r.choices.filter((c) => c.group === "other").map((c) => c.name), ["pr-review-merge-dev", "claude-plan-codex-impl"]);
  down = true;
  assert.deepEqual(await h.app.workflowOptions(p.id), { ok: false, code: "ronin_unavailable", message: "Ronin no responde, intenta de nuevo" });
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
});

test("launchProposal por id lanza una vez y deja la propuesta launched", async () => {
  const c = captured();
  const h = harness({ events: c.bus });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  const r = await h.app.launchProposal(p.id, "wf-2", "pet");
  assert.deepEqual(r, { ok: true, status: "launched", sessionName: "cowork-valida" });
  assert.equal(h.launches.length, 1);
  assert.equal((h.launches[0] as { workflowId: string }).workflowId, "wf-2");
  const after = h.store.getProposal(p.id)!;
  assert.deepEqual([after.status, after.workflowId, after.workflowName, after.sessionName], ["launched", "wf-2", "hotfix", "cowork-valida"]);
  assert.ok(h.log.includes("update:launched:✅ Sesión cowork-valida creada"));
  const resolved = c.events.filter((e) => e.type === "proposal_resolved") as Extract<KitsuneEvent, { type: "proposal_resolved" }>[];
  assert.deepEqual(resolved.map((e) => e.status), ["launched"]);
});

test("launchProposal con workflowId inexistente → unknown_workflow y la propuesta sigue pending", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-borrado", "pet"), { ok: false, code: "unknown_workflow", message: "Ese workflow ya no existe en Ronin" });
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.equal(h.launches.length, 0);
});

test("launchProposal con Ronin caído en catalog → ronin_unavailable y sigue pending", async () => {
  let down = false;
  const h = harness({ catalog: () => { if (down) throw new RoninError("UNREACHABLE", "Ronin no responde"); return CATALOG; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  down = true;
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-1", "pet"), { ok: false, code: "ronin_unavailable", message: "Ronin no responde, intenta de nuevo" });
  const after = h.store.getProposal(p.id)!;
  assert.deepEqual([after.status, after.workflowId], ["pending", "wf-1"]);
  assert.equal(h.launches.length, 0);
});

test("launchProposal cuando createSession falla → launch_failed y la propuesta queda failed", async () => {
  const h = harness({ launch: async () => { throw new RoninError("UNREACHABLE", "Ronin no responde"); } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-1", "pet"), { ok: false, code: "launch_failed", message: "Ronin no responde" });
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  assert.equal(h.launches.length, 1);
  assert.ok(h.log.some((l) => l.startsWith("update:failed:⚠️ No se pudo lanzar: Ronin no responde")));
});

test("doble lanzamiento entre canales: API y luego ✅ de Telegram → una sola sesión", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.equal((await h.app.launchProposal(p.id, "wf-1", "pet")).ok, true);
  await h.app.onChannelEvent(launchWith(p.id, 1));
  assert.equal(h.launches.length, 1);
  assert.ok(h.log.includes("ack:Ya no está vigente"));
  assert.equal(h.store.getProposal(p.id)?.workflowId, "wf-1");
  // La API otra vez tampoco lanza.
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-1", "pet"), { ok: false, code: "not_pending", message: "Ya no está vigente" });
  assert.equal(h.launches.length, 1);
});

test("doble lanzamiento entre canales: ✅ de Telegram y luego API → not_pending", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(launchWith(p.id, 1));
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-1", "pet"), { ok: false, code: "not_pending", message: "Ya no está vigente" });
  assert.equal(h.launches.length, 1);
  assert.equal(h.store.getProposal(p.id)?.workflowId, "wf-2");
});

test("doble lanzamiento concurrente (API y Telegram a la vez, mientras se lee el catálogo) → una sola sesión", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  const [api, api2] = await Promise.all([
    h.app.launchProposal(p.id, "wf-1", "pet"),
    h.app.launchProposal(p.id, "wf-2", "pet"),
    h.app.onChannelEvent(launchWith(p.id, 1)),
  ]);
  assert.equal(h.launches.length, 1);
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  assert.deepEqual([api.ok, api2.ok], [true, false]);
  assert.deepEqual(api2, { ok: false, code: "not_pending", message: "Ya no está vigente" });
});

test("rejectProposal ignora, edita Telegram y emite proposal_resolved rejected; segunda vez → not_pending", async () => {
  const c = captured();
  const h = harness({ events: c.bus });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.deepEqual(await h.app.rejectProposal(p.id, "pet"), { ok: true, status: "rejected" });
  assert.equal(h.store.getProposal(p.id)?.status, "rejected");
  assert.ok(h.log.includes("update:rejected:❌ Ignorada"));
  const resolved = c.events.filter((e) => e.type === "proposal_resolved") as Extract<KitsuneEvent, { type: "proposal_resolved" }>[];
  assert.deepEqual(resolved.map((e) => e.status), ["rejected"]);
  assert.deepEqual(await h.app.rejectProposal(p.id, "pet"), { ok: false, code: "not_pending", message: "Ya no está vigente" });
  assert.equal(c.events.filter((e) => e.type === "proposal_resolved").length, 1);
  // Y el ✅ de Telegram ya no lanza.
  await h.app.onChannelEvent(launchWith(p.id, 0));
  assert.equal(h.launches.length, 0);
});

test("retryProposal solo desde failed; desde pending → not_pending", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-valida" }; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.deepEqual(await h.app.retryProposal(p.id, "pet"), { ok: false, code: "not_pending", message: "Ya no está vigente" });
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "pending");
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-1", "pet"), { ok: false, code: "launch_failed", message: "Ronin no responde" });
  assert.equal(h.launches.length, 1);
  // Reintento que vuelve a fallar → launch_failed y sigue failed.
  assert.deepEqual(await h.app.retryProposal(p.id, "pet"), { ok: false, code: "launch_failed", message: "Ronin no responde" });
  assert.equal(h.launches.length, 2);
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  fail = false;
  assert.deepEqual(await h.app.retryProposal(p.id, "pet"), { ok: true, status: "launched", sessionName: "cowork-valida" });
  assert.equal(h.launches.length, 3);
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  // Ya lanzada: ni retry ni el 🔁 de Telegram vuelven a lanzar.
  assert.deepEqual(await h.app.retryProposal(p.id, "pet"), { ok: false, code: "not_pending", message: "Ya no está vigente" });
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.launches.length, 3);
});

test("propuesta inexistente → not_found; expirada → expired", async () => {
  const h = harness();
  const notFound = { ok: false, code: "not_found", message: "La propuesta no existe" };
  assert.deepEqual(await h.app.workflowOptions("nope"), notFound);
  assert.deepEqual(await h.app.launchProposal("nope", "wf-1", "pet"), notFound);
  assert.deepEqual(await h.app.rejectProposal("nope", "pet"), notFound);
  assert.deepEqual(await h.app.retryProposal("nope", "pet"), notFound);
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  h.advance(60_001);
  await h.app.sweepExpired();
  const expired = { ok: false, code: "expired", message: "Expirada" };
  assert.deepEqual(await h.app.workflowOptions(p.id), expired);
  assert.deepEqual(await h.app.launchProposal(p.id, "wf-1", "pet"), expired);
  assert.deepEqual(await h.app.rejectProposal(p.id, "pet"), expired);
  assert.deepEqual(await h.app.retryProposal(p.id, "pet"), expired);
  assert.equal(h.launches.length, 0);
  assert.equal(h.store.getProposal(p.id)?.status, "expired");
});

test("audita via pet/telegram", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-valida" }; } });
  await h.app.onInboxEvent(EVENT);
  await h.app.onInboxEvent({ ...EVENT, id: "task_assigned:t2" });
  await h.app.onInboxEvent({ ...EVENT, id: "task_assigned:t3" });
  await h.app.onInboxEvent({ ...EVENT, id: "task_assigned:t4" });
  const [a, b, c, d] = h.store.listPending();
  const userAudit = () => h.store.listAudit(100).filter((x) => x.actor === "user" && ["launch", "reject", "retry"].includes(x.action) && (x.detail as { via?: string }).via !== undefined)
    .map((x) => [x.action, x.target, x.detail]);
  await h.app.launchProposal(a.id, "wf-2", "pet");
  await h.app.onChannelEvent(launchWith(b.id, 0));
  fail = false;
  await h.app.retryProposal(a.id, "pet");
  await h.app.onChannelEvent(cb("retry", b.id));
  await h.app.rejectProposal(c.id, "pet");
  await h.app.onChannelEvent(cb("reject", d.id));
  const rows = userAudit();
  const expected = [
    ["launch", a.id, { via: "pet", workflow: "hotfix" }],
    ["launch", b.id, { via: "telegram", workflow: "plan-tdd-evidencia" }],
    ["retry", a.id, { via: "pet" }],
    ["retry", b.id, { via: "telegram" }],
    ["reject", c.id, { via: "pet" }],
    ["reject", d.id, { via: "telegram" }],
  ];
  for (const row of expected) assert.ok(rows.some((r) => JSON.stringify(r) === JSON.stringify(row)), `falta ${JSON.stringify(row)} en ${JSON.stringify(rows)}`);
  assert.equal(rows.length, expected.length);
  // Una acción rechazada (no vigente) no se audita como acción hecha.
  await h.app.rejectProposal(c.id, "pet");
  assert.equal(userAudit().length, expected.length);
});
