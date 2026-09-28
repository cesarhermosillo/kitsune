# Kitsune — Fase 1: del inbox de ClickUp a una sesión de Ronin, aprobada desde Telegram

**Fecha:** 2026-09-28 · **Estado:** propuesto · **Autor:** Cesar Hermosillo

## 1. Propósito

Kitsune es un agente personal ("mascota") que vigila tus canales de trabajo, te propone qué hacer y,
con tu aprobación, delega el trabajo de código en **Ronin** a través de MCP. Es un proyecto propio y
público, independiente de Ronin.

**Resultado de la Fase 1:** llega una tarea a tu inbox de ClickUp → Kitsune te la propone por
Telegram → tocas ✅ → se abre una sesión en Ronin → Kitsune te avisa si la sesión te pregunta algo y
cuando termina.

**Criterios de éxito:**
1. Una tarea asignada en ClickUp produce una propuesta en Telegram en menos de 2 minutos.
2. Con un solo ✅ se crea exactamente una sesión en Ronin, con el repo y el workflow propuestos.
3. Las preguntas de la sesión (`needsInput`) y su final (etapas completas, o gate fallido) llegan a
   Telegram, y una respuesta en el chat llega a la sesión.
4. Ningún contenido de ClickUp o Telegram puede crear ni cambiar nada sin tu aprobación explícita.

## 2. Alcance

**Dentro:** daemon local en tu Mac; conector de ClickUp (tareas asignadas, menciones y comentarios);
bot de Telegram (propuestas, aprobaciones, avisos, respuestas); motor configurable vía CLI headless
(`claude`, `codex`, `agy`); nuevas herramientas MCP en Ronin; persistencia local y auditoría.

**Fuera (fases posteriores, cada una con su propio spec):**

| Fase | Contenido |
|---|---|
| 2 | UI de mascota (app de escritorio o de barra de menú) y personalidad |
| 3 | Voz: hablarle y escucharla (Mac; notas de voz de Telegram) |
| 4 | App de iPhone, primero en la red local y luego online |
| 5 | Más conectores (Telegram como fuente, email; WhatsApp solo por la API de Business) |
| 6 | Reglas de autoaprobación en `policy` |

## 3. Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Arquitectura | Daemon independiente + MCP de Ronin | Ronin queda abierto a cualquier cliente MCP; Kitsune es un proyecto propio |
| Autonomía | Solo lee y propone; todo lo que crea o cambia algo requiere ✅ | Seguridad primero; las reglas llegan en la Fase 6 |
| Motor | CLIs en modo headless (`claude -p`, `codex exec`, `agy`) | Usa las suscripciones existentes, sin API keys ni costo extra |
| Disparadores | Tareas asignadas + menciones y comentarios | Cubre el trabajo nuevo y las conversaciones sobre él |
| Canal de aprobación | Bot de Telegram propio, limitado a un `chat_id` | Da el celular sin construir una app todavía |
| Stack | Node 22 + TypeScript, `node --test`, SQLite (`node:sqlite`) | Igual que Ronin; sin servidor de base de datos |

## 4. Arquitectura

```
ClickUp API ──poll──▶ ┌──────────── Kitsune (daemon Node/TS) ─────────────┐
                      │ connectors/clickup   → InboxEvent                  │
                      │ store (SQLite)       → cursores, propuestas, audit │
                      │ brain + engines/*    → Triage                      │
Telegram Bot API ◀───▶│ channels/telegram    → propuestas, avisos, chat    │
                      │ policy               → ¿requiere aprobación?       │
                      │ ronin-client (MCP)   → herramientas de Ronin       │
                      │ watcher              → estado de sesiones lanzadas │
                      └───────────────────────────┬────────────────────────┘
                                                  │ JSON-RPC POST /mcp + token de capability
                                            Ronin (servidor local)
```

### 4.1 Unidades

Cada unidad tiene una sola responsabilidad, una interfaz explícita y pruebas propias.

**`connectors/clickup`**
- Consulta la API REST v2 de ClickUp cada `poll.intervalSec` (60 por defecto).
- Emite `InboxEvent`:
  ```ts
  type InboxEvent = {
    source: "clickup"; id: string;            // id estable: `${kind}:${taskId}:${commentId?}`
    kind: "task_assigned" | "mention" | "comment";
    title: string; body: string; url: string;
    author: string; at: string;               // ISO-8601
    meta: { taskId: string; listId: string; listName: string; tags: string[] };
  };
  ```
