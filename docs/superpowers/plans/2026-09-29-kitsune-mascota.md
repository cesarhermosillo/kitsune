# Kitsune — Mascota de escritorio (Fase 2a): plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un zorro kitsune en pixel art, animado, siempre al frente en el escritorio, que refleja en tiempo real lo que pasa en Kitsune y en las sesiones de Ronin, alimentado por una API local nueva del daemon.

**Architecture:** Dos partes. **(A) Daemon:** un `EventBus` interno al que publican `app.ts` y `watcher.ts`, un `StateTracker` que arma una foto del estado y un servidor HTTP local (`127.0.0.1:47823`, con token y lista blanca de `Origin`) con `GET /state` y `GET /events` (SSE). **(B) Mascota:** una app Tauri 2 en `pet/`. Los sprites se dibujan como matrices de caracteres y un script los convierte en una hoja PNG. La lógica de estado es pura y se prueba con vitest. El renderizado va en Canvas 2D. El Rust se reduce a la ventana, el menú de la barra superior, el token y el paso de clics por las zonas transparentes.

**Tech Stack:** Daemon: Node ≥ 22.13, TypeScript ESM, `node:http`, `node --test`. Mascota: Tauri 2 (Rust 1.95), Vite 6, TypeScript, Canvas 2D, vitest 3, `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-29-kitsune-mascota-design.md`

## Global Constraints

- La API local escucha **solo** en `127.0.0.1`. Puerto por defecto `47823`, configurable con `localApi.port`. Se puede apagar con `localApi.enabled: false`.
- Token en `~/.kitsune/pet-token`: 32 bytes aleatorios en hex, permisos `0600`, cabecera `x-kitsune-token` y comparación en tiempo constante.
- `Origin`: lista blanca = `tauri://localhost` más `localApi.devOrigins` (por defecto `[]`). Un `Origin` fuera de la lista recibe 403. Sin `Origin` solo se exige el token. Preflight `OPTIONS` de un origen permitido → 204 con cabeceras CORS.
- La API es de solo lectura en 2a. Nunca expone secretos, rutas de configuración ni el contenido crudo de ClickUp. Los textos se acotan a 500 caracteres.
- Si la API falla, por ejemplo porque el puerto está ocupado, **no** tumba el daemon: se registra y Telegram sigue funcionando.
- Latido SSE cada 15 s.
- Sprites de 32×32. Paleta de 16 colores como máximo, con `.` = transparente. Se dibujan a 2×, 3× o 4× (4× por defecto) con escalado nearest-neighbor.
- Animaciones requeridas y cuadros mínimos: `sleeping` 4, `idle` 6, `sniffing` 6, `alert` 6, `working` 6, `asking` 4, `celebrate` 8 (sin bucle), `sad` 4. `offline` = cuadros de `idle` en gris al 50% de opacidad.
- Prioridad de estado: `offline` > `asking` > `alert` > `sad` > `working` > `sniffing` > `idle` > `sleeping`. `celebrate` se superpone 3 s.
- Burbujas: se ocultan a los 6 s, salvo `asking`. Pregunta acotada a 140 caracteres.
- Reconexión de la mascota: cada 5 s durante el primer minuto sin conexión, luego cada 30 s. Al reconectar pide `/state` completo.
- Mensajes al usuario en español. Commits: asunto convencional, línea en blanco y exactamente `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Nunca `git stash`. No hacer push.
- En esta máquina corre un daemon real de Kitsune (PID en `~/.kitsune/kitsune.pid`) y un Ronin de prueba en `:8797`. Las pruebas automáticas no los tocan ni tocan `~/.kitsune`. Solo el controlador hace la integración manual del Task B6.

## Review Focus

- **Una página web intenta leer `/state`**: el navegador envía `Origin: https://evil.example` → 403 antes de mirar el token. Prueba: Task A3, `origin fuera de la lista blanca → 403`.
- **Puerto ocupado** (otra instancia de Kitsune o de la mascota): el daemon sigue arrancando y solo lo registra. Prueba: Task A3, `puerto ocupado rechaza la promesa sin lanzar`, más el manejo en `cli.ts`.
- **El daemon se reinicia mientras la mascota está abierta**: la mascota pasa a `offline`, se reconecta y pide `/state`. No depende de eventos que se perdió. Prueba: Task B3, `reconecta y pide /state tras perder el stream`.
- **Suscriptor SSE que se desconecta**: se da de baja del bus y no queda un intervalo de latido vivo. Prueba: Task A3, `cerrar el stream desuscribe`.
- **Muchas sesiones o textos largos**: los textos se acotan (500 en la API, 140 en la burbuja) y la burbuja no rompe la ventana. Pruebas: Task A3 (acotado en `/state`) y Task B3 (`burbuja de pregunta acotada a 140`).

---

## Parte A: API local del daemon

### Task A1: EventBus, configuración `localApi` y token de la mascota

**Files:**
- Create: `src/events.ts`, `src/pet-token.ts`
- Modify: `src/config.ts` (interfaz `KitsuneConfig` y `loadConfig`)
- Test: `src/events.test.ts`, `src/pet-token.test.ts`, `src/config.test.ts`

**Interfaces:**
- Produces:

```ts
// src/events.ts
export type TriageOutcome = "propose_session" | "notify" | "ignore" | "failed";
export type KitsuneEvent =
  | { type: "triage_started"; at: number; title: string }
  | { type: "event_triaged"; at: number; title: string; action: TriageOutcome }
  | { type: "proposal_created"; at: number; id: string; title: string; url: string; repo: string; workflow: string }
  | { type: "proposal_resolved"; at: number; id: string; status: "launched" | "failed" | "rejected" | "expired"; sessionName?: string }
  | { type: "session_update"; at: number; name: string; stage: string | null; stagesDone: number; stagesTotal: number }
  | { type: "session_question"; at: number; name: string; question: string }
  | { type: "session_done"; at: number; name: string }
  | { type: "session_dead"; at: number; name: string; reason: string }
  | { type: "error"; at: number; message: string };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type KitsuneEventInput = DistributiveOmit<KitsuneEvent, "at">;
export interface EventBus { publish(event: KitsuneEventInput): void; subscribe(listener: (event: KitsuneEvent) => void): () => void }
export function createEventBus(now?: () => number): EventBus;

// src/pet-token.ts
export function ensurePetToken(dir: string): string; // crea o lee <dir>/pet-token, siempre deja 0600

// src/config.ts — KitsuneConfig gana:
localApi: { enabled: boolean; port: number; devOrigins: string[] };
```

- [ ] **Step 1: Write the failing tests**

`src/events.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type KitsuneEvent } from "./events.js";

test("publish entrega a todos los suscriptores con marca de tiempo", () => {
  const bus = createEventBus(() => 123);
  const a: KitsuneEvent[] = [];
  const b: KitsuneEvent[] = [];
  bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));
  bus.publish({ type: "session_done", name: "cowork-x" });
  assert.deepEqual(a, [{ type: "session_done", name: "cowork-x", at: 123 }]);
  assert.deepEqual(b, a);
});

test("desuscribir deja de entregar", () => {
  const bus = createEventBus(() => 1);
  const got: KitsuneEvent[] = [];
  const off = bus.subscribe((e) => got.push(e));
  off();
  bus.publish({ type: "error", message: "x" });
  assert.deepEqual(got, []);
});

test("un suscriptor que lanza no afecta a los demás ni a quien publica", () => {
  const bus = createEventBus(() => 1);
  const got: string[] = [];
  bus.subscribe(() => { throw new Error("boom"); });
  bus.subscribe((e) => got.push(e.type));
  assert.doesNotThrow(() => bus.publish({ type: "triage_started", title: "t" }));
  assert.deepEqual(got, ["triage_started"]);
});
```

`src/pet-token.test.ts`:

```ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePetToken } from "./pet-token.js";

const tmp = () => mkdtempSync(join(tmpdir(), "kitsune-pet-token-"));

test("crea un token hex de 64 caracteres con permisos 0600", () => {
  const dir = tmp();
  try {
    const token = ensurePetToken(dir);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(dir, "pet-token"), "utf8").trim(), token);
    assert.equal(statSync(join(dir, "pet-token")).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reutiliza un token existente y le corrige los permisos", () => {
  const dir = tmp();
  try {
    const existing = "a".repeat(64);
    writeFileSync(join(dir, "pet-token"), `${existing}\n`);
    chmodSync(join(dir, "pet-token"), 0o644);
    assert.equal(ensurePetToken(dir), existing);
    assert.equal(statSync(join(dir, "pet-token")).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("un token inválido se reemplaza", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "pet-token"), "corto");
    assert.match(ensurePetToken(dir), /^[0-9a-f]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Agregar a `src/config.test.ts` (reusa los helpers `dir`, `ENV` y `MIN` que ya existen en ese archivo):

```ts
test("localApi tiene valores por defecto", () => {
  const { d, cleanup } = dir({ config: MIN, env: ENV });
  try { assert.deepEqual(loadConfig(d).config.localApi, { enabled: true, port: 47823, devOrigins: [] }); } finally { cleanup(); }
});

test("localApi valida puerto y devOrigins", () => {
  for (const bad of [{ port: 80 }, { port: 70000 }, { port: "1" }, { devOrigins: ["https://evil.example"] }, { devOrigins: "x" }, { enabled: "si" }]) {
    const { d, cleanup } = dir({ config: { ...MIN, localApi: bad }, env: ENV });
    try { assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && /localApi/.test(e.message)); } finally { cleanup(); }
  }
});

test("localApi acepta devOrigins de localhost", () => {
  const { d, cleanup } = dir({ config: { ...MIN, localApi: { devOrigins: ["http://localhost:1420"] } }, env: ENV });
  try { assert.deepEqual(loadConfig(d).config.localApi.devOrigins, ["http://localhost:1420"]); } finally { cleanup(); }
});
```

Si la prueba existente `loadConfig aplica valores por defecto` compara el objeto `config` completo con `deepEqual`, agrégale `localApi: { enabled: true, port: 47823, devOrigins: [] }` al objeto esperado.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/events.test.ts src/pet-token.test.ts src/config.test.ts`
Expected: FAIL (`Cannot find module './events.js'`, `'./pet-token.js'`, y aserciones de `localApi`).

- [ ] **Step 3: Implement**

`src/events.ts`:

