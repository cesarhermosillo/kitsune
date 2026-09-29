# Kitsune — Fase 2a: la mascota de escritorio (pixel art animado)

**Fecha:** 2026-09-29 · **Estado:** propuesto · **Autor:** Cesar Hermosillo

## 1. Propósito

Darle a Kitsune una cara: un zorro kitsune en pixel art que vive en el escritorio, siempre al frente,
y **anima en tiempo real lo que pasa** en Kitsune y en las sesiones de Ronin. Por ejemplo: hay una
propuesta nueva, una sesión está trabajando, una sesión te pregunta algo o una sesión terminó. Se
inspira en Codex Pets, pero conectado a tu flujo ClickUp → Telegram → Ronin.

La Fase 2 se divide en tres subproyectos, cada uno con su propio spec y plan:

| Subproyecto | Contenido |
|---|---|
| **2a (este)** | Mascota, animaciones por estado, burbujas y la API local del daemon |
| 2b | Chat escrito con la mascota: órdenes interpretadas por el motor, y toda acción con confirmación |
| 2c | Voz: hablarle y que responda |

**Criterios de éxito de 2a:**
1. La mascota arranca en menos de 2 s, usa menos de 150 MB de RAM y deja pasar los clics por sus zonas transparentes.
2. Cada evento de Kitsune se refleja en la mascota en menos de 1 s: una propuesta nueva, una sesión
   que trabaja, pregunta, termina o muere, un error.
3. Si el daemon no corre, la mascota lo muestra (`offline`) y se reconecta sola.
4. La API local no expone secretos y no acepta peticiones sin token ni desde un navegador.

## 2. Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Arte | Sprites dibujados en código (matrices de caracteres → PNG con un script) | 100% propio (MIT), reproducible y fácil de iterar |
| Ventana | Tauri 2 | Ventana transparente, siempre al frente, ~10 MB y poca RAM. Ya tienes Rust 1.95 y tu equipo usa Tauri |
| Conexión | API local del daemon (HTTP + SSE) con token | Desacopla, reacciona al instante y sirve de base para 2b y 2c |
| Plataforma de prueba | macOS | Es tu equipo. Tauri permite Windows y Linux más adelante |

## 3. El personaje

- **Sprite:** 32×32 px, se dibuja a 4× (128 px) con escalado nearest-neighbor. La escala se elige
  entre 2×, 3× y 4×.
- **Paleta:** unos 12 colores (naranjas, crema, blanco, contorno oscuro y un acento morado `#9184d9`
  como el samurái de Ronin).
- **Diseño:** un zorro kitsune de tres colas, sentado de tres cuartos.
- **Estados y animaciones:** bucles de 4 a 8 cuadros a 6–8 fps.

| Estado | Cuándo | Animación | Burbuja |
|---|---|---|---|
| `sleeping` | Nada pendiente ni sesiones activas | Enroscado, respira, "z z" | — |
| `idle` | Daemon activo, vigilando | Sentado, parpadea, mueve las colas | — |
| `sniffing` | Clasificando un evento | Olfatea el suelo | "Revisando…" |
| `alert` | Hay una propuesta pendiente | Orejas arriba, salto, "!" | "Nueva tarea: <título>" |
| `working` | Una sesión seguida está trabajando | Teclea en una laptop, puntos animados | "<sesión> · <etapa> <n>/<total>" |
| `asking` | Una sesión espera tu respuesta | Ladea la cabeza, "?" | La pregunta (≤ 140 caracteres) |
| `celebrate` | Una sesión terminó (evento puntual de unos 3 s) | Un giro y chispas | "✅ <sesión> terminó" |
| `sad` | Gate fallido, sesión muerta o Ronin caído | Orejas abajo, gota | Motivo corto |
| `offline` | No hay conexión con el daemon | Gris, 50% de opacidad | "Kitsune no está corriendo" |

- **Prioridad** cuando coinciden varios estados: `asking` > `alert` > `sad` > `working` > `sniffing` > `idle` > `sleeping`.
  `celebrate` se superpone y al terminar vuelve al estado calculado. `offline` gana a todos.

## 4. La ventana y la interacción

- Tauri 2 con ventana `transparent`, `decorations: false`, `alwaysOnTop`, `skipTaskbar` y sin sombra. En macOS
  la política de activación es `accessory`: sin ícono en el Dock y con ícono en la barra de menú.
- Mide unos 220×220 px: el zorro abajo y la burbuja arriba. Los clics pasan a través salvo sobre el
  zorro o la burbuja. Mientras la ventana ignora eventos no recibe el movimiento del mouse, así que
  Rust consulta la posición global del cursor unas 30 veces por segundo (`cursor_position`). La
  interfaz decide si ese punto cae sobre un píxel opaco del sprite o sobre la burbuja, y con eso
  alterna `setIgnoreCursorEvents`.