- Guarda su cursor (la marca de tiempo del último evento visto) en `store`. No clasifica ni decide.

**`store`** (SQLite en `~/.kitsune/kitsune.db`)
- `events(id PK, source, kind, payload_json, seen_at, triage_json, triage_status)`
- `proposals(id PK, event_id, repo, workflow, request, status, telegram_message_id, created_at, updated_at, session_name, error)`
- `sessions(name PK, proposal_id, last_attention, last_stage, notified_done)`
- `audit(ts, actor, action, target, detail_json)`, donde `actor` es `kitsune`, `user` o `ronin`
- `cursors(source PK, value)`

**`brain` + `engines/*`**
- `brain.triage(event, catalog) → Triage`:
  ```ts
  type Triage =
    | { action: "propose_session"; repo: string; workflow: string; request: string; reason: string }
    | { action: "notify"; summary: string; reason: string }
    | { action: "ignore"; reason: string };
  ```
- `catalog` es la respuesta de `listar_repos_y_workflows` de Ronin. Una propuesta cuyo `repo` o
  `workflow` no esté en el catálogo se convierte en `notify`.
- Interfaz de cada motor: `Engine.complete(prompt: string, opts: { timeoutMs }) → Promise<string>`.
  - `claude`: `claude -p --output-format json` sin herramientas.
  - `codex`: `codex exec --json`.
  - `agy`: la invocación headless que documente su CLI. Si no existe, este adaptador queda fuera de
    la Fase 1.
- La salida se valida contra el esquema de `Triage`. Si es inválida o se agota el tiempo (60 s por
  defecto), el evento queda `triage_failed`.
- El prompt dice explícitamente que el contenido del evento son datos, no instrucciones. El motor
  corre sin herramientas: solo clasifica y redacta.

**`channels/telegram`**
- Long polling de `getUpdates`. Solo procesa mensajes y callbacks del `chat_id` configurado; lo
  demás se ignora y se audita.
- Envía:
  - **Propuesta**, con los botones ✅ Lanzar / ✏️ Editar / ❌ Ignorar.
  - **Aviso**, sin botones.
  - **Pregunta de sesión**: tu siguiente respuesta de texto en ese hilo se reenvía a la sesión.
  - **Resultado**: terminada, gate fallido, o error de lanzamiento con 🔁 Reintentar.
- El `callback_data` lleva el `proposal_id` y la acción; nunca parámetros ejecutables.

**`policy`**
- `policy.requiresApproval(action) → true` para toda acción que cree o cambie algo. En la Fase 1 no
  hay excepciones; el módulo existe para agregar reglas en la Fase 6.
- `policy.isAuthorized(update)` comprueba el `chat_id`.

**`ronin-client`**
- Cliente JSON-RPC 2.0 hacia `POST {ronin.url}/mcp`, con la cabecera de capability que ya usa Ronin.

**`watcher`**
- Cada 15 s consulta `estado_sesiones` para las sesiones lanzadas por Kitsune y emite avisos solo
  cuando cambia algo, usando `sessions.last_attention` y `last_stage` para no repetir.

### 4.2 Cambios en Ronin: herramientas MCP nuevas

Se agregan a `server/src/mcp.ts`, con las mismas reglas de origen local y capability que ya existen:

| Herramienta | Entrada | Salida |
|---|---|---|
| `listar_repos_y_workflows` | — | `{ repos: string[], workflows: { id, name, stages: string[] }[] }` |
| `crear_sesion` | `{ repo, workflowId, request, name?, origen? }` | `{ name, branch, worktree }` o error |
| `estado_sesiones` | `{ names?: string[] }` | `[{ name, workflow, stage, stagesDone, stagesTotal, attention, needsInput, question?, gate? }]` |
| `responder_sesion` | `{ name, text }` | `{ ok }`; solo para sesiones gestionadas cuya `attention` es `needsInput` |

- `crear_sesion` reutiliza `launchManagedSession` y rechaza repos o workflows fuera del catálogo.
- `origen` (por ejemplo `clickup:<taskId>`) se guarda en el `launch.json` para que la evidencia y el
  test harness de Ronin enlacen el ticket.
- `question` es la última línea significativa del pane conductor, acotada a 500 caracteres.

## 5. Flujo de datos