```ts
export type TriageOutcome = "propose_session" | "notify" | "ignore" | "failed";
export type KitsuneEvent =
  | { type: "triage_started"; at: number; title: string }
  | { type: "event_triaged"; at: number; title: string; action: TriageOutcome }
  | { type: "proposal_created"; at: number; id: string; title: string; url: string; repo: string; workflow: string }
  | { type: "proposal_resolved"; at: number; id: string; status: "launched" | "failed" | "rejected" | "expired"; sessionName?: string }
  | { type: "session_update"; at: number; name: string; stage: string | null; stagesDone: number; stagesTotal: number }
  | { type: "session_question"; at: number; name: string; question: string }
  | { type: "session_done"; at: number; name: string }
  | { type: "session_dead"; at: number; name: string; reason: string }
  | { type: "error"; at: number; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type KitsuneEventInput = DistributiveOmit<KitsuneEvent, "at">;

export interface EventBus {
  publish(event: KitsuneEventInput): void;
  subscribe(listener: (event: KitsuneEvent) => void): () => void;
}

/** Bus en memoria, sin historial: quien se conecta tarde pide la foto completa (/state). */
export function createEventBus(now: () => number = Date.now): EventBus {
  const listeners = new Set<(event: KitsuneEvent) => void>();
  return {
    publish(input) {
      const event = { ...input, at: now() } as KitsuneEvent;
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* un suscriptor roto no afecta a los demás */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
```

`src/pet-token.ts`:

```ts
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VALID = /^[0-9a-f]{64}$/;

/** Token compartido con la mascota (~/.kitsune/pet-token). Solo el dueño puede leerlo. */
export function ensurePetToken(dir: string): string {
  const path = join(dir, "pet-token");
  let token = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (!VALID.test(token)) {
    token = randomBytes(32).toString("hex");
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return token;
}
```

`src/config.ts`: agrega a `KitsuneConfig` el campo `localApi: { enabled: boolean; port: number; devOrigins: string[] };`. En `loadConfig`, antes de construir `config`:

```ts
  const rawApi = raw.localApi ?? {};
  if (typeof rawApi !== "object" || rawApi === null || Array.isArray(rawApi)) throw new ConfigError("localApi debe ser un objeto");
  const enabled = rawApi.enabled ?? true;
  if (typeof enabled !== "boolean") throw new ConfigError("localApi.enabled debe ser true o false");
  const port = rawApi.port ?? 47823;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError("localApi.port debe ser un entero entre 1024 y 65535");
  const devOrigins = rawApi.devOrigins ?? [];
  if (!Array.isArray(devOrigins) || !devOrigins.every((o) => typeof o === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) {
    throw new ConfigError("localApi.devOrigins debe ser una lista de orígenes http://localhost[:puerto]");
  }
```

y agrega `localApi: { enabled, port, devOrigins },` al objeto `config`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/events.test.ts src/pet-token.test.ts src/config.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts src/events.test.ts src/pet-token.ts src/pet-token.test.ts src/config.ts src/config.test.ts
git commit -F- <<'EOF'
feat: bus de eventos, config localApi y token de la mascota

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A2: Publicar eventos desde `app.ts` y `watcher.ts`

**Files:**
- Modify: `src/app.ts` (`AppDeps` y los puntos de publicación), `src/watcher.ts`
- Test: `src/app.test.ts`, `src/watcher.test.ts`

**Interfaces:**
- Consumes: `EventBus`, `KitsuneEventInput` (Task A1).
- Produces: `AppDeps.events?: EventBus` y el argumento de `createWatcher` gana `events?: EventBus`. Son opcionales para que las pruebas y las llamadas existentes sigan funcionando sin bus.

Puntos de publicación, justo junto a lo que ya se envía a Telegram:

| Dónde | Evento |
|---|---|
| `onInboxEvent`, después de `saveEvent` | `triage_started { title: event.title }` |
| `onInboxEvent`, en el `catch` del triage | `event_triaged { action: "failed" }` y `error { message: "No pude clasificar: <título>" }` |
| `onInboxEvent`, después de guardar el triage | `event_triaged { action: triage.action }` |
| `onInboxEvent`, después de `createProposal` | `proposal_created { id, title, url, repo, workflow: workflowName }` |
| `launched()` | `proposal_resolved { status: "launched", sessionName }` |
| rama de fallo de `launch()` (transición a `failed`) | `proposal_resolved { status: "failed" }` y `error { message: "No se pudo lanzar: <error>" }` |
| caso `reject` de `onCallback` | `proposal_resolved { status: "rejected" }` |
| `sweepExpired`, por cada propuesta expirada | `proposal_resolved { status: "expired" }` |
| watcher: la etapa, `stagesDone` o `stagesTotal` de una sesión cambió desde el tick anterior (mapa en memoria; también en el primer tick) | `session_update { name, stage, stagesDone, stagesTotal }` |
| watcher: pregunta nueva enviada | `session_question { name, question }` |
| watcher: sesión terminada | `session_done { name }` |
| watcher: sesión desaparecida | `session_dead { name, reason: "ya no existe" }` |
| watcher: sesión detenida (💤) | `session_dead { name, reason: "el agente se detuvo" }` |
| watcher: gate fallido nuevo | `error { message: "Falló el gate de <etapa> en <sesión>" }` |

En `app.ts` agrega un helper local `const emit = (e: KitsuneEventInput) => deps.events?.publish(e);` y úsalo en cada punto. En `watcher.ts` agrega el mismo helper y un `Map<string, string>` con la última combinación `${stage}|${stagesDone}|${stagesTotal}` de cada sesión. El bus es síncrono y nunca lanza, así que publicar no puede cambiar el comportamiento existente.

- [ ] **Step 1: Write the failing tests**

Agregar a `src/app.test.ts`. La función `harness` de ese archivo construye la app; agrégale un parámetro opcional `events` que llegue a `createKitsuneApp` (si su firma es distinta, adáptala de forma mínima):

```ts
import { createEventBus, type KitsuneEvent } from "./events.js";

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
```

Agrega también estas cuatro pruebas de `proposal_resolved` en `app.test.ts`, reutilizando los flujos que ese archivo ya ejercita. Cada una afirma que `c.events` contiene exactamente un `proposal_resolved` con el `status` indicado:
- **`launched`:** `onInboxEvent(EVENT)` → `approve` → `launch_with` con el índice del workflow sugerido. Afirma también `sessionName === "cowork-…"`, el nombre que devuelve el fake de Ronin.
- **`failed`:** el mismo flujo con un Ronin cuyo `createSession` lanza `RoninError("UNREACHABLE", …)`. Afirma además un evento `error` cuyo `message` empieza con "No se pudo lanzar".
- **`rejected`:** `onInboxEvent(EVENT)` → callback `reject`.
- **`expired`:** `onInboxEvent(EVENT)` → avanzar el reloj más que `ttlMs` → `sweepExpired()`.

Agregar a `src/watcher.test.ts`:

```ts
import { createEventBus, type KitsuneEvent } from "./events.js";

const BASE: SessionStatus = { name: "cowork-a", workflow: "w", stage: "implementing", stagesDone: 1, stagesTotal: 4, attention: "working", needsInput: false, gate: null };

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
  const h = withBus([[BASE], [BASE], [{ ...BASE, stage: "tests", stagesDone: 2 }]]);
  await h.watcher.tick(); await h.watcher.tick(); await h.watcher.tick();
  const updates = h.events.filter((e) => e.type === "session_update");
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((e) => (e as Extract<KitsuneEvent, { type: "session_update" }>).stage), ["implementing", "tests"]);
});

test("publica session_question con la pregunta", async () => {
  const h = withBus([[{ ...BASE, attention: "decision", needsInput: true, question: "¿Sigo?" }]]);
  await h.watcher.tick();
  assert.ok(h.events.some((e) => e.type === "session_question" && e.question === "¿Sigo?"));
});

test("publica session_done al terminar", async () => {
  const h = withBus([[{ ...BASE, stage: null, stagesDone: 4, stagesTotal: 4, attention: "idle" }]]);
  await h.watcher.tick();
  assert.ok(h.events.some((e) => e.type === "session_done" && e.name === "cowork-a"));
});

test("publica session_dead cuando la sesión desaparece", async () => {
  const h = withBus([[]]);
  await h.watcher.tick();
  assert.ok(h.events.some((e) => e.type === "session_dead" && e.reason === "ya no existe"));
});
```

