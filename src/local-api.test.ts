import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import type { ActionError, LaunchResult, OptionsResult, RejectResult } from "./app.js";
import { createEventBus } from "./events.js";
import { startLocalApi, type LocalActions } from "./local-api.js";
import type { PetState } from "./state.js";

const TOKEN = "f".repeat(64);
const STATE: PetState = { triaging: false, pending: [], sessions: [], lastError: null };
const ID = "abcdefghij";

async function withApi(
  fn: (base: string, bus: ReturnType<typeof createEventBus>) => Promise<void>,
  heartbeatMs = 15_000,
  actions?: LocalActions,
) {
  const bus = createEventBus(() => 7);
  const api = await startLocalApi({ port: 0, token: TOKEN, allowedOrigins: ["tauri://localhost"], snapshot: () => STATE, bus, heartbeatMs, actions });
  try { await fn(`http://127.0.0.1:${api.port}`, bus); } finally { await api.close(); }
}

/** LocalActions falso que registra cada llamada y responde con los resultados fijados. */
function fakeActions(results: Partial<{ options: OptionsResult; launch: LaunchResult; reject: RejectResult; retry: LaunchResult }> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const actions: LocalActions = {
    options: async (id) => { calls.push({ method: "options", args: [id] }); return results.options ?? { ok: true, title: "t", choices: [] }; },
    launch: async (id, workflowId) => { calls.push({ method: "launch", args: [id, workflowId] }); return results.launch ?? { ok: true, status: "launched", sessionName: "s" }; },
    reject: async (id) => { calls.push({ method: "reject", args: [id] }); return results.reject ?? { ok: true, status: "rejected" }; },
    retry: async (id) => { calls.push({ method: "retry", args: [id] }); return results.retry ?? { ok: true, status: "launched", sessionName: "s" }; },
  };
  return { actions, calls };
}

const AUTH = { "x-kitsune-token": TOKEN, origin: "tauri://localhost" };

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

test("host expone la dirección real vinculada (127.0.0.1)", async () => {
  const bus = createEventBus(() => 7);
  const api = await startLocalApi({ port: 0, token: TOKEN, allowedOrigins: [], snapshot: () => STATE, bus });
  try {
    assert.equal(api.host, "127.0.0.1");
  } finally { await api.close(); }
});

test("origin fuera de la lista blanca en OPTIONS → 403", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-headers": "x-kitsune-token" } });
  assert.equal(r.status, 403);
}));

test("token del largo correcto pero valor incorrecto → 401", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { headers: { "x-kitsune-token": "0".repeat(64) } });
  assert.equal(r.status, 401);
}));

test("401 a un origen permitido conserva access-control-allow-origin", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { headers: { origin: "tauri://localhost" } });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("access-control-allow-origin"), "tauri://localhost");
}));

test("respuesta a origen permitido lleva vary: Origin", () => withApi(async (base) => {
  const r = await fetch(`${base}/state`, { headers: { "x-kitsune-token": TOKEN, origin: "tauri://localhost" } });
  assert.equal(r.headers.get("vary"), "Origin");
}));

test("snapshot que lanza → 500 sin tumbar el servidor", async () => {
  const bus = createEventBus(() => 7);
  let shouldThrow = true;
  const api = await startLocalApi({
    port: 0, token: TOKEN, allowedOrigins: [],
    snapshot: () => {
      if (shouldThrow) throw new Error("boom");
      return STATE;
    },
    bus,
  });
  try {
    const r1 = await fetch(`http://127.0.0.1:${api.port}/state`, { headers: { "x-kitsune-token": TOKEN } });
    assert.equal(r1.status, 500);
    shouldThrow = false;
    const r2 = await fetch(`http://127.0.0.1:${api.port}/state`, { headers: { "x-kitsune-token": TOKEN } });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), STATE);
  } finally { await api.close(); }
});

test("SSE acota cada campo de texto del evento a 500", () => withApi(async (base, bus) => {
  const r = await fetch(`${base}/events`, { headers: { "x-kitsune-token": TOKEN } });
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  bus.publish({ type: "error", message: "x".repeat(600) });
  while (!text.includes("data:")) text += decoder.decode((await reader.read()).value);
  const match = text.match(/data: (\{.*?\})\n\n/);
  assert.ok(match);
  const parsed = JSON.parse(match![1]);
  assert.equal(parsed.message.length, 500);
  await reader.cancel();
}));

