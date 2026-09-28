import assert from "node:assert/strict";
import test from "node:test";
import { ClickUpError, createClickUpConnector } from "./clickup.js";

const ME = 7;
function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>).Authorization, "pk_test");
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response("not found", { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const API = "https://api.clickup.com/api/v2";
const task = (id: string, assignees: number[], updated: number) => ({
  id, name: `Tarea ${id}`, description: "Detalle", url: `https://app.clickup.com/t/${id}`,
  date_updated: String(updated), assignees: assignees.map((a) => ({ id: a })), tags: [{ name: "backend" }],
  list: { id: "901", name: "Backlog" }, creator: { username: "ana" },
});

test("emite task_assigned para tareas asignadas a mí y avanza el cursor", async () => {
  const calls: string[] = [];
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({
      [`${API}/user`]: { user: { id: ME, username: "yo" } },
      [`${API}/list/901/task`]: { tasks: [task("t1", [ME], 2000), task("t2", [99], 3000)], last_page: true },
      [`${API}/task/t1/comment`]: { comments: [] },
      [`${API}/task/t2/comment`]: { comments: [] },
    }, calls),
  });
  const { events, nextCursor } = await connector.poll(1000);
  assert.deepEqual(events.map((e) => [e.id, e.kind]), [["task_assigned:t1", "task_assigned"]]);
  assert.equal(events[0].meta.listName, "Backlog");
  assert.deepEqual(events[0].meta.tags, ["backend"]);
  assert.equal(nextCursor, 3000);
  assert.ok(calls.some((u) => u.includes("date_updated_gt=1000")));
});

test("clasifica comentarios: mención, comentario en tarea mía, e ignora el resto", async () => {
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({
      [`${API}/user`]: { user: { id: ME } },
      [`${API}/list/901/task`]: { tasks: [task("mine", [ME], 2000), task("other", [99], 2000)], last_page: true },
      [`${API}/task/mine/comment`]: { comments: [
        { id: "c1", comment_text: "¿puedes revisar?", comment: [{ text: "¿puedes revisar?" }], user: { id: 99, username: "qa" }, date: "1500" },
        { id: "c0", comment_text: "viejo", comment: [], user: { id: 99, username: "qa" }, date: "500" },
      ] },
      [`${API}/task/other/comment`]: { comments: [
        { id: "c2", comment_text: "@yo mira esto", comment: [{ type: "tag", user: { id: ME } }, { text: " mira esto" }], user: { id: 99, username: "qa" }, date: "1600" },
        { id: "c3", comment_text: "nada que ver", comment: [{ text: "nada" }], user: { id: 99, username: "qa" }, date: "1700" },
      ] },
    }),
  });
  const { events } = await connector.poll(1000);
  assert.deepEqual(events.map((e) => [e.id, e.kind, e.author]).sort(), [
    ["comment:mine:c1", "comment", "qa"],
    ["mention:other:c2", "mention", "qa"],
    ["task_assigned:mine", "task_assigned", "ana"],
  ]);
});

test("ignora comentarios propios", async () => {
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({
      [`${API}/user`]: { user: { id: ME } },
      [`${API}/list/901/task`]: { tasks: [task("mine", [ME], 2000)], last_page: true },
      [`${API}/task/mine/comment`]: { comments: [{ id: "c9", comment_text: "yo mismo", comment: [], user: { id: ME }, date: "1500" }] },
    }),
  });
  const { events } = await connector.poll(1000);
  assert.deepEqual(events.map((e) => e.id), ["task_assigned:mine"]);
});

test("sin tareas, el cursor se queda igual", async () => {
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({ [`${API}/user`]: { user: { id: ME } }, [`${API}/list/901/task`]: { tasks: [], last_page: true } }),
  });
  assert.deepEqual(await connector.poll(1234), { events: [], nextCursor: 1234 });
});

test("HTTP no-2xx lanza ClickUpError con el status", async () => {
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({ [`${API}/user`]: new Response("unauthorized", { status: 401 }) }),
  });
  await assert.rejects(() => connector.poll(0), (e: unknown) => e instanceof ClickUpError && e.status === 401);
});

test("acota el cuerpo a 4000 caracteres", async () => {
  const long = { ...task("t1", [ME], 2000), description: "x".repeat(5000) };
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({ [`${API}/user`]: { user: { id: ME } }, [`${API}/list/901/task`]: { tasks: [long], last_page: true }, [`${API}/task/t1/comment`]: { comments: [] } }),
  });
  const { events } = await connector.poll(0);
  assert.equal(events[0].body.length, 4000);
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

test("I7: un ClickUp colgado se corta con ClickUpError status 0", async () => {
  const connector = createClickUpConnector({ token: "pk_test", listIds: ["901"], now: () => 0, fetch: slowFetch(), timeoutMs: 20 });
  await assert.rejects(() => connector.poll(0), (e: unknown) => e instanceof ClickUpError && e.status === 0);
});

test("I8: pagina cada lista hasta last_page o una página vacía, en varias listas", async () => {
  const calls: string[] = [];
  const pages: Record<string, unknown[]> = {
    "901:0": [task("a", [ME], 2000)], "901:1": [task("b", [ME], 5000)],
    "902:0": [task("c", [ME], 3000)], "902:1": [],
  };
  const fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/user")) return Response.json({ user: { id: ME } });
    if (url.pathname.includes("/comment")) return Response.json({ comments: [] });
    const list = url.pathname.split("/")[4];
    const page = url.searchParams.get("page");
    const tasks = pages[`${list}:${page}`] ?? [];
    return Response.json({ tasks, ...(list === "901" ? { last_page: page === "1" } : {}) });
  }) as typeof globalThis.fetch;
  const connector = createClickUpConnector({ token: "pk_test", listIds: ["901", "902"], now: () => 0, fetch });
  const { events, nextCursor } = await connector.poll(1000);
  assert.deepEqual(events.map((e) => e.id), ["task_assigned:a", "task_assigned:b", "task_assigned:c"]);
  assert.equal(nextCursor, 5000);
  const listCalls = calls.filter((c) => c.includes("/task?"));
  assert.deepEqual(listCalls.map((c) => [c.split("/")[4].split("?")[0] ?? "", new URLSearchParams(c.split("?")[1]).get("page")]),
    [["901", "0"], ["901", "1"], ["902", "0"], ["902", "1"]]);
});

test("I8: como máximo 20 páginas por lista y por poll", async () => {
  let listCalls = 0;
  const fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/user")) return Response.json({ user: { id: ME } });
    if (url.pathname.includes("/comment")) return Response.json({ comments: [] });
    listCalls++;
    return Response.json({ tasks: [task(`t${listCalls}`, [99], 2000)], last_page: false });
  }) as typeof globalThis.fetch;
  await createClickUpConnector({ token: "pk_test", listIds: ["901"], now: () => 0, fetch }).poll(0);
  assert.equal(listCalls, 20);
});

test("I8: HTTP 429 sale como ClickUpError(429)", async () => {
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({ [`${API}/user`]: { user: { id: ME } }, [`${API}/list/901/task`]: new Response("rate limited", { status: 429 }) }),
  });
  await assert.rejects(() => connector.poll(0), (e: unknown) => e instanceof ClickUpError && e.status === 429);
});
