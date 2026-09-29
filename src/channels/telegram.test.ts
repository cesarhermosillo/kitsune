import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramChannel, encodeCallback, parseUpdate, renderProposal } from "./telegram.js";
import { createTelegramApi, type TelegramApi } from "./telegram-api.js";
import type { InboxEvent, Proposal } from "../types.js";

const P: Proposal = {
  id: "abc123defg", eventId: "task_assigned:t1", repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd-evidencia",
  request: "Valida títulos vacíos", origin: "clickup:t1", title: "Rechazar títulos vacíos", url: "https://app.clickup.com/t/t1",
  status: "pending", telegramMessageId: null,
  createdAt: 1, updatedAt: 1, sessionName: null, error: null,
};
const E: InboxEvent = {
  source: "clickup", id: "task_assigned:t1", kind: "task_assigned", title: "Rechazar títulos vacíos", body: "", url: "https://app.clickup.com/t/t1",
  author: "ana", at: "2026-09-28T10:00:00.000Z", meta: { taskId: "t1", listId: "901", listName: "Backlog", tags: [] },
};

function fakeApi() {
  const sent: Array<{ method: string; args: unknown[] }> = [];
  const api: TelegramApi = {
    getUpdates: async () => [],
    sendMessage: async (...args) => { sent.push({ method: "sendMessage", args }); return { message_id: 100 + sent.length }; },
    editMessageText: async (...args) => { sent.push({ method: "editMessageText", args }); },
    answerCallbackQuery: async (...args) => { sent.push({ method: "answerCallbackQuery", args }); },
  };
  return { api, sent };
}

test("encodeCallback y parseUpdate hacen ida y vuelta", () => {
  assert.equal(encodeCallback("approve", "abc123defg"), "a:abc123defg");
  assert.equal(encodeCallback("set_repo", "abc123defg", 2), "sr:abc123defg:2");
  assert.deepEqual(parseUpdate({ update_id: 1, callback_query: { id: "cb1", data: "sr:abc123defg:2", message: { message_id: 5, chat: { id: 42 } } } }),
    { type: "callback", callbackId: "cb1", chatId: 42, action: "set_repo", proposalId: "abc123defg", index: 2 });
});

test("parseUpdate reconoce mensajes y respuestas", () => {
  assert.deepEqual(parseUpdate({ update_id: 2, message: { message_id: 9, chat: { id: 42 }, text: "sí", reply_to_message: { message_id: 7 } } }),
    { type: "message", chatId: 42, messageId: 9, text: "sí", replyToMessageId: 7 });
  assert.deepEqual(parseUpdate({ update_id: 3, message: { message_id: 10, chat: { id: 42 }, text: "hola" } }),
    { type: "message", chatId: 42, messageId: 10, text: "hola" });
});

test("parseUpdate descarta callbacks desconocidos y mensajes sin texto", () => {
  assert.equal(parseUpdate({ update_id: 4, callback_query: { id: "x", data: "zz:abc", message: { message_id: 1, chat: { id: 42 } } } }), null);
  assert.equal(parseUpdate({ update_id: 5, message: { message_id: 1, chat: { id: 42 } } }), null);
});