test("GET /proposals/:id/options → 200 con choices", async () => {
  const { actions, calls } = fakeActions({ options: { ok: true, title: "Mi propuesta", choices: [] } });
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/options`, { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { title: "Mi propuesta", choices: [] });
    assert.deepEqual(calls, [{ method: "options", args: [ID] }]);
  }, 15_000, actions);
});

test("POST /proposals/:id/launch con JSON → 200 y el falso recibió (id, workflowId)", async () => {
  const { actions, calls } = fakeActions({ launch: { ok: true, status: "launched", sessionName: "cowork-a" } });
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ workflowId: "wf-1" }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "launched", sessionName: "cowork-a" });
    assert.deepEqual(calls, [{ method: "launch", args: [ID, "wf-1"] }]);
  }, 15_000, actions);
});

test("POST /launch sin content-type → 415", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, { method: "POST", headers: AUTH, body: JSON.stringify({ workflowId: "wf-1" }) });
    assert.equal(r.status, 415);
    assert.equal((await r.json()).code, "unsupported_media_type");
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("cuerpo de 5000 bytes → 413", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "x".repeat(5000) }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).code, "payload_too_large");
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("JSON roto → 400 { code: bad_request }", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{not json",
    });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { code: "bad_request", message: "Cuerpo inválido" });
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("workflowId ausente o no-string → 400 { code: bad_request }", async () => {
  const { actions } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, {
      method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ workflowId: 42 }),
    });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { code: "bad_request", message: "Cuerpo inválido" });
  }, 15_000, actions);
});

const ERROR_STATUS: Record<ActionError["code"], number> = {
  not_found: 404, not_pending: 409, expired: 409, unknown_workflow: 400, ronin_unavailable: 503, launch_failed: 502,
};

for (const code of Object.keys(ERROR_STATUS) as Array<ActionError["code"]>) {
  test(`resultado ${code} → ${ERROR_STATUS[code]} con { code, message }`, async () => {
    const error: ActionError = { ok: false, code, message: `mensaje ${code}` };
    const { actions } = fakeActions({ reject: error });
    await withApi(async (base) => {
      const r = await fetch(`${base}/proposals/${ID}/reject`, { method: "POST", headers: AUTH });
      assert.equal(r.status, ERROR_STATUS[code]);
      assert.deepEqual(await r.json(), { code, message: `mensaje ${code}` });
    }, 15_000, actions);
  });
}

test("GET /proposals/:id/launch → 405", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, { headers: AUTH });
    assert.equal(r.status, 405);
    assert.equal((await r.json()).code, "method_not_allowed");
    const r2 = await fetch(`${base}/proposals/${ID}/options`, { method: "POST", headers: AUTH });
    assert.equal(r2.status, 405);
    const body = await r2.json();
    assert.equal(body.code, "method_not_allowed");
    assert.equal(typeof body.message, "string");
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("POST a una acción con Origin ajeno → 403 y el falso no se llamó", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/reject`, { method: "POST", headers: { "x-kitsune-token": TOKEN, origin: "https://evil.example" } });
    assert.equal(r.status, 403);
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("POST a una acción sin token → 401 y el falso no se llamó", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/reject`, { method: "POST", headers: { origin: "tauri://localhost" } });
    assert.equal(r.status, 401);
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("preflight de un origen permitido lista POST y content-type", async () => {
  const { actions } = fakeActions();
  await withApi(async (base) => {
    const r = await fetch(`${base}/proposals/${ID}/launch`, {
      method: "OPTIONS", headers: { origin: "tauri://localhost", "access-control-request-headers": "content-type" },
    });
    assert.equal(r.status, 204);
    assert.match(r.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(r.headers.get("access-control-allow-headers") ?? "", /content-type/);
  }, 15_000, actions);
});

test("sin actions configurado, las rutas de acciones responden 404", () => withApi(async (base) => {
  const r = await fetch(`${base}/proposals/${ID}/options`, { headers: AUTH });
  assert.equal(r.status, 404);
}));

test("id con formato inválido → 404", () => withApi(async (base) => {
  const r = await fetch(`${base}/proposals/../launch`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" } });
  assert.equal(r.status, 404);
}));

test("F8: id de 11 caracteres o con mayúsculas en /launch → 404 y el falso no se llamó", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    for (const bad of ["abcdefghijk", "ABCDEFGHIJ", "abcdeFghij"]) {
      const r = await fetch(`${base}/proposals/${bad}/launch`, {
        method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ workflowId: "wf-1" }),
      });
      assert.equal(r.status, 404, bad);
    }
    assert.equal(calls.length, 0);
  }, 15_000, actions);
});

test("retry y reject no exigen content-type ni cuerpo", async () => {
  const { actions, calls } = fakeActions();
  await withApi(async (base) => {
    const r1 = await fetch(`${base}/proposals/${ID}/reject`, { method: "POST", headers: AUTH });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${base}/proposals/${ID}/retry`, { method: "POST", headers: AUTH });
    assert.equal(r2.status, 200);
    assert.deepEqual(calls.map((c) => c.method), ["reject", "retry"]);
  }, 15_000, actions);
});

test("close() no lanza si se publica justo mientras cierra", async () => {
  const bus = createEventBus(() => 7);
  const api = await startLocalApi({ port: 0, token: TOKEN, allowedOrigins: [], snapshot: () => STATE, bus });
  const r = await fetch(`http://127.0.0.1:${api.port}/events`, { headers: { "x-kitsune-token": TOKEN } });
  const reader = r.body!.getReader();
  await reader.read();
  const closing = api.close();
  assert.doesNotThrow(() => bus.publish({ type: "session_done", name: "x" }));
  await reader.cancel().catch(() => {});
  await closing;
});