1. `clickup` emite un evento nuevo → `store.events` (si el id ya existe, se descarta).
2. `brain.triage` → según el resultado:
   - `propose_session`: crea `proposals(status=pending)` y envía la propuesta a Telegram.
   - `notify`: envía un aviso.
   - `ignore`: solo se audita.
3. Tocas ✅ → `policy.isAuthorized` → la propuesta pasa de `pending` a `approved` en una
   transacción; si ya no estaba `pending`, se responde "ya no está vigente" → `ronin-client.crear_sesion`
   → queda `launched` (con `session_name`) o `failed` (con `error`).
4. ✏️ → Kitsune pregunta qué cambiar (petición, repo o workflow, estos dos con opciones del catálogo)
   → actualiza la propuesta y vuelve a mostrarla con los mismos botones.
5. ❌ → `rejected`.
6. Las propuestas sin respuesta pasan a `expired` a las `proposals.ttlHours` (24 por defecto) y sus
   botones responden "expirada".
7. `watcher` detecta `needsInput` → envía la pregunta → tu respuesta pasa por `responder_sesion`.
   Detecta el final o un gate fallido → envía el resultado y marca `notified_done`.

**Estados de una propuesta:**
`pending → approved → launched | failed`, `pending → rejected`, `pending → expired`,
`failed → approved` (con 🔁 Reintentar).

## 6. Configuración

`~/.kitsune/config.json` (sin secretos; los valores son de ejemplo):

```json
{
  "engine": "claude",
  "poll": { "intervalSec": 60 },
  "clickup": { "teamId": "9012345678", "listIds": ["901200000001"] },
  "telegram": { "chatId": 123456789 },
  "ronin": { "url": "http://localhost:8787" },
  "proposals": { "ttlHours": 24 }
}
```

`~/.kitsune/.env` (permisos `0600`): `CLICKUP_TOKEN`, `TELEGRAM_BOT_TOKEN`, `RONIN_CAPABILITY_TOKEN`.
Si el archivo no tiene esos permisos, Kitsune no arranca y lo dice.

## 7. Errores

| Falla | Comportamiento |
|---|---|
| ClickUp o Telegram no responden | Reintentos con espera exponencial (máx. 5 min). Tras 5 fallos seguidos, aviso por el otro canal o en el log |
| Motor: salida inválida o timeout | El evento queda `triage_failed` y llega como aviso con el texto original; nunca se lanza nada |
| Ronin rechaza o no responde | La propuesta queda `failed` con el motivo, y llega el botón 🔁 |
| Reinicio del daemon | Retoma desde los cursores y el estado en SQLite; no reenvía propuestas ya enviadas |
| `chat_id` ajeno | Se ignora y se audita; no se responde |

## 8. Seguridad

- Los secretos solo viven en `.env`. Nunca aparecen en logs, prompts, la base de datos ni el repo.
- Todo lo que viene de ClickUp o Telegram se trata como datos. Como mucho produce una propuesta que
  tú apruebas.
- El motor corre sin herramientas y con timeout.
- Ronin sigue aceptando solo origen local + capability, y `crear_sesion` solo acepta el catálogo.
- Hay auditoría completa de cada evento, propuesta, aprobación y llamada a Ronin.

## 9. Pruebas

TDD con `node --test`:
- **Unitarias**:
  - `connectors/clickup` con respuestas grabadas.
  - `brain` con un motor falso: JSON válido, inválido, timeout, repo fuera del catálogo.
  - `policy`.
  - La máquina de estados de las propuestas, incluidos el doble ✅ y la expiración.
  - `watcher`, sin avisos repetidos.
- **Contrato MCP**:
  - En Ronin, una prueba por cada herramienta nueva.
  - En Kitsune, pruebas contra un servidor MCP falso con el mismo esquema.
- **Telegram**: interfaz `Channel` con un doble en las pruebas; prueba manual con el bot real antes
  de publicar.
- **End-to-end local**: evento de ClickUp falso → aprobación simulada → sesión real en un Ronin
  aislado (puerto y servidor de tmux propios, repo `todo-api`).

## 10. Entregables de la Fase 1

1. PR en Ronin: las 4 herramientas MCP con sus pruebas y la documentación en el README.
2. El repo `kitsune`: daemon, conectores, Telegram, motores `claude` y `codex` (`agy` si su CLI lo
   permite), pruebas, README en inglés y guía para crear el bot de Telegram.
3. Un demo grabado: tarea en ClickUp → aprobación en Telegram → sesión en Ronin → aviso de final.