(Si `SessionStatus`, `openStore`, `RoninClient`, `Channel` o `createWatcher` todavía no están importados en `watcher.test.ts`, impórtalos igual que en el resto del archivo.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/app.test.ts src/watcher.test.ts`
Expected: FAIL (no se publica ningún evento).

- [ ] **Step 3: Implement** según la tabla de arriba.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, incluidas todas las pruebas que ya existían.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/app.test.ts src/watcher.ts src/watcher.test.ts
git commit -F- <<'EOF'
feat: publicar eventos de propuestas y sesiones en el bus

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task A3: StateTracker, servidor local y cableado en la CLI

**Files:**
- Create: `src/state.ts`, `src/local-api.ts`
- Modify: `src/cli.ts` (`build` y `start`), `config.example.json`, `README.md`
- Test: `src/state.test.ts`, `src/local-api.test.ts`

**Interfaces:**
- Consumes: `EventBus`, `KitsuneEvent` (A1), `Store` (`listPending`, `listActiveSessions`), `ensurePetToken` (A1).
- Produces:

```ts
// src/state.ts
export interface PendingItem { id: string; title: string; url: string; repo: string; workflow: string; createdAt: number }
export interface SessionItem { name: string; stage: string | null; stagesDone: number; stagesTotal: number; needsInput: boolean; question?: string }
export interface PetState { triaging: boolean; pending: PendingItem[]; sessions: SessionItem[]; lastError: { message: string; at: number } | null }
export interface StateTracker { snapshot(): PetState; dispose(): void }
export function createStateTracker(deps: { store: Store; bus: EventBus }): StateTracker;

// src/local-api.ts
export interface LocalApiOptions {
  port: number; token: string; allowedOrigins: string[];
  snapshot: () => PetState; bus: EventBus; heartbeatMs?: number;
}
export interface LocalApi { port: number; close(): Promise<void> }
export function startLocalApi(opts: LocalApiOptions): Promise<LocalApi>; // escucha en 127.0.0.1; rechaza si el puerto está ocupado
```

Reglas de `createStateTracker`:
- `pending` sale de `store.listPending()`: `title = p.title || p.origin`, `workflow = p.workflowName` y cada texto acotado a 500.
- `sessions`: la lista base son los nombres de `store.listActiveSessions()`, completados con el último `session_update` y `session_question` de cada una. Si no hay datos, `stage: null`, `0/0` y `needsInput: false`. `session_done` y `session_dead` la quitan del mapa en memoria. `session_update` quita `needsInput`.
- `triaging`: `true` con `triage_started` y `false` con `event_triaged`.
- `lastError`: el último `error`, acotado a 500.

Reglas de `startLocalApi`:
- En este orden, para cada petición:
  1. Si trae `Origin` y no está en `allowedOrigins` → 403.
  2. `OPTIONS` de un origen permitido → 204 con `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Headers: x-kitsune-token`, `Access-Control-Allow-Methods: GET` y `Vary: Origin`.
  3. Token con `timingSafeEqual` (buffers de igual largo; si difieren en largo, no hay coincidencia) → si falla, 401.
  4. `GET /state` → 200 con JSON.
  5. `GET /events` → SSE.
  6. Cualquier otra ruta → 404.
- Toda respuesta a un origen permitido lleva `Access-Control-Allow-Origin` y `Vary: Origin`.
- **SSE:**
  - Cabeceras `content-type: text/event-stream`, `cache-control: no-cache` y `connection: keep-alive`.
  - Al conectar escribe `: ok\n\n`. Luego una línea `data: <json>\n\n` por evento del bus, y `: hb\n\n` cada `heartbeatMs` (15000 por defecto).
  - Al cerrar la conexión se desuscribe y limpia el intervalo.
- `close()` termina los streams abiertos y cierra el servidor.

- [ ] **Step 1: Write the failing tests**

`src/state.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "./events.js";
import { createStateTracker } from "./state.js";
import { openStore } from "./store.js";

function setup() {
  const store = openStore(":memory:");
  const bus = createEventBus(() => 50);
  return { store, bus, tracker: createStateTracker({ store, bus }) };
}

test("pending sale del store con título, repo y workflow", () => {
  const { store, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "T", body: "", url: "https://u", author: "", at: "", meta: { taskId: "1", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "todo-api", workflowId: "wf-1", workflowName: "plan-tdd", request: "x", origin: "clickup:1", title: "T", url: "https://u" }, 10);
  assert.deepEqual(tracker.snapshot().pending, [{ id: p.id, title: "T", url: "https://u", repo: "todo-api", workflow: "plan-tdd", createdAt: 10 }]);
});

test("triaging, sesiones, preguntas y lastError siguen al bus", () => {
  const { store, bus, tracker } = setup();
  store.saveEvent({ source: "clickup", id: "e1", kind: "task_assigned", title: "", body: "", url: "", author: "", at: "", meta: { taskId: "", listId: "", listName: "", tags: [] } }, 1);
  const p = store.createProposal({ eventId: "e1", repo: "r", workflowId: "w", workflowName: "w", request: "x", origin: "o", title: "", url: "" }, 1);
  store.trackSession("cowork-a", p.id);
  bus.publish({ type: "triage_started", title: "t" });
  assert.equal(tracker.snapshot().triaging, true);
  bus.publish({ type: "event_triaged", title: "t", action: "ignore" });
  assert.equal(tracker.snapshot().triaging, false);
  bus.publish({ type: "session_update", name: "cowork-a", stage: "tests", stagesDone: 2, stagesTotal: 4 });
  bus.publish({ type: "session_question", name: "cowork-a", question: "¿Sigo?" });
  assert.deepEqual(tracker.snapshot().sessions, [{ name: "cowork-a", stage: "tests", stagesDone: 2, stagesTotal: 4, needsInput: true, question: "¿Sigo?" }]);
  bus.publish({ type: "error", message: "x".repeat(600) });
  assert.equal(tracker.snapshot().lastError?.message.length, 500);
  bus.publish({ type: "session_done", name: "cowork-a" });
  assert.equal(tracker.snapshot().sessions[0].needsInput, false);
});

test("dispose deja de escuchar el bus", () => {
  const { bus, tracker } = setup();
  tracker.dispose();
  bus.publish({ type: "triage_started", title: "t" });
  assert.equal(tracker.snapshot().triaging, false);
});
```

(Después de `session_done` el store todavía lista la sesión como activa hasta que el watcher la marque `notifiedDone`, así que el tracker la sigue devolviendo con los valores por defecto. Eso es lo que prueba la última aserción.)

`src/local-api.test.ts`:

```ts
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
```

Nota: el `fetch` de Node (undici) sí permite fijar la cabecera `origin`. Si en la versión instalada la descarta, cambia esas pruebas a `node:http` `request()` con la cabecera explícita. No las elimines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/state.test.ts src/local-api.test.ts`
Expected: FAIL (`Cannot find module`).

- [ ] **Step 3: Implement `src/state.ts`**

```ts
import type { EventBus, KitsuneEvent } from "./events.js";
import type { Store } from "./store.js";

export interface PendingItem { id: string; title: string; url: string; repo: string; workflow: string; createdAt: number }
export interface SessionItem { name: string; stage: string | null; stagesDone: number; stagesTotal: number; needsInput: boolean; question?: string }
export interface PetState { triaging: boolean; pending: PendingItem[]; sessions: SessionItem[]; lastError: { message: string; at: number } | null }
export interface StateTracker { snapshot(): PetState; dispose(): void }

const MAX = 500;
const clip = (text: string) => (text.length > MAX ? text.slice(0, MAX) : text);

export function createStateTracker(deps: { store: Store; bus: EventBus }): StateTracker {
  let triaging = false;
  let lastError: PetState["lastError"] = null;
  const live = new Map<string, Omit<SessionItem, "name">>();

  const off = deps.bus.subscribe((e: KitsuneEvent) => {
    switch (e.type) {
      case "triage_started": triaging = true; break;
      case "event_triaged": triaging = false; break;
      case "session_update": live.set(e.name, { stage: e.stage, stagesDone: e.stagesDone, stagesTotal: e.stagesTotal, needsInput: false }); break;
      case "session_question": {
        const prev = live.get(e.name) ?? { stage: null, stagesDone: 0, stagesTotal: 0, needsInput: false };
        live.set(e.name, { ...prev, needsInput: true, question: clip(e.question) });
        break;
      }
      case "session_done":
      case "session_dead": live.delete(e.name); break;
      case "error": lastError = { message: clip(e.message), at: e.at }; break;
      default: break;
    }
  });

  return {
    snapshot() {
      const pending = deps.store.listPending().map((p) => ({
        id: p.id, title: clip(p.title || p.origin), url: clip(p.url), repo: clip(p.repo), workflow: clip(p.workflowName), createdAt: p.createdAt,
      }));
      const sessions = deps.store.listActiveSessions().map((t) => {
        const s = live.get(t.name);
        const item: SessionItem = { name: t.name, stage: s?.stage ?? null, stagesDone: s?.stagesDone ?? 0, stagesTotal: s?.stagesTotal ?? 0, needsInput: s?.needsInput ?? false };
        if (s?.question) item.question = s.question;
        return item;
      });
      return { triaging, pending, sessions, lastError };
    },
    dispose: off,
  };
}
```

- [ ] **Step 4: Implement `src/local-api.ts`**

```ts
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EventBus } from "./events.js";
import type { PetState } from "./state.js";

export interface LocalApiOptions {
  port: number; token: string; allowedOrigins: string[];
  snapshot: () => PetState; bus: EventBus; heartbeatMs?: number;
}
export interface LocalApi { port: number; close(): Promise<void> }

function tokenOk(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startLocalApi(opts: LocalApiOptions): Promise<LocalApi> {
  const streams = new Set<ServerResponse>();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!opts.allowedOrigins.includes(origin)) { res.writeHead(403).end(); return; }
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS" && origin !== undefined) {
      res.writeHead(204, { "access-control-allow-headers": "x-kitsune-token", "access-control-allow-methods": "GET" }).end();
      return;
    }
    const presented = req.headers["x-kitsune-token"];
    if (!tokenOk(opts.token, Array.isArray(presented) ? presented[0] : presented)) { res.writeHead(401).end(); return; }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/state") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(opts.snapshot()));
      return;
    }
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": ok\n\n");
      streams.add(res);
      const off = opts.bus.subscribe((event) => { res.write(`data: ${JSON.stringify(event)}\n\n`); });
      const beat = setInterval(() => res.write(": hb\n\n"), heartbeatMs);
      const cleanup = () => { off(); clearInterval(beat); streams.delete(res); };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          for (const res of streams) res.end();
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
```

- [ ] **Step 5: Wire into `src/cli.ts`**

- En `build()`: crea `const events = createEventBus();` y pásalo como `events` a `createKitsuneApp` y a `createWatcher`. Crea `const tracker = createStateTracker({ store, bus: events });` y devuelve `events` y `tracker` en el objeto de `build`.
- En `start()`, después de `recoverInterrupted` y antes de `startLoops`:

```ts
  let localApi: LocalApi | null = null;
  if (k.config.localApi.enabled) {
    try {
      localApi = await startLocalApi({
        port: k.config.localApi.port, token: ensurePetToken(dir),
        allowedOrigins: ["tauri://localhost", ...k.config.localApi.devOrigins],
        snapshot: k.tracker.snapshot, bus: k.events,
      });
      log(`API local para la mascota en http://127.0.0.1:${localApi.port}`);
    } catch (error) {
      log(`API local deshabilitada: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
```

- En `shutdown`, antes de `k.store.close()`: `await localApi?.close();`.
- `config.example.json` gana `"localApi": { "enabled": true, "port": 47823, "devOrigins": [] }`.
- `README.md` gana una sección "Local API (desktop pet)": puerto, token en `~/.kitsune/pet-token`, lista blanca de orígenes, que es de solo lectura, y los tipos de evento.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run build && KITSUNE_HOME=/nonexistent node dist/cli.js doctor`
Expected: todo en verde. `doctor` falla con "falta /nonexistent/config.json" y código 1, como antes.

- [ ] **Step 7: Commit**

```bash
git add src/state.ts src/state.test.ts src/local-api.ts src/local-api.test.ts src/cli.ts config.example.json README.md
git commit -F- <<'EOF'
feat: API local de solo lectura para la mascota (/state y /events)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Parte B: la app de la mascota (`pet/`)

### Task B1: Scaffold de `pet/`, codificador PNG y generador de hojas de sprites

**Files:**
- Create: `pet/package.json`, `pet/tsconfig.json`, `pet/vite.config.ts`, `pet/index.html`, `pet/preview.html`, `pet/art/png.ts`, `pet/art/sheet.ts`, `pet/art/png.test.ts`, `pet/art/sheet.test.ts`
- Modify: `.gitignore` (raíz: `pet/node_modules/`, `pet/dist/`, `pet/src-tauri/target/`)

**Interfaces:**
- Produces:

```ts
// pet/art/png.ts
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer;

// pet/art/sheet.ts
export type Frame = string[];                       // 32 filas de 32 caracteres; "." = transparente
export type Palette = Record<string, [number, number, number, number]>;
export interface AnimationDef { fps: number; loop: boolean; frames: Frame[] }
export interface SheetMeta { frameSize: number; animations: Record<string, { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }> }
export function validateFrame(frame: Frame, palette: Palette, size?: number): string[]; // lista de errores; vacía = válido
export function buildSheet(animations: Record<string, AnimationDef>, palette: Palette, size?: number): { width: number; height: number; rgba: Uint8Array; meta: SheetMeta };
export function scaleNearest(width: number, height: number, rgba: Uint8Array, factor: number): { width: number; height: number; rgba: Uint8Array };
```

Diseño de la hoja: una fila por animación, en el orden de las claves del objeto; los cuadros van de izquierda a derecha. `width = size × (máximo de cuadros)` y `height = size × (número de animaciones)`.

- [ ] **Step 1: Create the scaffold**

`pet/package.json`:

```json
{
  "name": "kitsune-pet",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "sprites": "tsx art/build-sprites.ts",
    "preview": "npm run sprites && vite --open /preview.html",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.1.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.1.0",
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

`pet/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "strict": true, "skipLibCheck": true, "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node", "vitest/globals"], "noEmit": true
  },
  "include": ["src", "art"]
}
```

`pet/vite.config.ts`:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { rollupOptions: { input: { main: "index.html", preview: "preview.html" } } },
  test: { globals: true, environment: "node", include: ["src/**/*.test.ts", "art/**/*.test.ts"] },
});
```

