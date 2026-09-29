import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ActionErrorCode, LaunchResult, OptionsResult, RejectResult } from "./app.js";
import type { EventBus, KitsuneEvent } from "./events.js";
import type { PetState } from "./state.js";

/** Acciones que la mascota puede disparar sobre una propuesta; sin esto las rutas /proposals/* responden 404. */
export interface LocalActions {
  options(id: string): Promise<OptionsResult>;
  launch(id: string, workflowId: string): Promise<LaunchResult>;
  reject(id: string): Promise<RejectResult>;
  retry(id: string): Promise<LaunchResult>;
}

export interface LocalApiOptions {
  port: number; token: string; allowedOrigins: string[];
  snapshot: () => PetState; bus: EventBus; heartbeatMs?: number;
  actions?: LocalActions;
}
export interface LocalApi { port: number; host: string; close(): Promise<void> }

const MAX = 500;
const clip = (text: string) => (text.length > MAX ? text.slice(0, MAX) : text);

const MAX_BODY_BYTES = 4096;
const PROPOSAL_ROUTE = /^\/proposals\/([a-z0-9]{10})\/(options|launch|reject|retry)$/;
const ACTION_STATUS: Record<ActionErrorCode, number> = {
  not_found: 404, not_pending: 409, expired: 409, unknown_workflow: 400, ronin_unavailable: 503, launch_failed: 502,
};

/** Envía el resultado de una acción: 200 sin el campo `ok` si tuvo éxito, o el código HTTP mapeado con `{ code, message }`. */
function sendActionResult(res: ServerResponse, result: OptionsResult | LaunchResult | RejectResult): void {
  if (result.ok) {
    const { ok: _ok, ...rest } = result;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rest));
    return;
  }
  res.writeHead(ACTION_STATUS[result.code], { "content-type": "application/json" })
    .end(JSON.stringify({ code: result.code, message: clip(result.message) }));
}

function sendError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify({ code, message }));
}

function sendBadRequest(res: ServerResponse): void {
  sendError(res, 400, "bad_request", "Cuerpo inválido");
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendError(res, 405, "method_not_allowed", "Método no permitido");
}

/**
 * Lee el cuerpo hasta `maxBytes`; si se pasa, deja de escuchar y resuelve `null` (el llamador
 * responde 413 y solo entonces destruye la petición — nunca antes de que la respuesta se haya
 * escrito, o el cliente vería la conexión cortada en vez del 413).
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let done = false;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) { finish(null); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = (error: Error) => { if (!done) { done = true; reject(error); } };
    function finish(value: string | null) {
      if (done) return;
      done = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      resolve(value);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Acota a 500 cada campo de texto del evento antes de mandarlo por SSE. */
function clipEvent(event: KitsuneEvent): KitsuneEvent {
  const out: Record<string, unknown> = { ...event };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string") out[key] = clip(value);
  }
  return out as KitsuneEvent;
}

function tokenOk(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startLocalApi(opts: LocalApiOptions): Promise<LocalApi> {
  const streams = new Map<ServerResponse, () => void>();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  /** Ruta de acciones (options|launch|reject|retry): valida método, cuerpo (solo launch) y despacha a `opts.actions`. */
  async function handleAction(
    req: IncomingMessage, res: ServerResponse, actions: LocalActions, id: string, action: "options" | "launch" | "reject" | "retry",
  ): Promise<void> {
    if (action === "options") {
      if (req.method !== "GET") { sendMethodNotAllowed(res); return; }
      sendActionResult(res, await actions.options(id));
      return;
    }
    if (req.method !== "POST") { sendMethodNotAllowed(res); return; }
    if (action === "reject") { sendActionResult(res, await actions.reject(id)); return; }
    if (action === "retry") { sendActionResult(res, await actions.retry(id)); return; }
    // action === "launch": único que exige content-type y cuerpo.
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
      sendError(res, 415, "unsupported_media_type", "Se requiere content-type: application/json");
      return;
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      // La petición se destruye solo tras enviar la respuesta: destruirla antes cortaría la
      // conexión (RST) antes de que el 413 llegara al cliente.
      res.once("finish", () => req.destroy());
      sendError(res, 413, "payload_too_large", "Cuerpo demasiado grande (máximo 4 KB)", { connection: "close" });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { sendBadRequest(res); return; }
    const workflowId = (parsed as { workflowId?: unknown } | null)?.workflowId;
    if (typeof workflowId !== "string" || workflowId === "") { sendBadRequest(res); return; }
    sendActionResult(res, await actions.launch(id, workflowId));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!opts.allowedOrigins.includes(origin)) { res.writeHead(403).end(); return; }
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS" && origin !== undefined) {
      res.writeHead(204, { "access-control-allow-headers": "x-kitsune-token, content-type", "access-control-allow-methods": "GET, POST" }).end();
      return;
    }
    const presented = req.headers["x-kitsune-token"];
    if (!tokenOk(opts.token, Array.isArray(presented) ? presented[0] : presented)) { res.writeHead(401).end(); return; }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/state") {
      // Se calcula el cuerpo antes de escribir cabeceras: si snapshot() o JSON.stringify
      // lanzan, todavía no hemos comprometido la respuesta y el catch externo puede responder 500.
      const body = JSON.stringify(opts.snapshot());
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": ok\n\n");
      const off = opts.bus.subscribe((event) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(clipEvent(event))}\n\n`);
      });
      const beat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        res.write(": hb\n\n");
      }, heartbeatMs);
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        off();
        clearInterval(beat);
        streams.delete(res);
      };
      streams.set(res, cleanup);
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }
    const match = opts.actions ? PROPOSAL_ROUTE.exec(path) : null;
    if (match) {
      await handleAction(req, res, opts.actions!, match[1], match[2] as "options" | "launch" | "reject" | "retry");
      return;
    }
    res.writeHead(404).end();
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res).catch(() => {
        // opts.snapshot() (o el JSON.stringify de su resultado), o cualquier fallo al leer el cuerpo
        // o llamar a opts.actions, puede lanzar; nunca debe tumbar el daemon.
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      // Tras arrancar, un error del servidor (p.ej. de un socket) no debe quedar sin capturar.
      server.on("error", () => { /* no-op: los errores post-listen no deben tumbar el daemon */ });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : opts.port;
      const host = typeof address === "object" && address !== null ? address.address : "127.0.0.1";
      resolve({
        port,
        host,
        close: () => new Promise<void>((done) => {
          for (const [stream, cleanup] of streams) {
            cleanup();
            if (!stream.writableEnded) stream.end();
          }
          streams.clear();
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
