import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { createEventBus } from "./events.js";
import { startLocalApi } from "./local-api.js";
import type { PetState } from "./state.js";

const TOKEN = "f".repeat(64);
const STATE: PetState = { triaging: false, pending: [], sessions: [], lastError: null };

async function withApi(fn: (base: string, bus: ReturnType<typeof createEventBus>) => Promise<void>, heartbeatMs = 15_000) {
  const bus = createEventBus(() => 7);
  const api = await startLocalApi({ port: 0, token: TOKEN, allowedOrigins: ["tauri://localhost"], snapshot: () => STATE, bus, heartbeatMs });
  try { await fn(`http://127.0.0.1:${api.port}`, bus); } finally { await api.close(); }
}

test("sin token o con token incorrecto → 401", () => withApi(async (base) => {
  assert.equal((await fetch(`${base}/state`)).status, 401);
  assert.equal((await fetch(`${base}/state`, { headers: { "x-kitsune-token": "mal" } })).status, 401);
}));

test("origin fuera de la lista blanca → 403 aunque el token sea correcto", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { headers: { "x-kitsune-token": TOKEN, origin: "https://evil.example" } });
  assert.equal(r.status, 403);
}));

test("GET /state con token devuelve la foto; con origen permitido lleva CORS", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { headers: { "x-kitsune-token": TOKEN, origin: "tauri://localhost" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.deepEqual(await r.json(), STATE);
}));

test("preflight OPTIONS de origen permitido → 204 con cabeceras CORS", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { method: "OPTIONS", headers: { origin: "tauri://localhost", "access-control-request-headers": "x-kitsune-token" } });
  assert.equal(r.status, 204);
  assert.match(r.headers.get("access-control-allow-headers") ?? "", /x-kitsune-token/);
}));

test("GET /events entrega eventos del bus y latidos", () => withApi(async (base, bus) => {
  const r = await fetch(`${base}/events`, { headers: { "x-kitsune-token": TOKEN } });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  assert.match(text, /^: ok/);
  bus.publish({ type: "session_done", name: "cowork-a" });
  while (!text.includes("data:")) text += decoder.decode((await reader.read()).value);
  assert.match(text, /data: \{"type":"session_done","name":"cowork-a","at":7\}/);
  while (!text.includes(": hb")) text += decoder.decode((await reader.read()).value);
  await reader.cancel();
}, 30));

test("cerrar el stream desuscribe del bus", () => withApi(async (base, bus) => {
  let listeners = 0;
  const original = bus.subscribe.bind(bus);
  bus.subscribe = (fn) => { listeners++; const off = original(fn); return () => { listeners--; off(); }; };
  const r = await fetch(`${base}/events`, { headers: { "x-kitsune-token": TOKEN } });
  const reader = r.body!.getReader();
  await reader.read();
  assert.equal(listeners, 1);
  await reader.cancel();
  for (let i = 0; i < 50 && listeners > 0; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(listeners, 0);
}));

test("ruta desconocida → 404", () => withApi(async (base) => {
  assert.equal((await fetch(`${base}/nada`, { headers: { "x-kitsune-token": TOKEN } })).status, 404);
}));

test("puerto ocupado rechaza la promesa sin lanzar", async () => {
  const blocker = createServer();
  await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", () => res()));
  const port = (blocker.address() as { port: number }).port;
  try {
    await assert.rejects(() => startLocalApi({ port, token: TOKEN, allowedOrigins: [], snapshot: () => STATE, bus: createEventBus() }), /EADDRINUSE/);
  } finally { blocker.close(); }
});

test("solo escucha en 127.0.0.1", () => withApi(async (base) => {
  assert.match(base, /^http:\/\/127\.0\.0\.1:/);
}));