`pet/index.html`:

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>Kitsune</title>
    <style>
      html, body { margin: 0; background: transparent; overflow: hidden; user-select: none; }
      #bubble { position: absolute; left: 8px; right: 8px; bottom: 136px; padding: 6px 8px; border-radius: 8px;
        background: #161826ee; color: #f2f0ff; font: 12px/1.3 -apple-system, system-ui, sans-serif; display: none; }
      #bubble.show { display: block; }
      canvas { position: absolute; bottom: 0; right: 0; image-rendering: pixelated; }
    </style>
  </head>
  <body>
    <div id="bubble"></div>
    <canvas id="pet"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`pet/preview.html`:

```html
<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><title>Kitsune — preview</title>
    <style>body { background: #2a2d3a; color: #eee; font: 13px system-ui; } canvas { image-rendering: pixelated; margin: 4px; background: #3a3e4f; }</style>
  </head>
  <body><div id="grid"></div><script type="module" src="/src/preview.ts"></script></body>
</html>
```

Run: `cd pet && npm install`

- [ ] **Step 2: Write the failing tests**

`pet/art/png.test.ts`:

```ts
import { inflateSync } from "node:zlib";
import { encodePng } from "./png";

function chunks(png: Buffer) {
  const out: Record<string, Buffer> = {};
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    out[type] = Buffer.concat([out[type] ?? Buffer.alloc(0), png.subarray(offset + 8, offset + 8 + length)]);
    offset += 12 + length;
  }
  return out;
}

test("firma PNG, IHDR y pixeles recuperables", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 1, 2, 3, 4]); // 2×2
  const png = encodePng(2, 2, rgba);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const c = chunks(png);
  expect(c.IHDR.readUInt32BE(0)).toBe(2);
  expect(c.IHDR.readUInt32BE(4)).toBe(2);
  expect(c.IHDR[8]).toBe(8);   // bit depth
  expect(c.IHDR[9]).toBe(6);   // RGBA
  const raw = inflateSync(c.IDAT);
  expect([...raw]).toEqual([0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 128, 1, 2, 3, 4]); // filtro 0 por fila
  expect(c.IEND.length).toBe(0);
});

test("es determinista", () => {
  const rgba = new Uint8Array(4 * 4 * 4).fill(7);
  expect(encodePng(4, 4, rgba).equals(encodePng(4, 4, rgba))).toBe(true);
});
```

`pet/art/sheet.test.ts`:

```ts
import { buildSheet, scaleNearest, validateFrame, type Palette } from "./sheet";

const P: Palette = { a: [255, 0, 0, 255], b: [0, 0, 255, 255] };
const f = (ch: string) => Array.from({ length: 4 }, () => ch.repeat(4));

test("validateFrame detecta tamaño y colores fuera de paleta", () => {
  expect(validateFrame(f("a"), P, 4)).toEqual([]);
  expect(validateFrame(f("a").slice(0, 3), P, 4)[0]).toMatch(/filas/);
  expect(validateFrame(["aaaa", "aaa", "aaaa", "aaaa"], P, 4)[0]).toMatch(/fila 1/);
  expect(validateFrame(["aaaa", "aaza", "aaaa", "aaaa"], P, 4)[0]).toMatch(/'z'/);
});

test("buildSheet coloca una fila por animación y describe los cuadros", () => {
  const { width, height, rgba, meta } = buildSheet({ uno: { fps: 6, loop: true, frames: [f("a"), f("b")] }, dos: { fps: 3, loop: false, frames: [f(".")] } }, P, 4);
  expect([width, height]).toEqual([8, 8]);
  expect(meta).toEqual({ frameSize: 4, animations: {
    uno: { fps: 6, loop: true, frames: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
    dos: { fps: 3, loop: false, frames: [{ x: 0, y: 4 }] },
  } });
  expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);                   // (0,0) = a
  expect([...rgba.subarray(4 * 4, 4 * 4 + 4)]).toEqual([0, 0, 255, 255]);       // (4,0) = b
  expect(rgba[(4 * 8 + 0) * 4 + 3]).toBe(0);                                    // (0,4) transparente
});

test("buildSheet lanza si un cuadro es inválido", () => {
  expect(() => buildSheet({ x: { fps: 1, loop: true, frames: [["zz"]] } }, P, 4)).toThrow(/x\[0\]/);
});

test("scaleNearest multiplica cada pixel", () => {
  const out = scaleNearest(1, 1, new Uint8Array([9, 8, 7, 6]), 3);
  expect([out.width, out.height]).toEqual([3, 3]);
  expect([...out.rgba.subarray(4 * 8, 4 * 9)]).toEqual([9, 8, 7, 6]);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd pet && npx vitest run art`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 4: Implement**

`pet/art/png.ts`:

```ts
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG RGBA de 8 bits, filtro 0 por fila. Suficiente para sprites; sin dependencias. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
```

`pet/art/sheet.ts`:

```ts
export type Frame = string[];
export type Palette = Record<string, [number, number, number, number]>;
export interface AnimationDef { fps: number; loop: boolean; frames: Frame[] }
export interface SheetMeta { frameSize: number; animations: Record<string, { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }> }

export function validateFrame(frame: Frame, palette: Palette, size = 32): string[] {
  const errors: string[] = [];
  if (frame.length !== size) errors.push(`se esperaban ${size} filas y hay ${frame.length}`);
  frame.forEach((row, y) => {
    if (row.length !== size) errors.push(`fila ${y}: se esperaban ${size} columnas y hay ${row.length}`);
    for (const ch of row) if (ch !== "." && !(ch in palette)) errors.push(`fila ${y}: color '${ch}' fuera de la paleta`);
  });
  return errors;
}

export function buildSheet(animations: Record<string, AnimationDef>, palette: Palette, size = 32) {
  const names = Object.keys(animations);
  for (const name of names) {
    animations[name].frames.forEach((frame, i) => {
      const errors = validateFrame(frame, palette, size);
      if (errors.length) throw new Error(`${name}[${i}]: ${errors[0]}`);
    });
  }
  const cols = Math.max(...names.map((n) => animations[n].frames.length));
  const width = size * cols;
  const height = size * names.length;
  const rgba = new Uint8Array(width * height * 4);
  const meta: SheetMeta = { frameSize: size, animations: {} };
  names.forEach((name, row) => {
    const def = animations[name];
    meta.animations[name] = { fps: def.fps, loop: def.loop, frames: [] };
    def.frames.forEach((frame, col) => {
      const ox = col * size;
      const oy = row * size;
      meta.animations[name].frames.push({ x: ox, y: oy });
      frame.forEach((line, y) => {
        [...line].forEach((ch, x) => {
          if (ch === ".") return;
          const i = ((oy + y) * width + (ox + x)) * 4;
          rgba.set(palette[ch], i);
        });
      });
    });
  });
  return { width, height, rgba, meta };
}

export function scaleNearest(width: number, height: number, rgba: Uint8Array, factor: number) {
  const w = width * factor;
  const h = height * factor;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((Math.floor(y / factor) * width) + Math.floor(x / factor)) * 4;
      out.set(rgba.subarray(src, src + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba: out };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd pet && npx vitest run art`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .gitignore pet/package.json pet/package-lock.json pet/tsconfig.json pet/vite.config.ts pet/index.html pet/preview.html pet/art/png.ts pet/art/sheet.ts pet/art/png.test.ts pet/art/sheet.test.ts
git commit -F- <<'EOF'
feat(pet): scaffold, codificador PNG y generador de hojas de sprites

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task B2: El arte del zorro (paleta, cuadros, script de sprites y preview)

**Files:**
- Create: `pet/art/palette.ts`, `pet/art/fox.ts`, `pet/art/build-sprites.ts`, `pet/art/fox.test.ts`, `pet/src/preview.ts`
- Generated (se commitean): `pet/public/sprites.png`, `pet/public/sprites.json`, `pet/public/icon.png` (512×512)

**Interfaces:**
- Consumes: `buildSheet`, `validateFrame`, `scaleNearest`, `encodePng`, `Frame`, `Palette`, `AnimationDef` (B1).
- Produces:

```ts
// pet/art/palette.ts
export const PALETTE: Palette; // ≤ 16 entradas

// pet/art/fox.ts
export type PetAnimation = "sleeping" | "idle" | "sniffing" | "alert" | "working" | "asking" | "celebrate" | "sad";
export const REQUIRED: Record<PetAnimation, { minFrames: number; fps: number; loop: boolean }>;
export const ANIMATIONS: Record<PetAnimation, AnimationDef>;
```

`REQUIRED` (valores exactos):

```ts
export const REQUIRED = {
  sleeping:  { minFrames: 4, fps: 3,  loop: true  },
  idle:      { minFrames: 6, fps: 6,  loop: true  },
  sniffing:  { minFrames: 6, fps: 8,  loop: true  },
  alert:     { minFrames: 6, fps: 8,  loop: true  },
  working:   { minFrames: 6, fps: 8,  loop: true  },
  asking:    { minFrames: 4, fps: 6,  loop: true  },
  celebrate: { minFrames: 8, fps: 10, loop: false },
  sad:       { minFrames: 4, fps: 4,  loop: true  },
} as const;
```

