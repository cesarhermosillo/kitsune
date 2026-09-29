import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { EventBus, KitsuneEvent } from "./events.js";
import type { PetState } from "./state.js";

export interface LocalApiOptions {
  port: number; token: string; allowedOrigins: string[];
  snapshot: () => PetState; bus: EventBus; heartbeatMs?: number;
}
export interface LocalApi { port: number; host: string; close(): Promise<void> }

const MAX = 500;
const clip = (text: string) => (text.length > MAX ? text.slice(0, MAX) : text);

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

  function handle(req: IncomingMessage, res: ServerResponse): void {
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
    res.writeHead(404).end();
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      // opts.snapshot() (o el JSON.stringify de su resultado) puede lanzar; nunca debe tumbar el daemon.
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
