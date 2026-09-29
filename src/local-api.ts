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
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        off();
        clearInterval(beat);
        streams.delete(res);
      };
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