**Dirección de arte (requisitos, no sugerencias):**
- Zorro kitsune sentado de tres cuartos, mirando a la derecha y centrado en la parte baja del cuadro de 32×32 (patas en la fila 30–31). Tres colas esponjadas detrás, con puntas crema. Orejas grandes con interior claro, ojos de 2×2 con brillo y contorno oscuro de 1 px en toda la silueta.
- Paleta: contorno `#1a1426`; naranja en 3 tonos (`#f08a3c` base, `#c85a24` sombra, `#ffb070` luz); crema `#fff1d6`; blanco `#ffffff`; morado de acento `#9184d9` (brillo del ojo, chispas, signos "!" y "?"); gris laptop `#4a4e63` y `#7a7f99`; azul lágrima `#6fb6ff`; amarillo chispa `#ffe066`. Como máximo 16 colores.
- Cada animación **debe moverse de forma legible** a 4×:
  - `idle`: parpadeo y colas que se mecen en 3 posiciones.
  - `sleeping`: enroscado con las colas envolviendo el cuerpo, respiración de 1 px y "z" que suben.
  - `sniffing`: cabeza abajo, nariz alternando.
  - `alert`: orejas erguidas, pequeño salto de 2 px y "!" morado.
  - `working`: laptop gris delante, patas alternando y puntos del cursor.
  - `asking`: cabeza ladeada y "?" morado.
  - `celebrate`: giro o salto con chispas amarillas y moradas; termina en pose `idle`.
  - `sad`: orejas caídas y una lágrima azul que cae.
- Se permite construir los cuadros con helpers (cuerpo base más capas: ojos, orejas, colas, accesorios, desplazamientos). El resultado siempre es `Frame = string[]` de 32×32.

- [ ] **Step 1: Write the failing tests** (`pet/art/fox.test.ts`)

```ts
import { ANIMATIONS, REQUIRED } from "./fox";
import { PALETTE } from "./palette";
import { buildSheet, validateFrame } from "./sheet";

test("la paleta tiene como máximo 16 colores opacos o translúcidos", () => {
  expect(Object.keys(PALETTE).length).toBeLessThanOrEqual(16);
  expect(Object.keys(PALETTE)).not.toContain(".");
});

test("existen todas las animaciones requeridas con su fps, bucle y cuadros mínimos", () => {
  for (const [name, req] of Object.entries(REQUIRED)) {
    const anim = ANIMATIONS[name as keyof typeof ANIMATIONS];
    expect(anim, name).toBeDefined();
    expect(anim.fps, name).toBe(req.fps);
    expect(anim.loop, name).toBe(req.loop);
    expect(anim.frames.length, name).toBeGreaterThanOrEqual(req.minFrames);
  }
});

test("cada cuadro es válido (32×32, solo colores de la paleta)", () => {
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    anim.frames.forEach((frame, i) => expect(validateFrame(frame, PALETTE), `${name}[${i}]`).toEqual([]));
  }
});

test("cada animación se mueve (no todos sus cuadros son iguales)", () => {
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    const distinct = new Set(anim.frames.map((f) => f.join("\n")));
    expect(distinct.size, name).toBeGreaterThan(1);
  }
});

test("cada cuadro tiene un zorro visible (≥ 150 píxeles opacos)", () => {
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    anim.frames.forEach((frame, i) => {
      const opaque = frame.join("").replace(/\./g, "").length;
      expect(opaque, `${name}[${i}]`).toBeGreaterThanOrEqual(150);
    });
  }
});

test("la hoja es determinista", () => {
  const a = buildSheet(ANIMATIONS, PALETTE);
  const b = buildSheet(ANIMATIONS, PALETTE);
  expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pet && npx vitest run art/fox.test.ts`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implement `pet/art/palette.ts` and `pet/art/fox.ts`** según la dirección de arte.

- [ ] **Step 4: Implement `pet/art/build-sprites.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANIMATIONS } from "./fox";
import { PALETTE } from "./palette";
import { encodePng } from "./png";
import { buildSheet, scaleNearest } from "./sheet";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(out, { recursive: true });
const sheet = buildSheet(ANIMATIONS, PALETTE);
writeFileSync(join(out, "sprites.png"), encodePng(sheet.width, sheet.height, sheet.rgba));
writeFileSync(join(out, "sprites.json"), `${JSON.stringify(sheet.meta, null, 2)}\n`);

// Ícono de la app: primer cuadro de idle a 16× (512×512).
const first = buildSheet({ icon: { fps: 1, loop: false, frames: [ANIMATIONS.idle.frames[0]] } }, PALETTE);
const icon = scaleNearest(first.width, first.height, first.rgba, 16);
writeFileSync(join(out, "icon.png"), encodePng(icon.width, icon.height, icon.rgba));
console.log(`sprites: ${sheet.width}×${sheet.height}, ${Object.keys(sheet.meta.animations).length} animaciones`);
```

- [ ] **Step 5: Implement `pet/src/preview.ts`** (página para revisar las animaciones)

```ts
import meta from "../public/sprites.json";

const SCALE = 4;
const img = new Image();
img.src = "/sprites.png";
img.onload = () => {
  const grid = document.getElementById("grid")!;
  for (const [name, anim] of Object.entries(meta.animations)) {
    const box = document.createElement("div");
    box.style.display = "inline-block";
    box.innerHTML = `<div>${name} · ${anim.fps} fps · ${anim.frames.length} cuadros</div>`;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = meta.frameSize * SCALE;
    box.appendChild(canvas);
    grid.appendChild(box);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    let i = 0;
    setInterval(() => {
      const f = anim.frames[i % anim.frames.length];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, f.x, f.y, meta.frameSize, meta.frameSize, 0, 0, canvas.width, canvas.height);
      i = anim.loop ? i + 1 : Math.min(i + 1, anim.frames.length - 1);
    }, 1000 / anim.fps);
  }
};
```

(Para que `import meta from "../public/sprites.json"` funcione en tsc, `tsconfig` ya incluye `"moduleResolution": "Bundler"`. Si hace falta, agrega `"resolveJsonModule": true`.)

- [ ] **Step 6: Generate and visually check the art (gate)**

Run: `cd pet && npm run sprites && npx vitest run art`
Expected: pruebas en verde y archivos en `pet/public/`.

Revisión visual obligatoria:
- Crea `pet/art/contact-sheet.ts` (sin commit, es una herramienta local) y ejecútalo con `npx tsx art/contact-sheet.ts /tmp/kitsune-contact.png`:

```ts
import { writeFileSync } from "node:fs";
import { ANIMATIONS } from "./fox";
import { PALETTE } from "./palette";
import { encodePng } from "./png";
import { buildSheet, scaleNearest } from "./sheet";

const sheet = buildSheet(ANIMATIONS, PALETTE);
// fondo gris medio para ver la silueta y el contorno
const bg = new Uint8Array(sheet.rgba);
for (let i = 0; i < bg.length; i += 4) if (bg[i + 3] === 0) bg.set([58, 62, 79, 255], i);
const big = scaleNearest(sheet.width, sheet.height, bg, 8);
writeFileSync(process.argv[2] ?? "/tmp/kitsune-contact.png", encodePng(big.width, big.height, big.rgba));
```
- Ábrela con la herramienta de lectura de imágenes y confirma que:
  - se reconoce un zorro de tres colas en cada animación;
  - la silueta no tiene píxeles sueltos;
  - cada animación comunica su estado.
- Itera sobre el arte hasta que se cumpla. En el reporte adjunta la ruta del PNG final de contacto: el controlador lo revisa antes de aprobar la tarea.

- [ ] **Step 7: Commit**

```bash
git add pet/art/palette.ts pet/art/fox.ts pet/art/build-sprites.ts pet/art/fox.test.ts pet/src/preview.ts pet/public/sprites.png pet/public/sprites.json pet/public/icon.png pet/tsconfig.json
git commit -F- <<'EOF'
feat(pet): arte del zorro kitsune y hoja de sprites

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task B3: Lógica de estado y cliente de la API (puro, con pruebas)

**Files:**
- Create: `pet/src/types.ts`, `pet/src/model.ts`, `pet/src/client.ts`, `pet/src/model.test.ts`, `pet/src/client.test.ts`

**Interfaces:**
- Produces:

```ts
// pet/src/types.ts — espejo manual de src/events.ts y src/state.ts del daemon
export type KitsuneEvent = /* idéntico a KitsuneEvent del daemon (Task A1) */;
export interface PendingItem { id: string; title: string; url: string; repo: string; workflow: string; createdAt: number }
export interface SessionItem { name: string; stage: string | null; stagesDone: number; stagesTotal: number; needsInput: boolean; question?: string }
export interface PetState { triaging: boolean; pending: PendingItem[]; sessions: SessionItem[]; lastError: { message: string; at: number } | null }
export type PetAnimation = "sleeping" | "idle" | "sniffing" | "alert" | "working" | "asking" | "celebrate" | "sad";
export type PetStatus = "offline" | Exclude<PetAnimation, "celebrate">;

// pet/src/model.ts
export interface Bubble { text: string; sticky: boolean; until: number }
export interface Model { connected: boolean; state: PetState; sadUntil: number; celebrateUntil: number; lastActivityAt: number; bubble: Bubble | null; dnd: boolean }
export const EMPTY_STATE: PetState;
export function initialModel(now: number): Model;
export function applySnapshot(m: Model, s: PetState, now: number): Model;
export function applyEvent(m: Model, e: KitsuneEvent, now: number): Model;
export function setConnected(m: Model, connected: boolean, now: number): Model;
export function computeStatus(m: Model, now: number): PetStatus;
export function currentAnimation(m: Model, now: number): PetAnimation | "offline";
export function visibleBubble(m: Model, now: number): Bubble | null;
export function summary(s: PetState): string;

