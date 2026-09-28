import assert from "node:assert/strict";
import test from "node:test";
import { createKitsuneApp, processUpdates, sessionNameFor, type KitsuneApp } from "./app.js";
import { TriageError, type Brain } from "./brain.js";
import type { Channel } from "./channels/telegram.js";
import { createPolicy } from "./policy.js";
import { RoninError, type RoninClient } from "./ronin-client.js";
import { openStore } from "./store.js";
import type { Catalog, InboxEvent, Triage } from "./types.js";

const CATALOG: Catalog = { repos: ["todo-api", "web"], workflows: [{ id: "wf-1", name: "plan-tdd-evidencia", stages: [] }, { id: "wf-2", name: "hotfix", stages: [] }] };
const EVENT: InboxEvent = {
  source: "clickup", id: "task_assigned:t1", kind: "task_assigned", title: "Rechazar títulos vacíos", body: "detalle",
  url: "https://app.clickup.com/t/t1", author: "ana", at: "2026-09-28T10:00:00.000Z",
  meta: { taskId: "t1", listId: "901", listName: "Backlog", tags: [] },
};
const PROPOSE: Triage = { action: "propose_session", repo: "todo-api", workflow: "plan-tdd-evidencia", request: "Valida títulos", reason: "claro" };

function harness(opts: { triage?: Triage | Error; launch?: () => Promise<{ name: string }>; now?: number; channel?: Partial<Channel>; reply?: () => Promise<void> } = {}) {
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
    sendNotice: async (text) => { log.push(`notice:${text}`); return ++msg; },
    sendQuestion: async () => ++msg,
    ackCallback: async (_id, text) => { log.push(`ack:${text ?? ""}`); },
    ...opts.channel,
  };
  const launches: unknown[] = [];
  const ronin: RoninClient = {
    catalog: async () => CATALOG,
    createSession: async (input) => { launches.push(input); return opts.launch ? opts.launch() : { name: "cowork-valida" }; },
    sessionStatus: async () => [],
    replySession: opts.reply ?? (async () => {}),
  };
  const brain: Brain = { triage: async () => { if (opts.triage instanceof Error) throw opts.triage; return opts.triage ?? PROPOSE; } };
  const app = createKitsuneApp({ store, brain, ronin, channel, policy: createPolicy({ chatId: 42 }), now: () => clock, ttlMs: 60_000 });
  return { app, store, log, launches, advance: (ms: number) => { clock += ms; } };
}

const cb = (action: string, proposalId: string, extra: Record<string, unknown> = {}) => ({ type: "callback" as const, callbackId: "cb", chatId: 42, action: action as never, proposalId, ...extra });

test("evento nuevo con propuesta crea proposal pendiente y la envía", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  assert.equal(p.workflowId, "wf-1");
  assert.equal(p.origin, "clickup:t1");
  assert.equal(p.telegramMessageId, 101);
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

test("approve lanza la sesión, la sigue y actualiza el mensaje", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.deepEqual(h.launches, [{ repo: "todo-api", workflowId: "wf-1", request: "Valida títulos", origen: "clickup:t1", name: `cowork-valida-titulos-${p.id.slice(0, 6)}` }]);
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  assert.deepEqual(h.store.listActiveSessions().map((s) => s.name), ["cowork-valida"]);
  assert.ok(h.log.includes("update:launched:✅ Sesión cowork-valida creada"));
});

test("approve dos veces lanza una sola sesión", async () => {
  const h = harness();
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.launches.length, 1);
  assert.ok(h.log.includes("ack:Ya no está vigente"));
});

test("fallo de Ronin deja la propuesta failed y retry la relanza", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-valida" }; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  assert.ok(h.log.some((l) => l.startsWith("update:failed:⚠️ No se pudo lanzar: Ronin no responde")));
  fail = false;
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
});

test("approve tras fallo no relanza; solo retry puede", async () => {
  let fail = true;
  const h = harness({ launch: async () => { if (fail) throw new RoninError("UNREACHABLE", "Ronin no responde"); return { name: "cowork-valida" }; } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
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
    store: h.store, brain: { triage: async () => PROPOSE }, now: () => 1, ttlMs: 1, policy: createPolicy({ chatId: 42 }),
    ronin: { catalog: async () => CATALOG, createSession: async () => ({ name: "x" }), sessionStatus: async () => [], replySession: async (n, t) => { replies.push([n, t]); } },
    channel: { sendNotice: async (t: string) => { h.log.push(`notice:${t}`); return 1; } } as unknown as Channel,
  });
  h.store.saveEvent(EVENT, 1);
  const p = h.store.createProposal({ eventId: EVENT.id, repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia", request: "x", origin: "clickup:t1" }, 1);
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
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.launches.length, 1);
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.launches.length, 1);
});

test("C1: 🔁 con Ronin caído y edición 'message is not modified' deja failed y no lanza", async () => {
  const h = harness({
    launch: async () => { throw new RoninError("UNREACHABLE", "Ronin no responde"); },
    channel: { updateProposal: async () => { throw new Error("Telegram editMessageText: Bad Request: message is not modified"); } },
  });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  await h.app.onChannelEvent(cb("retry", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "failed");
  assert.equal(h.launches.length, 2);
});

test("C1: una edición fallida tras lanzar no cambia el estado ni lanza", async () => {
  const h = harness({ channel: { updateProposal: async () => { throw new Error("Telegram editMessageText: boom"); } } });
  await h.app.onInboxEvent(EVENT);
  const [p] = h.store.listPending();
  await h.app.onChannelEvent(cb("approve", p.id));
  assert.equal(h.store.getProposal(p.id)?.status, "launched");
  assert.deepEqual(h.store.listActiveSessions().map((s) => s.name), ["cowork-valida"]);
});

test("C1: el ack se hace antes de cambiar el estado", async () => {
  let statusAtAck: string | undefined;
  const h = harness();
  const ref: { id?: string } = {};
  (h as any).app = createKitsuneApp({
    store: h.store, brain: { triage: async () => PROPOSE }, now: () => 1, ttlMs: 60_000, policy: createPolicy({ chatId: 42 }),
    ronin: { catalog: async () => CATALOG, createSession: async () => ({ name: "cowork-x" }), sessionStatus: async () => [], replySession: async () => {} },
    channel: {
      sendProposal: async () => 1, updateProposal: async () => {}, sendNotice: async () => 1,
      ackCallback: async () => { statusAtAck = h.store.getProposal(ref.id!)?.status; },
    } as unknown as Channel,
  });
  await h.app.onInboxEvent(EVENT);
  ref.id = h.store.listPending()[0].id;
  await h.app.onChannelEvent(cb("approve", ref.id));
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
  const p = h.store.createProposal({ eventId: EVENT.id, repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia", request: "x", origin: "clickup:t1" }, 1);
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
  await h.app.onChannelEvent(cb("approve", a.id));
  fail = false;
  await h.app.onChannelEvent(cb("retry", a.id));
  await h.app.onChannelEvent(cb("approve", b.id));
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
  await h.app.onChannelEvent(cb("approve", p.id));
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
