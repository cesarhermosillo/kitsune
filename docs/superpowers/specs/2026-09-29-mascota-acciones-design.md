# Kitsune — Acciones desde la mascota: lanzar, ignorar y reintentar

**Fecha:** 2026-09-29 · **Estado:** aprobado en conversación · **Autor:** Cesar Hermosillo

## 1. Propósito

Hasta ahora la burbuja de la mascota solo informa. Con este cambio se pueden **lanzar**, **ignorar** y
**reintentar** propuestas directamente desde ella. La burbuja ofrece los mismos workflows que el
selector de Telegram y pide confirmación en dos pasos antes de actuar. Telegram sigue funcionando igual
y ambos canales quedan sincronizados.

**Criterios de éxito:**
1. Una propuesta pendiente se puede lanzar desde la burbuja con un workflow elegido: tres clics como mínimo (Lanzar… → workflow → Sí, lanzar).
2. Venga de la mascota o de Telegram, **nunca se lanzan dos sesiones por la misma propuesta**. El segundo intento responde "Ya no está vigente".
3. Una acción hecha en la mascota se refleja en el mensaje de Telegram, y una hecha en Telegram desaparece de la burbuja.
4. La API sigue escuchando solo en `127.0.0.1`, con token y lista blanca de `Origin`. Ningún navegador puede disparar acciones.

## 2. Decisiones

| Decisión | Elección |
|---|---|
| Acciones | Lanzar, ignorar y reintentar. Responder preguntas de sesión queda para el chat (2b). |
| Confirmación | Dos pasos en la burbuja. Los workflows con etapas merge o deploy piden confirmación en rojo. |
| Selección de workflow | Por **id** de workflow, nunca por posición en el catálogo. |
| Lógica | Una sola implementación de las acciones en el daemon, usada por Telegram y por la API. |

## 3. Daemon

- **Acciones compartidas en `app.ts`:**
  - `workflowOptions(id)`
  - `launchProposal(id, workflowId, via)`
  - `rejectProposal(id, via)`
  - `retryProposal(id, via)`

  Devuelven un resultado tipado: `launched` con `sessionName`, `rejected`, o un error con código
  `not_found`, `not_pending`, `expired`, `unknown_workflow`, `ronin_unavailable` o `launch_failed`.
  Los callbacks de Telegram (`launch_with`, `retry`, `reject`) usan la misma lógica interna. Cada acción
  queda auditada con `via: "pet" | "telegram"`, y el mensaje de Telegram de la propuesta se edita siempre.
- **Opciones de workflow:**
  - Primero el sugerido, si no es favorito.
  - Luego los favoritos, en su orden (`group: "main"`).
  - Después el resto del catálogo (`group: "other"`).
  - Cada opción lleva `suggested`, `favorite` y `dangerous` (tiene etapas merge o deploy).
- **API local nueva:**

  | Método y ruta | Qué hace |
  |---|---|
  | `GET /proposals/:id/options` | Devuelve las opciones de workflow |
  | `POST /proposals/:id/launch` `{ workflowId }` | Lanza la propuesta |
  | `POST /proposals/:id/reject` | La ignora |
  | `POST /proposals/:id/retry` | Reintenta una fallida |

  - Códigos HTTP: 200 (ok), 404 (`not_found`), 409 (`not_pending` o `expired`), 400 (`unknown_workflow` o cuerpo inválido), 413 (cuerpo mayor a 4 KB), 415 (no es JSON), 503 (`ronin_unavailable`), 502 (`launch_failed`).
  - Los errores responden `{ code, message }`.
  - El preflight CORS permite `GET, POST` y las cabeceras `x-kitsune-token, content-type`.
- **`/state`:** cada elemento de `pending` gana `status: "pending" | "failed"`. Se incluyen las propuestas fallidas de las últimas 24 horas.

## 4. Mascota

- **Burbuja expandida:** cada propuesta muestra su título, su workflow y "Abrir en ClickUp". Si está pendiente,
  los botones [🚀 Lanzar…] y [❌ Ignorar]. Si falló, [🔁 Reintentar] y [❌ Ignorar].
- **Flujo:**
  - **Lanzar…** pide las opciones y muestra el grupo `main`, con ⭐ en el sugerido y "⚠️ merge/deploy" donde aplica, más un botón "Otro…" que abre el grupo `other`.
  - **Elegir un workflow** lleva a la confirmación: "¿Lanzar «título» con X?" [Sí, lanzar] [Cancelar]. Si el workflow es peligroso, el botón va en rojo y dice "Sí, lanzar (hace merge/deploy)".
  - **Ignorar** pide "¿Ignorar «título»?" [Sí, ignorar] [Cancelar].
  - **Reintentar** es un solo paso, porque repite una elección que ya confirmaste.
  - **Mientras espera** muestra "Lanzando…", sin botones.
  - **El resultado** ("✅ Sesión X creada", "⚠️ No se pudo lanzar: …", "Ya no está vigente") vuelve a la lista a los 4 s.
- Todo el texto se escribe con `textContent`. Los botones usan atributos `data-*` y un único listener delegado.

## 5. Pruebas

- **Daemon:**
  - Cada resultado de las acciones compartidas.
  - Doble lanzamiento mascota → Telegram y Telegram → mascota.
  - Endpoints nuevos: 200, 404, 409, 400, 413, 415, 503 y 502.
  - `Origin` ajeno y falta de token en los `POST`.
  - Preflight con `POST`.
  - `/state` con propuestas fallidas.
- **Mascota:** reductor del flujo de la burbuja, textos de resultado, cliente de la API (éxito, error HTTP y sin conexión) y el modelo con propuestas fallidas.
- **En vivo:** lanzar e ignorar una propuesta real desde la burbuja, y comprobar que Telegram se actualiza.