// pet/src/client.ts
export function parseSse(buffer: string): { events: string[]; rest: string };
export function retryDelay(offlineSinceMs: number): number; // 5000 durante el primer minuto, luego 30000
export interface ClientDeps {
  baseUrl: string; token: () => Promise<string>; fetch: typeof fetch;
  onSnapshot(s: PetState): void; onEvent(e: KitsuneEvent): void; onConnected(connected: boolean): void;
  sleep(ms: number): Promise<void>; now(): number;
}
export function startClient(deps: ClientDeps): { stop(): void };
```

Reglas de `model.ts` (constantes exactas: `BUBBLE_MS = 6000`, `SAD_MS = 60000`, `CELEBRATE_MS = 3000`, `SLEEP_AFTER_MS = 600000`, `QUESTION_MAX = 140`):
- `computeStatus`, en orden de prioridad:
  - `!connected` → `offline`
  - `dnd` → `sleeping`
  - alguna sesión con `needsInput && question` → `asking`
  - `pending.length > 0` → `alert`
  - `now < sadUntil` → `sad`
  - `sessions.length > 0` → `working`
  - `triaging` → `sniffing`
  - `now - lastActivityAt < SLEEP_AFTER_MS` → `idle`
  - en otro caso → `sleeping`
- `currentAnimation`: `offline` si no hay conexión; `celebrate` si `now < celebrateUntil` y no hay `dnd`; en otro caso, el estado calculado.
- `applyEvent` actualiza `state` igual que el `StateTracker` del daemon:
  - `triage_started`/`event_triaged` cambian `triaging`.
  - `proposal_created` agrega a `pending` (sin duplicar por id).
  - `proposal_resolved` quita de `pending`.
  - `session_update` hace upsert y apaga `needsInput`.
  - `session_question` activa `needsInput` y guarda `question`.
  - `session_done` y `session_dead` quitan la sesión.
  - `error` actualiza `lastError`.

  Además, cada evento pone `lastActivityAt = now`, y:
  - `session_done` → `celebrateUntil = now + CELEBRATE_MS`
  - `session_dead`, `error` y `event_triaged` con `failed` → `sadUntil = now + SAD_MS`

- Burbujas (si `dnd` está activo no se crea ninguna):

  | Evento | Burbuja |
  |---|---|
  | `triage_started` | "Revisando…" |
  | `proposal_created` | "Nueva tarea: <title>" |
  | `session_question` | "<name> pregunta: <question acotada a 140>" (fija) |
  | `session_done` | "✅ <name> terminó" |
  | `session_dead` | "💤 <name>: <reason>" |
  | `error` | "⚠️ <message acotado a 140>" |

  Las burbujas no fijas duran `BUBBLE_MS`. Una fija se quita cuando llega un `session_update` o un `session_done` de esa sesión.
- `summary`: por ejemplo "2 sesiones trabajando · 1 propuesta pendiente". Sin nada: "Todo tranquilo". Singular y plural en español.
- `applySnapshot` reemplaza `state` y no crea burbujas.

Reglas de `client.ts`:
- `parseSse` separa por `\n\n` y junta las líneas `data:` de cada bloque. Los comentarios (`:`) se ignoran y el bloque incompleto se devuelve en `rest`.
- `startClient` corre un bucle:
  1. Pide el token y hace `GET /state` con `x-kitsune-token` → `onSnapshot` y `onConnected(true)`.
  2. Abre `GET /events` y lee el stream con `getReader()`. Cada `data` es JSON → `onEvent`.
  3. Si falla o se cierra: `onConnected(false)`, espera `retryDelay(tiempo sin conexión)` y vuelve a empezar.
  4. `stop()` corta el bucle y aborta la petición en curso.

- [ ] **Step 1: Write the failing tests** (`pet/src/model.test.ts`)

```ts
import { applyEvent, applySnapshot, computeStatus, currentAnimation, EMPTY_STATE, initialModel, setConnected, summary, visibleBubble } from "./model";

const on = (now = 0) => setConnected(initialModel(now), true, now);
const session = (over = {}) => ({ name: "cowork-a", stage: "impl", stagesDone: 1, stagesTotal: 4, needsInput: false, ...over });

test("sin conexión es offline aunque haya trabajo", () => {
  const m = applySnapshot(initialModel(0), { ...EMPTY_STATE, sessions: [session()] }, 0);
  expect(computeStatus(m, 0)).toBe("offline");
  expect(currentAnimation(m, 0)).toBe("offline");
});

test("prioridad asking > alert > sad > working > sniffing > idle > sleeping", () => {
  let m = on(0);
  expect(computeStatus(m, 0)).toBe("idle");
  expect(computeStatus(m, 600_001)).toBe("sleeping");
  m = applyEvent(m, { type: "triage_started", at: 1, title: "t" }, 1);
  expect(computeStatus(m, 1)).toBe("sniffing");
  m = applyEvent(m, { type: "session_update", at: 2, name: "cowork-a", stage: "impl", stagesDone: 1, stagesTotal: 4 }, 2);
  expect(computeStatus(m, 2)).toBe("working");
  m = applyEvent(m, { type: "error", at: 3, message: "x" }, 3);
  expect(computeStatus(m, 3)).toBe("sad");
  m = applyEvent(m, { type: "proposal_created", at: 4, id: "p1", title: "T", url: "u", repo: "r", workflow: "w" }, 4);
  expect(computeStatus(m, 4)).toBe("alert");
  m = applyEvent(m, { type: "session_question", at: 5, name: "cowork-a", question: "¿Sigo?" }, 5);
  expect(computeStatus(m, 5)).toBe("asking");
});

test("sad expira a los 60 s", () => {
  const m = applyEvent(on(0), { type: "error", at: 0, message: "x" }, 0);
  expect(computeStatus(m, 59_999)).toBe("sad");
  expect(computeStatus(m, 60_001)).toBe("idle");
});

test("celebrate es puntual y vuelve al estado calculado", () => {
  let m = applyEvent(on(0), { type: "session_update", at: 0, name: "cowork-a", stage: "done", stagesDone: 4, stagesTotal: 4 }, 0);
  m = applyEvent(m, { type: "session_done", at: 1, name: "cowork-a" }, 1);
  expect(currentAnimation(m, 2)).toBe("celebrate");
  expect(currentAnimation(m, 3_002)).toBe("idle");
});

test("proposal_resolved quita la propuesta y no duplica ids", () => {
  let m = on(0);
  const created = { type: "proposal_created", at: 1, id: "p1", title: "T", url: "u", repo: "r", workflow: "w" } as const;
  m = applyEvent(applyEvent(m, created, 1), created, 1);
  expect(m.state.pending).toHaveLength(1);
  m = applyEvent(m, { type: "proposal_resolved", at: 2, id: "p1", status: "launched", sessionName: "cowork-a" }, 2);
  expect(m.state.pending).toHaveLength(0);
});

test("burbujas: nueva tarea dura 6 s; la pregunta es fija, acotada a 140 y se quita con session_update", () => {
  let m = applyEvent(on(0), { type: "proposal_created", at: 0, id: "p1", title: "Permisos", url: "u", repo: "r", workflow: "w" }, 0);
  expect(visibleBubble(m, 1)?.text).toBe("Nueva tarea: Permisos");
  expect(visibleBubble(m, 6_001)).toBeNull();
  m = applyEvent(m, { type: "session_question", at: 10, name: "cowork-a", question: "x".repeat(300) }, 10);
  const b = visibleBubble(m, 100_000)!;
  expect(b.sticky).toBe(true);
  expect(b.text.length).toBeLessThanOrEqual("cowork-a pregunta: ".length + 140);
  m = applyEvent(m, { type: "session_update", at: 11, name: "cowork-a", stage: "tests", stagesDone: 3, stagesTotal: 4 }, 11);
  expect(visibleBubble(m, 12)).toBeNull();
});

test("no molestar: duerme y no muestra burbujas", () => {
  let m = { ...on(0), dnd: true };
  m = applyEvent(m, { type: "proposal_created", at: 0, id: "p1", title: "T", url: "u", repo: "r", workflow: "w" }, 0);
  expect(computeStatus(m, 1)).toBe("sleeping");
  expect(visibleBubble(m, 1)).toBeNull();
});

test("summary en español con singular y plural", () => {
  expect(summary(EMPTY_STATE)).toBe("Todo tranquilo");
  expect(summary({ ...EMPTY_STATE, sessions: [session(), session({ name: "b" })], pending: [{ id: "p", title: "", url: "", repo: "", workflow: "", createdAt: 0 }] }))
    .toBe("2 sesiones trabajando · 1 propuesta pendiente");
});
```

`pet/src/client.test.ts`:

```ts
import { parseSse, retryDelay, startClient } from "./client";

test("parseSse separa bloques, ignora comentarios y conserva el resto", () => {
  expect(parseSse(": ok\n\ndata: {\"a\":1}\n\ndata: {\"b\"")).toEqual({ events: ['{"a":1}'], rest: 'data: {"b"' });
});

test("retryDelay: 5 s el primer minuto, luego 30 s", () => {
  expect(retryDelay(0)).toBe(5000);
  expect(retryDelay(59_999)).toBe(5000);
  expect(retryDelay(60_000)).toBe(30000);
});

test("reconecta y pide /state tras perder el stream", async () => {
  const calls: string[] = [];
  const connected: boolean[] = [];
  let round = 0;
  const encoder = new TextEncoder();
  const fakeFetch = (async (url: string) => {
    calls.push(url.replace("http://k", ""));
    if (url.endsWith("/state")) return new Response(JSON.stringify({ triaging: false, pending: [], sessions: [], lastError: null }));
    round++;
    const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(': ok\n\ndata: {"type":"session_done","name":"x","at":1}\n\n')); c.close(); } });
    return new Response(body);
  }) as unknown as typeof fetch;
  const events: unknown[] = [];
  let client: { stop(): void } | null = null;
  await new Promise<void>((done) => {
    client = startClient({
      baseUrl: "http://k", token: async () => "t", fetch: fakeFetch,
      onSnapshot: () => {}, onEvent: (e) => events.push(e), onConnected: (c) => connected.push(c),
      sleep: async () => { if (round >= 2) { client?.stop(); done(); } }, now: () => 0,
    });
  });
  expect(calls).toEqual(["/state", "/events", "/state", "/events"]);
  expect(connected).toEqual([true, false, true, false]);
  expect(events).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pet && npx vitest run src`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implement**

`pet/src/types.ts`: copia literal de la unión `KitsuneEvent` de `src/events.ts` (Task A1) y de `PendingItem`, `SessionItem` y `PetState` de `src/state.ts` (Task A3), más:

```ts
export type PetAnimation = "sleeping" | "idle" | "sniffing" | "alert" | "working" | "asking" | "celebrate" | "sad";
export type PetStatus = "offline" | Exclude<PetAnimation, "celebrate">;
```

`pet/src/model.ts`:

```ts
import type { KitsuneEvent, PetAnimation, PetState, PetStatus, SessionItem } from "./types";

export const BUBBLE_MS = 6000;
export const SAD_MS = 60000;
export const CELEBRATE_MS = 3000;
export const SLEEP_AFTER_MS = 600000;
export const QUESTION_MAX = 140;

export interface Bubble { text: string; sticky: boolean; until: number; session?: string }
export interface Model { connected: boolean; state: PetState; sadUntil: number; celebrateUntil: number; lastActivityAt: number; bubble: Bubble | null; dnd: boolean }
export const EMPTY_STATE: PetState = { triaging: false, pending: [], sessions: [], lastError: null };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function initialModel(now: number): Model {
  return { connected: false, state: EMPTY_STATE, sadUntil: 0, celebrateUntil: 0, lastActivityAt: now, bubble: null, dnd: false };
}

export function setConnected(m: Model, connected: boolean, now: number): Model {
  return { ...m, connected, lastActivityAt: connected ? now : m.lastActivityAt };
}

export function applySnapshot(m: Model, s: PetState, _now: number): Model {
  return { ...m, state: s };
}

