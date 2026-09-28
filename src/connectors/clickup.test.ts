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
      [`${API}/list/901/task`]: { tasks: [task("t1", [ME], 2000), task("t2", [99], 3000)] },
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
      [`${API}/list/901/task`]: { tasks: [task("mine", [ME], 2000), task("other", [99], 2000)] },
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
      [`${API}/list/901/task`]: { tasks: [task("mine", [ME], 2000)] },
      [`${API}/task/mine/comment`]: { comments: [{ id: "c9", comment_text: "yo mismo", comment: [], user: { id: ME }, date: "1500" }] },
    }),
  });
  const { events } = await connector.poll(1000);
  assert.deepEqual(events.map((e) => e.id), ["task_assigned:mine"]);
});

test("sin tareas, el cursor se queda igual", async () => {
  const connector = createClickUpConnector({
    token: "pk_test", listIds: ["901"], now: () => 0,
    fetch: fakeFetch({ [`${API}/user`]: { user: { id: ME } }, [`${API}/list/901/task`]: { tasks: [] } }),
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
    fetch: fakeFetch({ [`${API}/user`]: { user: { id: ME } }, [`${API}/list/901/task`]: { tasks: [long] }, [`${API}/task/t1/comment`]: { comments: [] } }),
  });
  const { events } = await connector.poll(0);
  assert.equal(events[0].body.length, 4000);
});
