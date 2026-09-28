import assert from "node:assert/strict";
import test from "node:test";
import { createRoninClient, RoninError } from "./ronin-client.js";

function fake(handler: (body: any, headers: Record<string, string>) => Response | Promise<Response>) {
  return (async (url: string | URL, init?: RequestInit) => {
    assert.equal(String(url), "http://localhost:8787/mcp");
    return handler(JSON.parse(String(init?.body)), init?.headers as Record<string, string>);
  }) as typeof fetch;
}
const ok = (text: string, isError = false) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } }), { status: 200 });

test("catalog llama listar_repos_y_workflows con la capability", async () => {
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: fake((body, headers) => {
    assert.equal(headers["x-ronin-capability"], "cap");
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "listar_repos_y_workflows");
    return ok(JSON.stringify({ repos: ["todo-api"], workflows: [] }));
  }) });
  assert.deepEqual(await client.catalog(), { repos: ["todo-api"], workflows: [] });
});

test("createSession envía origen y devuelve el nombre", async () => {
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: fake((body) => {
    assert.deepEqual(body.params, { name: "crear_sesion", arguments: { repo: "todo-api", workflowId: "wf-1", request: "valida", origen: "clickup:t1" } });
    return ok(JSON.stringify({ name: "cowork-valida" }));
  }) });
  assert.deepEqual(await client.createSession({ repo: "todo-api", workflowId: "wf-1", request: "valida", origen: "clickup:t1" }), { name: "cowork-valida" });
});

test("createSession manda el nombre cuando se da", async () => {
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: fake((body) => {
    assert.equal(body.params.arguments.name, "cowork-valida-abc123");
    return ok(JSON.stringify({ name: "cowork-valida-abc123" }));
  }) });
  assert.deepEqual(await client.createSession({ repo: "todo-api", workflowId: "wf-1", request: "valida", origen: "clickup:t1", name: "cowork-valida-abc123" }), { name: "cowork-valida-abc123" });
});

test("sessionStatus sin nombres no manda names", async () => {
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: fake((body) => {
    assert.deepEqual(body.params.arguments, {});
    return ok("[]");
  }) });
  assert.deepEqual(await client.sessionStatus(), []);
});

test("errores de herramienta llegan como RoninError con su código", async () => {
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: fake(() => ok("SESSION_NOT_WAITING: la sesión no está esperando una respuesta", true)) });
  await assert.rejects(() => client.replySession("cowork-a", "sí"), (e: unknown) => e instanceof RoninError && e.code === "SESSION_NOT_WAITING");
});

test("HTTP 401, error JSON-RPC y red caída", async () => {
  const unauthorized = createRoninClient({ url: "http://localhost:8787", token: "bad", fetch: fake(() => new Response("{}", { status: 401 })) });
  await assert.rejects(() => unauthorized.catalog(), (e: unknown) => e instanceof RoninError && e.code === "HTTP_401");
  const rpc = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: fake(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } }), { status: 200 })) });
  await assert.rejects(() => rpc.catalog(), (e: unknown) => e instanceof RoninError && e.code === "RPC_-32601");
  const down = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(() => down.catalog(), (e: unknown) => e instanceof RoninError && e.code === "UNREACHABLE");
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

test("I7: un Ronin colgado se corta con RoninError TIMEOUT", async () => {
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: slowFetch(), timeoutMs: 20 });
  await assert.rejects(() => client.catalog(), (e: unknown) => e instanceof RoninError && e.code === "TIMEOUT");
});

test("I7: crear_sesion usa su propio timeout, más largo", async () => {
  const reply = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ name: "cowork-a" }) }] } };
  const client = createRoninClient({ url: "http://localhost:8787", token: "cap", fetch: slowFetch(80, reply), timeoutMs: 20, createTimeoutMs: 1000 });
  await assert.rejects(() => client.catalog(), (e: unknown) => e instanceof RoninError && e.code === "TIMEOUT");
  assert.deepEqual(await client.createSession({ repo: "r", workflowId: "w", request: "x", origen: "o" }), { name: "cowork-a" });
});