export function applyEvent(m: Model, e: KitsuneEvent, now: number): Model {
  let state = m.state;
  let { sadUntil, celebrateUntil, bubble } = m;
  const say = (text: string, sticky = false, session?: string) => {
    if (!m.dnd) bubble = { text, sticky, until: sticky ? Number.POSITIVE_INFINITY : now + BUBBLE_MS, ...(session ? { session } : {}) };
  };
  const upsert = (name: string, patch: Partial<SessionItem>) => {
    const prev = state.sessions.find((s) => s.name === name) ?? { name, stage: null, stagesDone: 0, stagesTotal: 0, needsInput: false };
    const { question: _drop, ...base } = prev;
    const next: SessionItem = { ...base, ...patch, name };
    if (!next.needsInput) delete next.question;
    state = { ...state, sessions: [...state.sessions.filter((s) => s.name !== name), next] };
  };
  const drop = (name: string) => { state = { ...state, sessions: state.sessions.filter((s) => s.name !== name) }; };
  const clearSticky = (name: string) => { if (bubble?.sticky && bubble.session === name) bubble = null; };

  switch (e.type) {
    case "triage_started": state = { ...state, triaging: true }; say("Revisando…"); break;
    case "event_triaged": state = { ...state, triaging: false }; if (e.action === "failed") sadUntil = now + SAD_MS; break;
    case "proposal_created":
      if (!state.pending.some((p) => p.id === e.id)) {
        state = { ...state, pending: [...state.pending, { id: e.id, title: e.title, url: e.url, repo: e.repo, workflow: e.workflow, createdAt: e.at }] };
      }
      say(`Nueva tarea: ${e.title}`);
      break;
    case "proposal_resolved": state = { ...state, pending: state.pending.filter((p) => p.id !== e.id) }; break;
    case "session_update": upsert(e.name, { stage: e.stage, stagesDone: e.stagesDone, stagesTotal: e.stagesTotal, needsInput: false }); clearSticky(e.name); break;
    case "session_question": upsert(e.name, { needsInput: true, question: e.question }); say(`${e.name} pregunta: ${clip(e.question, QUESTION_MAX)}`, true, e.name); break;
    case "session_done": drop(e.name); clearSticky(e.name); celebrateUntil = now + CELEBRATE_MS; say(`✅ ${e.name} terminó`); break;
    case "session_dead": drop(e.name); clearSticky(e.name); sadUntil = now + SAD_MS; say(`💤 ${e.name}: ${e.reason}`); break;
    case "error": state = { ...state, lastError: { message: e.message, at: e.at } }; sadUntil = now + SAD_MS; say(`⚠️ ${clip(e.message, QUESTION_MAX)}`); break;
  }
  return { ...m, state, sadUntil, celebrateUntil, bubble, lastActivityAt: now };
}

export function computeStatus(m: Model, now: number): PetStatus {
  if (!m.connected) return "offline";
  if (m.dnd) return "sleeping";
  if (m.state.sessions.some((s) => s.needsInput && s.question)) return "asking";
  if (m.state.pending.length > 0) return "alert";
  if (now < m.sadUntil) return "sad";
  if (m.state.sessions.length > 0) return "working";
  if (m.state.triaging) return "sniffing";
  return now - m.lastActivityAt < SLEEP_AFTER_MS ? "idle" : "sleeping";
}

export function currentAnimation(m: Model, now: number): PetAnimation | "offline" {
  if (!m.connected) return "offline";
  if (!m.dnd && now < m.celebrateUntil) return "celebrate";
  return computeStatus(m, now) as PetAnimation;
}

export function visibleBubble(m: Model, now: number): Bubble | null {
  if (m.dnd || !m.bubble) return null;
  return m.bubble.sticky || now < m.bubble.until ? m.bubble : null;
}

export function summary(s: PetState): string {
  const parts: string[] = [];
  const n = s.sessions.length;
  const p = s.pending.length;
  if (n) parts.push(`${n} ${n === 1 ? "sesión trabajando" : "sesiones trabajando"}`);
  if (p) parts.push(`${p} ${p === 1 ? "propuesta pendiente" : "propuestas pendientes"}`);
  return parts.join(" · ") || "Todo tranquilo";
}
```

`pet/src/client.ts`:

```ts
import type { KitsuneEvent, PetState } from "./types";

export function parseSse(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: string[] = [];
  for (const block of blocks) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
    if (data.length) events.push(data.join("\n"));
  }
  return { events, rest };
}

export const retryDelay = (offlineSinceMs: number): number => (offlineSinceMs < 60_000 ? 5000 : 30000);

export interface ClientDeps {
  baseUrl: string; token: () => Promise<string>; fetch: typeof fetch;
  onSnapshot(s: PetState): void; onEvent(e: KitsuneEvent): void; onConnected(connected: boolean): void;
  sleep(ms: number): Promise<void>; now(): number;
}