test("renderProposal muestra tarea, repo, workflow y petición", () => {
  const text = renderProposal(P, E);
  for (const part of ["Rechazar títulos vacíos", "https://app.clickup.com/t/t1", "todo-api", "plan-tdd-evidencia", "Valida títulos vacíos"]) assert.match(text, new RegExp(part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
});

test("C: renderProposal(p, null) usa el título y la url guardados en la propuesta", () => {
  const text = renderProposal(P, null);
  assert.match(text, /Rechazar títulos vacíos/);
  assert.match(text, /https:\/\/app\.clickup\.com\/t\/t1/);
});

test("C: renderProposal(p, null) cae a origin si la propuesta no tiene título/url (filas viejas)", () => {
  const text = renderProposal({ ...P, title: "", url: "" }, null);
  assert.match(text, /clickup:t1/);
  assert.doesNotMatch(text, /Rechazar títulos vacíos/);
});

test("sendProposal manda los tres botones al chat configurado", async () => {
  const { api, sent } = fakeApi();
  const id = await createTelegramChannel({ api, chatId: 42 }).sendProposal(P, E);
  assert.equal(id, 101);
  const [chatId, , extra] = sent[0].args as [number, string, { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }];
  assert.equal(chatId, 42);
  assert.deepEqual(extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["a:abc123defg", "e:abc123defg", "r:abc123defg"]);
});

test("updateProposal deja 🔁 solo cuando falló", async () => {
  const { api, sent } = fakeApi();
  const channel = createTelegramChannel({ api, chatId: 42 });
  await channel.updateProposal({ ...P, status: "failed", telegramMessageId: 55, error: "boom" }, "⚠️ No se pudo lanzar");
  const failedExtra = sent[0].args[3] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
  assert.deepEqual(failedExtra.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["t:abc123defg"]);
  await channel.updateProposal({ ...P, status: "launched", telegramMessageId: 55 }, "✅ Lanzada");
  assert.deepEqual((sent[1].args[3] as { reply_markup: { inline_keyboard: unknown[] } }).reply_markup.inline_keyboard, []);
});

test("askForRequest y sendQuestion piden respuesta con force_reply", async () => {
  const { api, sent } = fakeApi();
  const channel = createTelegramChannel({ api, chatId: 42 });
  await channel.askForRequest(P);
  await channel.sendQuestion("cowork-a", "¿Sigo con la migración?");
  for (const call of sent) assert.deepEqual((call.args[2] as { reply_markup: unknown }).reply_markup, { force_reply: true });
  assert.match(String(sent[1].args[1]), /cowork-a[\s\S]*¿Sigo con la migración\?/);
});

test("sendQuestion con opciones agrega el menú numerado", async () => {
  const { api, sent } = fakeApi();
  const channel = createTelegramChannel({ api, chatId: 42 });
  await channel.sendQuestion("cowork-a", "¿Cuál repo?", ["Sí", "No"]);
  const text = String(sent[0].args[1]);
  assert.match(text, /1\. Sí/);
  assert.match(text, /2\. No/);
  assert.match(text, /Responde con el número de la opción\./);
  assert.deepEqual((sent[0].args[2] as { reply_markup: unknown }).reply_markup, { force_reply: true });
});

test("sendChoices crea un botón por opción con su índice", async () => {
  const { api, sent } = fakeApi();
  await createTelegramChannel({ api, chatId: 42 }).sendChoices(P, "repo", ["todo-api", "web"]);
  const kb = (sent[0].args[2] as { reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }).reply_markup.inline_keyboard;
  assert.deepEqual(kb.flat().map((b) => [b.text, b.callback_data]), [["todo-api", "sr:abc123defg:0"], ["web", "sr:abc123defg:1"]]);
});

test("telegram-api llama a la Bot API y propaga errores", async () => {
  const calls: string[] = [];
  const api = createTelegramApi({ token: "123:abc", fetch: (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/sendMessage")) {
      assert.equal(body.chat_id, 42);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }
    return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 });
  }) as typeof fetch });
  assert.deepEqual(await api.sendMessage(42, "hola"), { message_id: 7 });
  assert.equal(calls[0], "https://api.telegram.org/bot123:abc/sendMessage");
  await assert.rejects(() => api.answerCallbackQuery("x"), /Bad Request/);
});

test("I5: todo texto saliente se acota a 4000 caracteres con …", async () => {
  const { api, sent } = fakeApi();
  const channel = createTelegramChannel({ api, chatId: 42 });
  await channel.sendNotice("n".repeat(5000));
  await channel.sendProposal({ ...P, request: "q".repeat(5000) }, E);
  await channel.updateProposal({ ...P, request: "q".repeat(5000), telegramMessageId: 9, status: "launched" }, "✅");
  await channel.sendQuestion("cowork-a", "¿".repeat(5000), ["Sí"]);
  await channel.askForRequest({ ...P, request: "q".repeat(5000) });
  for (const call of sent) {
    const text = String(call.method === "editMessageText" ? call.args[2] : call.args[1]);
    assert.equal(text.length, 4000, call.method);
    assert.ok(text.endsWith("…"));
  }
  await channel.sendNotice("corto");
  assert.equal(sent.at(-1)!.args[1], "corto");
});

/** fetch falso que nunca responde hasta que se aborta su señal (o tarda `delayMs` si se da). */
function slowFetch(delayMs = Infinity, body: unknown = {}) {
  return (async (_url: string | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (!signal) { reject(new Error("sin signal")); return; }
    const timer = Number.isFinite(delayMs) ? setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), delayMs) : undefined;
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });
  })) as typeof fetch;
}

test("I7: Telegram colgado se corta; getUpdates espera el long-poll más un margen", async () => {
  const hung = createTelegramApi({ token: "123:abc", fetch: slowFetch(), timeoutMs: 20, longPollGraceMs: 20 });
  await assert.rejects(() => hung.sendMessage(42, "hola"), /Telegram sendMessage/);
  await assert.rejects(() => hung.getUpdates(0, 0), /Telegram getUpdates/);
  const slow = createTelegramApi({ token: "123:abc", fetch: slowFetch(80, { ok: true, result: [] }), timeoutMs: 20, longPollGraceMs: 1000 });
  await assert.rejects(() => slow.answerCallbackQuery("x"), /Telegram answerCallbackQuery/);
  assert.deepEqual(await slow.getUpdates(0, 0), []);
});

test("m3: los errores de telegram-api nunca incluyen el token", async () => {
  const token = "123456:SECRETO-bot";
  const api = createTelegramApi({ token, fetch: (async (url: string | URL) => {
    throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${String(url)}`);
  }) as typeof fetch });
  await assert.rejects(() => api.sendMessage(42, "hola"), (e: unknown) => e instanceof Error && !e.message.includes(token) && /Telegram sendMessage/.test(e.message));
  const echo = createTelegramApi({ token, fetch: (async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized ${token}` }), { status: 401 })) as typeof fetch });
  await assert.rejects(() => echo.getUpdates(0, 0), (e: unknown) => e instanceof Error && !e.message.includes(token));
});