- **Posición:** por defecto en la esquina inferior derecha. Se puede arrastrar y la posición se guarda.
- **Interacción:**
  - Pasar el mouse: burbuja con un resumen, por ejemplo "2 sesiones trabajando · 1 propuesta pendiente".
  - Clic: burbuja expandida con la lista de pendientes y los enlaces a ClickUp y Ronin. Solo muestra; en 2a no hay acciones.
  - Clic derecho o menú de la barra superior: Ocultar/Mostrar, No molestar, Abrir Ronin, Tamaño y Salir.
  - Soltar después de arrastrar: animación corta de caída.
- **Discreción:**
  - Las burbujas se ocultan solas a los 6 s, salvo `asking`.
  - "No molestar" mantiene al zorro enroscado y silencia las alertas.
  - Los sonidos están apagados por defecto.

## 5. API local del daemon

- Nuevo módulo `src/local-api.ts`. Escucha en `127.0.0.1` y en el puerto `localApi.port` (por defecto
  `47823`). Nunca escucha en `0.0.0.0`.
- **Autenticación:**
  - Al arrancar, el daemon crea `~/.kitsune/pet-token` (32 bytes aleatorios en hex, permisos `0600`)
    si no existe.
  - Toda petición debe traer la cabecera `x-kitsune-token`, que se compara en tiempo constante.
  - Se rechaza toda petición con cabecera `Origin`, para que ninguna página web pueda consultarla.
- **Endpoints:**
  - `GET /state` → `{ status, pending: [{ id, title, url, repo, workflow, createdAt }], sessions: [{ name, workflow,
    stage, stagesDone, stagesTotal, needsInput, question? }], lastError?: { message, at } }`. Cada texto se acota
    a 500 caracteres.
  - `GET /events` → stream SSE con eventos
    `{ type, at, ... }`, donde `type` es uno de `event_triaged | proposal_created | proposal_resolved |
    session_update | session_question | session_done | session_dead | error`, más un latido cada 15 s.
- **Fuente de los eventos:** un `EventBus` interno. `app.ts` y `watcher.ts` publican en los mismos
  puntos donde hoy envían mensajes a Telegram. El bus no tiene historial: un cliente que se reconecta
  pide `/state`.
- **Qué se expone:** lo mismo que ya llega a Telegram (títulos, repos, resúmenes, etapas). Nunca
  tokens, rutas de configuración ni el contenido crudo de ClickUp.

## 6. La app de la mascota

- Vive en `pet/`, dentro del repo de Kitsune, como proyecto Tauri 2: `pet/src` en TypeScript con Canvas 2D
  y `pet/src-tauri` en Rust mínimo.
- **Sprites:**
  - `pet/art/*.ts` define la paleta y los cuadros como matrices de caracteres.
  - `npm run sprites` genera `pet/public/sprites.png` y `sprites.json`.
  - La página `npm run preview` muestra todas las animaciones para revisarlas.
- **Rust (mínimo):**
  - Crear la ventana con sus flags y el ícono de la barra de menú con su menú.
  - Un comando `read_pet_token`, que solo lee `~/.kitsune/pet-token`.
  - Recordar la posición de la ventana.
  - Alternar `setIgnoreCursorEvents`.
- **TypeScript:**
  - Cliente de `/state` y `/events` (`fetch` + un lector de SSE).
  - Reductor de eventos a estado y función de prioridad.
  - Reproductor de animaciones y burbujas.
- **Si el daemon no responde:** estado `offline`. Reintenta cada 5 s durante el primer minuto y luego
  cada 30 s. Al reconectar pide `/state` completo.

## 7. Errores y seguridad

- La API se cae o el puerto está ocupado: el daemon registra el error y sigue funcionando por Telegram.
  La API es opcional y no puede tumbar el daemon.
- Token inexistente o ilegible: la mascota se muestra `offline` con el motivo en la burbuja.
- La mascota nunca escribe en `~/.kitsune`, salvo su posición (en su propio directorio de datos de Tauri).
- La API no tiene endpoints que modifiquen nada en 2a. Eso llega en 2b, con confirmación.

## 8. Pruebas

- **Daemon (`node --test`):**
  - Sin token, con token incorrecto o con `Origin` → 401/403.
  - `/state` refleja la base (propuestas pendientes y sesiones seguidas).
  - Los eventos publicados en el bus llegan por SSE, y el latido también.
  - Ninguna respuesta contiene los valores de los secretos.
  - Si el puerto está ocupado, el daemon no se cae.
- **Mascota (`vitest`):**
  - Función de prioridad para cada combinación de estados.
  - Reductor de eventos.
  - `celebrate` es puntual y regresa al estado calculado.
  - Reconexión y `offline`.
  - La hoja de sprites tiene todos los cuadros de cada estado, del tamaño correcto y solo con colores de la paleta.
  - El generador es determinista.
- **Revisión visual:** capturas de cada animación en la página de preview antes de integrar, y un GIF
  de la mascota real para el README.

## 9. Fuera de este subproyecto

Chat (2b), voz (2c), aprobar o responder desde la mascota, las colas que crecen como nivel, builds
firmados y notarizados, y Windows/Linux.
