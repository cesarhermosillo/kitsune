# Acciones desde la mascota: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lanzar, ignorar y reintentar propuestas desde la burbuja de la mascota, con confirmación en dos pasos, usando la misma lógica y el mismo candado atómico que Telegram.

**Architecture:** En el daemon, `app.ts` expone cuatro operaciones públicas (`workflowOptions`, `launchProposal`, `rejectProposal`, `retryProposal`) construidas sobre helpers internos que también usan los callbacks de Telegram. `local-api.ts` recibe un puerto `actions` y agrega rutas `GET`/`POST` bajo `/proposals/:id/…`. En la mascota, un cliente `api.ts` hace las llamadas, `flow.ts` es un reductor puro con las vistas de la burbuja y `main.ts` las pinta con botones `data-act` y un listener delegado.

**Tech Stack:** Node ≥ 22.13 + TypeScript (`node --test`), Tauri 2 + Vite + TypeScript (vitest).

**Spec:** `docs/superpowers/specs/2026-09-29-mascota-acciones-design.md`

## Global Constraints

- Worktree: `/Users/cesarhermosillo/code/kitsune-acciones`, rama `feat/mascota-acciones`. En esta máquina corren un daemon real (PID en `~/.kitsune/kitsune.pid`, desde `~/code/kitsune`) y `Kitsune.app`: no los detengas, no toques `~/.kitsune`, no ejecutes `kitsune start`/`doctor`, no abras ventanas Tauri, no uses el puerto 47823 en pruebas y nunca uses `git stash`.
- Selección de workflow **por id**. Una sesión como máximo por propuesta, sin importar el canal.
- API: solo `127.0.0.1`, token y lista blanca de `Origin` sin cambios. Cuerpo JSON de 4 KB como máximo (413 si se pasa), `content-type: application/json` obligatorio en `POST /launch` (415 si falta). Preflight: `access-control-allow-methods: GET, POST` y `access-control-allow-headers: x-kitsune-token, content-type`.
- Códigos HTTP: 200 ok · 404 `not_found` · 409 `not_pending`/`expired` · 400 `unknown_workflow`/cuerpo inválido · 413 · 415 · 503 `ronin_unavailable` · 502 `launch_failed`. Los errores responden JSON `{ code, message }`.
- Mensajes al usuario en español. En la mascota, todo el texto con `textContent` (nunca `innerHTML`).
- Commits: asunto convencional, línea en blanco y exactamente `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No hacer push.

## Review Focus

- **Doble lanzamiento entre canales:** ✅ en Telegram y "Sí, lanzar" en la mascota sobre la misma propuesta → una sola sesión. El segundo responde "Ya no está vigente" (Telegram) o 409 `not_pending` (API). Prueba: Task 1.
- **Catálogo reordenado entre mostrar y confirmar:** se lanza el workflow elegido (por id), nunca otro. Un id que ya no existe → 400 `unknown_workflow`. Prueba: Task 1.
- **Ronin caído al pedir opciones o al lanzar:** 503 `ronin_unavailable`, la propuesta sigue pendiente y nada se lanza. Prueba: Tasks 1 y 3.
- **Cuerpo enorme o que no es JSON:** 413/415/400 sin tumbar el daemon. Prueba: Task 3.
- **Doble clic en "Sí, lanzar":** la vista pasa a `busy` sin botones antes de la llamada, así que el segundo clic no encuentra botón. Prueba: Task 5.

---

### Task 1: Acciones compartidas en `app.ts`

**Files:**
- Modify: `src/app.ts`
- Test: `src/app.test.ts`

**Interfaces (Produces):**

```ts
export type Via = "pet" | "telegram";
export interface WorkflowChoice { id: string; name: string; suggested: boolean; favorite: boolean; dangerous: boolean; group: "main" | "other" }
export type ActionError = { ok: false; code: "not_found" | "not_pending" | "expired" | "unknown_workflow" | "ronin_unavailable" | "launch_failed"; message: string };
export type LaunchResult = { ok: true; status: "launched"; sessionName: string } | ActionError;
export type RejectResult = { ok: true; status: "rejected" } | ActionError;
export type OptionsResult = { ok: true; title: string; choices: WorkflowChoice[] } | ActionError;
// KitsuneApp gana:
workflowOptions(id: string): Promise<OptionsResult>;
launchProposal(id: string, workflowId: string, via: Via): Promise<LaunchResult>;
rejectProposal(id: string, via: Via): Promise<RejectResult>;
retryProposal(id: string, via: Via): Promise<LaunchResult>;
```

Mensajes (`message`):
- `not_found`: "La propuesta no existe"
- `not_pending`: "Ya no está vigente"
- `expired`: "Expirada"
- `unknown_workflow`: "Ese workflow ya no existe en Ronin"
- `ronin_unavailable`: "Ronin no responde, intenta de nuevo"
- `launch_failed`: el error de la propuesta, por ejemplo "Ronin no responde"

**Reglas:**
- **Estado de la propuesta:**
  - `p` inexistente → `not_found`.
  - `p.status === "expired"` → `expired`.
  - Para `launch` y `reject`, cualquier estado distinto de `pending` → `not_pending`.
  - Para `retry`, cualquier estado distinto de `failed` → `not_pending`.
  - `InvalidTransition` (una carrera con otro canal) → `not_pending`.
- **Catálogo:** si `ronin.catalog()` lanza en `workflowOptions` o `launchProposal` → `ronin_unavailable`, y la propuesta no cambia.
- **Opciones:**
  - `main` = el sugerido (si no es favorito) y luego los favoritos presentes, en su orden. Es la misma regla que `favoriteWorkflowOptions`.
  - `other` = el resto del catálogo, en su orden.
  - `dangerous` = `hasMergeDeploy`.
  - `title = p.title || p.origin`.
- **Lanzamiento:**
  - Se extraen dos helpers internos: `launchWith(p, wf, via)`, que hace `store.approveWith` + `launch()` + auditoría `{ via, workflow }`, y `doReject(p, via)`, que hace transition `rejected` desde `pending` + emit + edit "❌ Ignorada" + auditoría.
  - El callback `launch_with` de Telegram conserva su validación por índice y *check*, y después llama a `launchWith(p, wf, "telegram")`.
  - `retry` usa un helper `doRetry(p, via)`.
  - Después de `launch()`, el resultado se lee de `store.getProposal`: si está `launched` → `{ ok: true, status: "launched", sessionName }`; si no → `launch_failed` con `p.error`.
- **Auditoría:** `store.audit("user", "launch" | "reject" | "retry", id, { via, workflow? }, now)`.

- [ ] **Step 1: Write the failing tests** (agregar a `src/app.test.ts`; reutiliza `harness`, `EVENT`, `CATALOG` y los fakes existentes. Si el harness no permite favoritos o un Ronin que falla, agrégale parámetros opcionales mínimos)

```ts
test("workflowOptions: sugerido y favoritos en main, resto en other, con dangerous", async () => {
  // catálogo con wf-1 plan-tdd-evidencia (sugerido), wf-2 hotfix (stages incluye "merge"), favoritos ["hotfix"]
  // esperado main: [plan-tdd-evidencia (suggested), hotfix (favorite, dangerous)], other: el resto
});
test("launchProposal por id lanza una vez y deja la propuesta launched", async () => { /* ok + sessionName */ });
test("launchProposal con workflowId inexistente → unknown_workflow y la propuesta sigue pending", async () => {});
test("launchProposal con Ronin caído en catalog → ronin_unavailable y sigue pending", async () => {});
test("launchProposal cuando createSession falla → launch_failed y la propuesta queda failed", async () => {});
test("doble lanzamiento entre canales: API y luego ✅ de Telegram → una sola sesión", async () => {});
test("doble lanzamiento entre canales: ✅ de Telegram y luego API → not_pending", async () => {});
test("rejectProposal ignora, edita Telegram y emite proposal_resolved rejected; segunda vez → not_pending", async () => {});
test("retryProposal solo desde failed; desde pending → not_pending", async () => {});
test("propuesta inexistente → not_found; expirada → expired", async () => {});
test("audita via pet/telegram", async () => {});
```

Escribe el cuerpo completo de cada prueba siguiendo el patrón de las que ya existen en `app.test.ts`: `h.app.onInboxEvent(EVENT)` para crear la propuesta, `h.store.listPending()[0]` para obtenerla y los fakes de Ronin y channel para afirmar llamadas y ediciones. Cada prueba debe afirmar el `code`/`status` exacto y el conteo de `createSession`.

- [ ] **Step 2:** Run `node --import tsx --test src/app.test.ts` → FAIL.
- [ ] **Step 3: Implement** según las reglas. No cambies el comportamiento de los callbacks de Telegram: todas las pruebas existentes deben seguir pasando.
- [ ] **Step 4:** Run `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: acciones compartidas para lanzar, ignorar y reintentar propuestas`.

---

### Task 2: `/state` con propuestas fallidas recientes

**Files:**
- Modify: `src/store.ts` (`listRecentFailed`), `src/state.ts` (`PendingItem.status`)
- Test: `src/store.test.ts`, `src/state.test.ts`

**Interfaces:**
- `Store.listRecentFailed(since: number): Proposal[]` devuelve las propuestas con `status = 'failed' AND updated_at >= since`, ordenadas por `created_at`.
- `PendingItem` gana `status: "pending" | "failed"`.
- `createStateTracker` recibe `now?: () => number` (por defecto `Date.now`). `pending` = `listPending()` (con `status: "pending"`) seguido de `listRecentFailed(now() - 24h)` (con `status: "failed"`).

- [ ] **Step 1: Tests:**
  - `listRecentFailed` incluye una fallida reciente y excluye una de hace más de 24 h.
  - La foto de estado lista la pendiente con `status: "pending"` y la fallida con `status: "failed"`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** `npm test && npm run typecheck` PASS.
- [ ] **Step 5: Commit** `feat: /state incluye propuestas fallidas recientes para poder reintentarlas`.

---

### Task 3: Endpoints de acciones en la API local

**Files:**
- Modify: `src/local-api.ts`, `src/cli.ts`, `README.md` (sección Local API)
- Test: `src/local-api.test.ts`

**Interfaces:**

```ts
export interface LocalActions {
  options(id: string): Promise<OptionsResult>;
  launch(id: string, workflowId: string): Promise<LaunchResult>;
  reject(id: string): Promise<RejectResult>;
  retry(id: string): Promise<LaunchResult>;
}
// LocalApiOptions gana: actions?: LocalActions  (sin actions, las rutas nuevas responden 404)
```

**Rutas:** `^/proposals/([a-z0-9]{10})/(options|launch|reject|retry)$`.
- `options` solo acepta `GET`.
- `launch`, `reject` y `retry` solo aceptan `POST`.
- Un método incorrecto → 405.

**Cuerpo (solo `launch`):**
- Se lee hasta 4096 bytes; si se pasa → 413 y se destruye la petición.
- `content-type` debe empezar con `application/json`, si no → 415.
- JSON inválido o `workflowId` que no es string no vacío → 400 `{ code: "bad_request", message: "Cuerpo inválido" }`.

**Mapeo de resultados:**
- `ok` → 200 con el resultado (sin `ok`): `{ status, sessionName? }` o `{ title, choices }`.
- `not_found` → 404.
- `not_pending` / `expired` → 409.
- `unknown_workflow` → 400.
- `ronin_unavailable` → 503.
- `launch_failed` → 502.

Los errores responden `{ code, message }`, con los textos acotados a 500.

**Estructura:** `handle` pasa a ser `async`. El `createServer` hace `handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); })` y mantiene el try/catch síncrono. El orden `Origin` → OPTIONS → token no cambia. El preflight OPTIONS responde `access-control-allow-methods: GET, POST` y `access-control-allow-headers: x-kitsune-token, content-type`.

**Cableado en `cli.ts`:** `actions: { options: (id) => k.app.workflowOptions(id), launch: (id, wf) => k.app.launchProposal(id, wf, "pet"), reject: (id) => k.app.rejectProposal(id, "pet"), retry: (id) => k.app.retryProposal(id, "pet") }`.

- [ ] **Step 1: Tests** (con un `LocalActions` falso que registra las llamadas):
  - `GET /options` → 200 con choices.
  - `POST /launch` con JSON → 200 y el falso recibió `(id, workflowId)`.
  - `POST /launch` sin content-type → 415.
  - Cuerpo de 5000 bytes → 413.
  - JSON roto → 400.
  - Resultados `not_pending` → 409, `expired` → 409, `not_found` → 404, `unknown_workflow` → 400, `ronin_unavailable` → 503, `launch_failed` → 502, cada uno con `{ code, message }`.
  - `GET /launch` → 405.
  - `POST` con `Origin` ajeno → 403 y el falso no se llamó.
  - `POST` sin token → 401 y el falso no se llamó.
  - Preflight de un origen permitido lista `POST` y `content-type`.
  - Sin `actions` → 404.
  - Un id con formato inválido (`/proposals/../launch`) → 404.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** `npm test && npm run typecheck && npm run build` PASS.
- [ ] **Step 5: Commit** `feat: la API local permite lanzar, ignorar y reintentar propuestas`.

---

### Task 4: Mascota: tipos, modelo y cliente de acciones

**Files:**
- Modify: `pet/src/types.ts` (`PendingItem.status`), `pet/src/model.ts` (`proposal_created` → `status: "pending"`; `proposal_resolved` con `failed` → marca `status: "failed"` sin quitarla; `launched`/`rejected`/`expired` → la quita)
- Create: `pet/src/api.ts`
- Test: `pet/src/model.test.ts`, `pet/src/api.test.ts`

**Interfaces:**

```ts
// pet/src/api.ts
export interface WorkflowChoice { id: string; name: string; suggested: boolean; favorite: boolean; dangerous: boolean; group: "main" | "other" }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };
export interface ApiDeps { baseUrl: string; token: () => Promise<string>; fetch: typeof fetch }
export function apiCall<T>(deps: ApiDeps, method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>>;
export const getOptions: (deps: ApiDeps, id: string) => Promise<ApiResult<{ title: string; choices: WorkflowChoice[] }>>;
export const launchProposal: (deps: ApiDeps, id: string, workflowId: string) => Promise<ApiResult<{ status: "launched"; sessionName: string }>>;
export const rejectProposal: (deps: ApiDeps, id: string) => Promise<ApiResult<{ status: "rejected" }>>;
export const retryProposal: (deps: ApiDeps, id: string) => Promise<ApiResult<{ status: "launched"; sessionName: string }>>;
```

**`apiCall`:**
- Envía siempre `x-kitsune-token`. Con body, además `content-type: application/json` y `JSON.stringify(body)`. Usa `signal: AbortSignal.timeout(150_000)`.
- Si la red falla o se agota el tiempo → `{ ok: false, status: 0, code: "unreachable", message: "Kitsune no responde" }`.
- Si la respuesta no es 2xx → intenta leer `{ code, message }` del JSON; si no puede, usa `code: "http_<status>"` y `message: "Error <status>"`.
- Si es 2xx → `{ ok: true, data: json }`.

- [ ] **Step 1: Tests:**
  - `apiCall` manda token y content-type y devuelve `data` en 200.
  - En 409 devuelve el `code`/`message` del cuerpo.
  - Si `fetch` lanza → `unreachable`.
  - Modelo: `proposal_resolved` con `failed` conserva el item con `status: "failed"`; con `launched` lo quita.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** `cd pet && npx vitest run && npx tsc --noEmit` PASS.
- [ ] **Step 5: Commit** `feat(pet): cliente de acciones y propuestas fallidas en el modelo`.

---

### Task 5: Mascota: flujo de la burbuja (reductor puro)

**Files:**
- Create: `pet/src/flow.ts`
- Test: `pet/src/flow.test.ts`

**Interfaces y código:**

```ts
import type { ApiResult, WorkflowChoice } from "./api";

export type Flow =
  | { view: "list" }
  | { view: "choose"; proposalId: string; title: string; choices: WorkflowChoice[]; showOther: boolean }
  | { view: "confirm"; kind: "launch"; proposalId: string; title: string; workflow: WorkflowChoice }
  | { view: "confirm"; kind: "reject"; proposalId: string; title: string }
  | { view: "busy"; label: string }
  | { view: "result"; ok: boolean; text: string };

export type FlowAction =
  | { type: "open_choose"; proposalId: string; title: string; choices: WorkflowChoice[] }
  | { type: "show_other" }
  | { type: "pick"; workflowId: string }
  | { type: "ask_reject"; proposalId: string; title: string }
  | { type: "busy"; label: string }
  | { type: "done"; ok: boolean; text: string }
  | { type: "cancel" };

export const LIST: Flow = { view: "list" };

export function flowReducer(f: Flow, a: FlowAction): Flow {
  switch (a.type) {
    case "open_choose": return { view: "choose", proposalId: a.proposalId, title: a.title, choices: a.choices, showOther: false };
    case "show_other": return f.view === "choose" ? { ...f, showOther: true } : f;
    case "pick": {
      if (f.view !== "choose") return f;
      const workflow = f.choices.find((c) => c.id === a.workflowId);
      return workflow ? { view: "confirm", kind: "launch", proposalId: f.proposalId, title: f.title, workflow } : f;
    }
    case "ask_reject": return { view: "confirm", kind: "reject", proposalId: a.proposalId, title: a.title };
    case "busy": return { view: "busy", label: a.label };
    case "done": return { view: "result", ok: a.ok, text: a.text };
    case "cancel": return LIST;
  }
}

export function visibleChoices(f: Extract<Flow, { view: "choose" }>): WorkflowChoice[] {
  return f.choices.filter((c) => c.group === "main" || f.showOther);
}

export function choiceLabel(c: WorkflowChoice): string {
  return `${c.suggested ? "⭐ " : ""}${c.name}${c.dangerous ? " ⚠️ merge/deploy" : ""}`;
}

export function confirmText(f: Extract<Flow, { view: "confirm" }>): { question: string; yes: string; danger: boolean } {
  if (f.kind === "reject") return { question: `¿Ignorar «${f.title}»?`, yes: "Sí, ignorar", danger: false };
  return {
    question: `¿Lanzar «${f.title}» con ${f.workflow.name}?`,
    yes: f.workflow.dangerous ? "Sí, lanzar (hace merge/deploy)" : "Sí, lanzar",
    danger: f.workflow.dangerous,
  };
}

export function resultText(r: ApiResult<{ status: string; sessionName?: string }>): { ok: boolean; text: string } {
  if (r.ok) return r.data.status === "rejected" ? { ok: true, text: "❌ Ignorada" } : { ok: true, text: `✅ Sesión ${r.data.sessionName} creada` };
  if (r.code === "launch_failed") return { ok: false, text: `⚠️ No se pudo lanzar: ${r.message}` };
  return { ok: false, text: `⚠️ ${r.message}` };
}
```

- [ ] **Step 1: Tests** (`pet/src/flow.test.ts`):
  - `open_choose` → `choose` con `showOther: false`, y `visibleChoices` devuelve solo `main`.
  - `show_other` → incluye `other`.
  - `pick` de un id existente → `confirm` de tipo launch; `pick` de un id inexistente → sin cambio.
  - `confirmText` peligroso → `yes` con "(hace merge/deploy)" y `danger: true`; normal → "Sí, lanzar".
  - `ask_reject` → `confirmText` "¿Ignorar «t»?".
  - `busy` → vista sin elecciones.
  - `resultText`: lanzada, ignorada, `launch_failed` y `not_pending` ("⚠️ Ya no está vigente").
  - `cancel` → `LIST`.
  - `choiceLabel` con ⭐ y ⚠️.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (el código de arriba). **Step 4:** `cd pet && npx vitest run && npx tsc --noEmit` PASS.
- [ ] **Step 5: Commit** `feat(pet): flujo de la burbuja para lanzar, ignorar y reintentar`.

---

### Task 6: Mascota: pintar el flujo en la burbuja

**Files:**
- Modify: `pet/src/main.ts`, `pet/src/expanded.ts` (las filas `clickup` ganan `proposalId` y `status`), `pet/src/expanded.test.ts`, `pet/index.html` (estilos de botones)

**Comportamiento:**
- Estado local `let flow: Flow = LIST`. Cambiar `flow` marca la burbuja para volver a pintarse: usa el mecanismo *dirty* que ya existe y nunca reconstruyas el DOM en cada cuadro. Al cerrar la burbuja (`expanded = false`) → `flow = LIST`.
- Cada vista:
  - **`list`:** lo de hoy (resumen y filas). Cada propuesta lleva además botones `<button data-act="launch-open" data-id>` "🚀 Lanzar…" y `data-act="reject-ask"` "❌ Ignorar". Si está fallida: `data-act="retry"` "🔁 Reintentar" y `data-act="reject-ask"`.
  - **`choose`:** título, un botón `data-act="pick" data-wf` por cada `visibleChoices` (con `choiceLabel`), "Otro…" (`data-act="other"`) si todavía no se muestran todos, y "Cancelar" (`data-act="cancel"`).
  - **`confirm`:** `confirmText().question` y los botones `data-act="confirm"` (clase `danger` si `danger`) y `data-act="cancel"`.
  - **`busy`:** solo el texto (`label`).
  - **`result`:** el texto. A los 4 s → `flow = LIST`.
- Listener delegado en `#bubble`: `closest("[data-act]")`, `preventDefault` y luego:
  - `launch-open` → `busy` "Cargando workflows…" → `getOptions`. Si sale bien → `open_choose`; si no → `done(resultText(r))`.
  - `reject-ask` → `ask_reject` (usa el título de la fila).
  - `retry` → `busy` "Lanzando…" → `retryProposal` → `done(resultText)`.
  - `other` → `show_other`; `pick` → `pick`; `cancel` → `cancel`.
  - `confirm`:
    - Si es de tipo launch → `busy` "Lanzando…" → `launchProposal(id, workflow.id)` → `done`.
    - Si es de tipo reject → `busy` "Ignorando…" → `rejectProposal` → `done`.
  - Los enlaces existentes (`a[data-kind]`) siguen funcionando igual.
- `ApiDeps`: `{ baseUrl: API, token: () => invoke("read_pet_token"), fetch: window.fetch.bind(window) }`.
- CSS en `index.html`:
  - `#bubble button { font: inherit; font-size: 11px; margin: 4px 4px 0 0; padding: 2px 8px; border: 1.5px solid #1a1426; border-radius: 999px; background: #fff; color: #1a1426; cursor: pointer; }`
  - `#bubble button.danger { background: #d64545; color: #fff; border-color: #8a1f1f; }`
  - `#bubble .row { margin-top: 6px; }`

- [ ] **Step 1:** Tests de `expanded.ts`: las filas `clickup` incluyen `proposalId` y `status`.
- [ ] **Step 2:** Implementar `main.ts`, `expanded.ts` e `index.html`.
- [ ] **Step 3:** `cd pet && npx vitest run && npx tsc --noEmit && npm run build` y `(cd src-tauri && cargo check)` PASS. **No** abras ventanas: la verificación en vivo la hace el controlador.
- [ ] **Step 4: Commit** `feat(pet): botones para lanzar, ignorar y reintentar en la burbuja`.