export function startClient(deps: ClientDeps): { stop(): void } {
  let stopped = false;
  let controller: AbortController | null = null;
  let offlineSince: number | null = null;
  void (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const headers = { "x-kitsune-token": await deps.token() };
        const stateRes = await deps.fetch(`${deps.baseUrl}/state`, { headers, signal: controller.signal });
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        deps.onSnapshot(await stateRes.json() as PetState);
        offlineSince = null;
        deps.onConnected(true);
        const stream = await deps.fetch(`${deps.baseUrl}/events`, { headers, signal: controller.signal });
        if (!stream.ok || !stream.body) throw new Error(`HTTP ${stream.status}`);
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          for (const raw of parsed.events) {
            try { deps.onEvent(JSON.parse(raw) as KitsuneEvent); } catch { /* evento malformado: se ignora */ }
          }
        }
      } catch { /* sin conexión: cae a la reconexión */ }
      if (stopped) break;
      deps.onConnected(false);
      offlineSince ??= deps.now();
      await deps.sleep(retryDelay(deps.now() - offlineSince));
    }
  })();
  return { stop() { stopped = true; controller?.abort(); } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pet && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pet/src/types.ts pet/src/model.ts pet/src/client.ts pet/src/model.test.ts pet/src/client.test.ts
git commit -F- <<'EOF'
feat(pet): modelo de estado, prioridad, burbujas y cliente con reconexión

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task B4: Renderizado (reproductor de animaciones, burbuja y hit test)

**Files:**
- Create: `pet/src/player.ts`, `pet/src/hit.ts`, `pet/src/player.test.ts`, `pet/src/hit.test.ts`

**Interfaces:**
- Produces:

```ts
// pet/src/player.ts
export interface AnimMeta { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }
export function frameIndex(anim: AnimMeta, startedAt: number, now: number): number; // loop: módulo; sin loop: se queda en el último

// pet/src/hit.ts
/** ¿El punto (px,py), en píxeles lógicos relativos al canvas, cae sobre un píxel opaco del cuadro actual? */
export function isOpaqueAt(alpha: (sheetX: number, sheetY: number) => number, frame: { x: number; y: number }, frameSize: number, scale: number, px: number, py: number): boolean;
```

- [ ] **Step 1: Write the failing tests**

`pet/src/player.test.ts`:

```ts
import { frameIndex } from "./player";

const anim = (loop: boolean) => ({ fps: 10, loop, frames: [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 64, y: 0 }] });

test("en bucle avanza a fps y da la vuelta", () => {
  expect(frameIndex(anim(true), 0, 0)).toBe(0);
  expect(frameIndex(anim(true), 0, 100)).toBe(1);
  expect(frameIndex(anim(true), 0, 300)).toBe(0);
});

test("sin bucle se queda en el último cuadro", () => {
  expect(frameIndex(anim(false), 0, 250)).toBe(2);
  expect(frameIndex(anim(false), 0, 10_000)).toBe(2);
});
```

`pet/src/hit.test.ts`:

```ts
import { isOpaqueAt } from "./hit";

const alpha = (x: number, y: number) => (x === 33 && y === 1 ? 255 : 0); // un solo píxel opaco en (1,1) del cuadro en x=32

test("detecta el píxel opaco escalado y descarta el resto", () => {
  const frame = { x: 32, y: 0 };
  expect(isOpaqueAt(alpha, frame, 32, 4, 4 * 1 + 2, 4 * 1 + 2)).toBe(true);
  expect(isOpaqueAt(alpha, frame, 32, 4, 0, 0)).toBe(false);
  expect(isOpaqueAt(alpha, frame, 32, 4, -1, 5)).toBe(false);
  expect(isOpaqueAt(alpha, frame, 32, 4, 32 * 4, 0)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd pet && npx vitest run src/player.test.ts src/hit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// pet/src/player.ts
export interface AnimMeta { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }

export function frameIndex(anim: AnimMeta, startedAt: number, now: number): number {
  const step = Math.floor(Math.max(0, now - startedAt) / (1000 / anim.fps));
  return anim.loop ? step % anim.frames.length : Math.min(step, anim.frames.length - 1);
}
```

```ts
// pet/src/hit.ts
export function isOpaqueAt(alpha: (sheetX: number, sheetY: number) => number, frame: { x: number; y: number }, frameSize: number, scale: number, px: number, py: number): boolean {
  const fx = Math.floor(px / scale);
  const fy = Math.floor(py / scale);
  if (fx < 0 || fy < 0 || fx >= frameSize || fy >= frameSize) return false;
  return alpha(frame.x + fx, frame.y + fy) > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd pet && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pet/src/player.ts pet/src/hit.ts pet/src/player.test.ts pet/src/hit.test.ts
git commit -F- <<'EOF'
feat(pet): reproductor de animaciones y hit test por canal alfa

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task B5: Ventana Tauri, menú, token, clics que atraviesan y `main.ts`

**Files:**
- Create: `pet/src-tauri/Cargo.toml`, `pet/src-tauri/build.rs`, `pet/src-tauri/tauri.conf.json`, `pet/src-tauri/capabilities/default.json`, `pet/src-tauri/src/main.rs`, `pet/src-tauri/src/lib.rs`, `pet/src-tauri/icons/*` (generados), `pet/src/main.ts`
- Modify: `README.md` (sección "Desktop pet")

**Interfaces:**
- Consumes: `model.ts`, `client.ts` (B3); `player.ts`, `hit.ts` (B4); `public/sprites.png|json` (B2).
- Produces (comandos Tauri invocados desde TS):
  - `read_pet_token() -> String`
  - `set_click_through(ignore: bool)`
  - `cursor_in_window() -> Option<(f64, f64)>` (posición lógica relativa a la ventana; `None` si está fuera)
  - `show_context_menu()`
  - Evento `pet-menu` con payload `"toggle" | "dnd" | "open_ronin" | "size_2" | "size_3" | "size_4"` (Salir lo maneja Rust).

- [ ] **Step 1: Rust and Tauri config**

`pet/src-tauri/Cargo.toml`:

```toml
[package]
name = "kitsune-pet"
version = "0.1.0"
edition = "2021"

[lib]
name = "kitsune_pet_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon", "macos-private-api"] }
tauri-plugin-window-state = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`pet/src-tauri/build.rs`:

```rust
fn main() { tauri_build::build() }
```

`pet/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Kitsune",
  "version": "0.1.0",
  "identifier": "dev.cesarhermosillo.kitsune.pet",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "macOSPrivateApi": true,
    "windows": [{
      "label": "pet", "title": "Kitsune", "width": 220, "height": 220,
      "transparent": true, "decorations": false, "alwaysOnTop": true, "skipTaskbar": true,
      "shadow": false, "resizable": false, "visibleOnAllWorkspaces": true, "focus": false
    }],
    "security": {
      "csp": "default-src 'self'; connect-src http://127.0.0.1:47823 ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.png"]
  }
}
```

`pet/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["pet"],
  "permissions": ["core:default", "core:window:allow-start-dragging", "core:event:default", "window-state:default"]
}
```

`pet/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { kitsune_pet_lib::run() }
```

`pet/src-tauri/src/lib.rs`:

```rust
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Wry};

#[tauri::command]
fn read_pet_token() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    std::fs::read_to_string(format!("{home}/.kitsune/pet-token"))
        .map(|s| s.trim().to_string())
        .map_err(|_| "No encuentro ~/.kitsune/pet-token (¿Kitsune está corriendo?)".to_string())
}

#[tauri::command]
fn set_click_through(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn cursor_in_window(window: WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y) = (cursor.x - pos.x as f64, cursor.y - pos.y as f64);
    if x < 0.0 || y < 0.0 || x > size.width as f64 || y > size.height as f64 { return Ok(None); }
    Ok(Some((x / scale, y / scale)))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let size = SubmenuBuilder::new(app, "Tamaño")
        .item(&MenuItemBuilder::with_id("size_2", "2×").build(app)?)
        .item(&MenuItemBuilder::with_id("size_3", "3×").build(app)?)
        .item(&MenuItemBuilder::with_id("size_4", "4×").build(app)?)
        .build()?;
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("toggle", "Ocultar / Mostrar").build(app)?)
        .item(&CheckMenuItemBuilder::with_id("dnd", "No molestar").build(app)?)
        .item(&MenuItemBuilder::with_id("open_ronin", "Abrir Ronin").build(app)?)
        .item(&size)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Salir").build(app)?)
        .build()
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "toggle" => {
            if let Some(w) = app.get_webview_window("pet") {
                if w.is_visible().unwrap_or(true) { let _ = w.hide(); } else { let _ = w.show(); }
            }
        }
        "open_ronin" => { let _ = std::process::Command::new("open").args(["-a", "Ronin"]).spawn(); }
        other => { let _ = app.emit("pet-menu", other.to_string()); }
    }
}

#[tauri::command]
fn show_context_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![read_pet_token, set_click_through, cursor_in_window, show_context_menu])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let menu = build_menu(app.handle())?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("ícono"))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar la mascota");
}
```

Genera los íconos a partir del sprite: `cd pet && npx tauri icon public/icon.png` (escribe `src-tauri/icons/*`).

Si alguna API de Tauri 2 difiere en la versión instalada (por ejemplo `show_menu_on_left_click` o `popup_menu`), usa el equivalente documentado en la versión que resolvió Cargo y anótalo en el reporte. Lo que no puede cambiar es el comportamiento.

- [ ] **Step 2: `pet/src/main.ts`** (cableado; se verifica en B6)

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import meta from "../public/sprites.json";
import { startClient } from "./client";
import { isOpaqueAt } from "./hit";
import { applyEvent, applySnapshot, currentAnimation, initialModel, setConnected, summary, visibleBubble, type Model } from "./model";
import { frameIndex } from "./player";

const API = "http://127.0.0.1:47823";
const canvas = document.getElementById("pet") as HTMLCanvasElement;
const bubbleEl = document.getElementById("bubble") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;
let scale = Number(localStorage.getItem("kitsune-scale") ?? 4);
let model: Model = initialModel(Date.now());
let hovering = false;
let expanded = false;
let animName = "";
let animStart = 0;

function resize() {
  canvas.width = canvas.height = meta.frameSize * scale;
  ctx.imageSmoothingEnabled = false;
}
resize();

const sheet = new Image();
sheet.src = "/sprites.png";
let alphaData: ImageData | null = null;
sheet.onload = () => {
  const off = new OffscreenCanvas(sheet.width, sheet.height);
  const octx = off.getContext("2d")!;
  octx.drawImage(sheet, 0, 0);
  alphaData = octx.getImageData(0, 0, sheet.width, sheet.height);
  requestAnimationFrame(draw);
};
const alphaAt = (x: number, y: number) => (alphaData ? alphaData.data[(y * alphaData.width + x) * 4 + 3] : 0);

function currentFrame(now: number) {
  const current = currentAnimation(model, now);
  const name = current === "offline" ? "idle" : current;
  if (name !== animName) { animName = name; animStart = now; }
  const anim = (meta.animations as Record<string, { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }>)[name];
  return { current, frame: anim.frames[frameIndex(anim, animStart, now)] };
}

function draw() {
  const now = Date.now();
  const { current, frame } = currentFrame(now);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = current === "offline" ? 0.5 : 1;
  ctx.filter = current === "offline" ? "grayscale(1)" : "none";
  ctx.drawImage(sheet, frame.x, frame.y, meta.frameSize, meta.frameSize, 0, 0, canvas.width, canvas.height);
  const bubble = visibleBubble(model, now);
  const text = expanded ? expandedText() : bubble?.text ?? (hovering ? summary(model.state) : "");
  bubbleEl.textContent = text;
  bubbleEl.classList.toggle("show", text.length > 0);
  requestAnimationFrame(draw);
}

function expandedText(): string {
  const lines = [summary(model.state)];
  for (const p of model.state.pending) lines.push(`• ${p.title} (${p.workflow})`);
  for (const s of model.state.sessions) lines.push(`• ${s.name} · ${s.stage ?? "—"} ${s.stagesDone}/${s.stagesTotal}${s.needsInput ? " · pregunta" : ""}`);
  return lines.join("\n");
}

// Los clics atraviesan la ventana salvo sobre píxeles opacos del zorro o sobre la burbuja visible.
let ignoring = true;
setInterval(async () => {
  const pos = await invoke<[number, number] | null>("cursor_in_window").catch(() => null);
  const rect = canvas.getBoundingClientRect();
  const { frame } = currentFrame(Date.now());
  const overPet = !!pos && isOpaqueAt(alphaAt, frame, meta.frameSize, scale, pos[0] - rect.left, pos[1] - rect.top);
  const b = bubbleEl.getBoundingClientRect();
  const overBubble = !!pos && bubbleEl.classList.contains("show") && pos[0] >= b.left && pos[0] <= b.right && pos[1] >= b.top && pos[1] <= b.bottom;
  hovering = overPet;
  const ignore = !(overPet || overBubble);
  if (ignore !== ignoring) { ignoring = ignore; await invoke("set_click_through", { ignore }); }
}, 33);

let dragged = false;
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragged = false;
  const startX = e.screenX, startY = e.screenY;
  const onMove = (m: MouseEvent) => {
    if (!dragged && Math.hypot(m.screenX - startX, m.screenY - startY) > 3) { dragged = true; getCurrentWindow().startDragging(); }
  };
  window.addEventListener("mousemove", onMove, { once: false });
  window.addEventListener("mouseup", () => {
    window.removeEventListener("mousemove", onMove);
    if (dragged) { canvas.animate([{ transform: "scaleY(0.85)" }, { transform: "scaleY(1)" }], { duration: 180 }); }
    else expanded = !expanded;
  }, { once: true });
});
canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); void invoke("show_context_menu"); });

void listen<string>("pet-menu", ({ payload }) => {
  if (payload === "dnd") model = { ...model, dnd: !model.dnd };
  if (payload.startsWith("size_")) { scale = Number(payload.slice(5)); localStorage.setItem("kitsune-scale", String(scale)); resize(); }
});

startClient({
  baseUrl: API,
  token: () => invoke<string>("read_pet_token"),
  fetch: window.fetch.bind(window),
  onSnapshot: (s) => { model = applySnapshot(model, s, Date.now()); },
  onEvent: (e) => { model = applyEvent(model, e, Date.now()); },
  onConnected: (c) => { model = setConnected(model, c, Date.now()); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});
```

(`#bubble` necesita `white-space: pre-line` en `index.html` para la vista expandida; agrégalo al estilo.)

- [ ] **Step 3: Compile checks (sin abrir ventanas)**

Run: `cd pet && npx tsc --noEmit && npx vitest run && npm run build && (cd src-tauri && cargo check)`
Expected: todo sin errores. **No** ejecutes `npm run tauri dev` ni `tauri build`: abrirían la ventana en el escritorio del usuario. Eso lo hace el controlador en B6.

- [ ] **Step 4: README**

Agrega a `README.md` una sección "Desktop pet (pet/)" con:
- requisitos (Rust y Xcode CLT);
- `cd pet && npm install && npm run sprites && npm run tauri dev`;
- `localApi.devOrigins: ["http://localhost:1420"]` para desarrollo;
- `npm run tauri build` para generar `Kitsune.app`;
- qué significa cada estado.

- [ ] **Step 5: Commit**

```bash
git add pet/src-tauri pet/src/main.ts pet/index.html README.md
git commit -F- <<'EOF'
feat(pet): ventana Tauri transparente, menú, token y clics que atraviesan

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task B6: Integración en vivo y demo (la hace el controlador)

**Files:** `docs/media/pet-demo.gif` y `README.md` (referencia al GIF).

- [ ] **Step 1:** Agregar `"localApi": { "devOrigins": ["http://localhost:1420"] }` a `~/.kitsune/config.json`, reconstruir el daemon (`npm run build` en la raíz) y reiniciarlo por PID.
- [ ] **Step 2:** `curl -s -H "x-kitsune-token: $(cat ~/.kitsune/pet-token)" http://127.0.0.1:47823/state` devuelve JSON. `curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://evil.example" http://127.0.0.1:47823/state` devuelve `403`.
- [ ] **Step 3:** `cd pet && npm run tauri dev` (en segundo plano, guardando el PID). Verificar con `screencapture` que el zorro aparece en la esquina, transparente y con la animación `idle` o `sleeping`. Medir criterios del spec: arranque < 2 s (tiempo hasta el primer cuadro visible) y RAM < 150 MB (`ps -o rss` del proceso de la mascota y su WebContent).

- [ ] **Step 4:** Provocar estados: una tarea asignada en ClickUp (`sniffing` y luego `alert` con burbuja), ✅ y elección de workflow (`working`), y detener el daemon (`offline`). Capturar cuadros con `screencapture -R` y armar `docs/media/pet-demo.gif` con ffmpeg.
- [ ] **Step 5:** Detener la mascota por PID y hacer el commit del GIF y el README.
