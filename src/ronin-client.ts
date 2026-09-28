import type { Catalog, SessionStatus } from "./types.js";

export class RoninError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface RoninClient {
  catalog(): Promise<Catalog>;
  createSession(input: { repo: string; workflowId: string; request: string; origen: string; name?: string }): Promise<{ name: string; branch?: string; worktree?: string }>;
  sessionStatus(names?: string[]): Promise<SessionStatus[]>;
  replySession(name: string, text: string): Promise<void>;
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";

export function createRoninClient(opts: {
  url: string; token: string; fetch: typeof fetch;
  /** Timeout por llamada (30 s); crear_sesion usa createTimeoutMs (120 s) porque prepara worktree y agente. */
  timeoutMs?: number; createTimeoutMs?: number;
}): RoninClient {
  let nextId = 1;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const createTimeoutMs = opts.createTimeoutMs ?? 120_000;
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const ms = name === "crear_sesion" ? createTimeoutMs : timeoutMs;
    const signal = AbortSignal.timeout(ms);
    const timeout = () => new RoninError("TIMEOUT", `Ronin no respondió en ${ms / 1000} s (${name})`);
    let response: Response;
    try {
      response = await opts.fetch(`${opts.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ronin-capability": opts.token },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
        signal,
      });
    } catch (error) {
      if (isTimeout(error)) throw timeout();
      throw new RoninError("UNREACHABLE", `Ronin no responde en ${opts.url}: ${error instanceof Error ? error.message : "error de red"}`);
    }
    if (!response.ok) throw new RoninError(`HTTP_${response.status}`, `Ronin respondió ${response.status}`);
    let raw: unknown;
    try { raw = await response.json(); } catch (error) { if (isTimeout(error)) throw timeout(); throw error; }
    const body = raw as { error?: { code: number; message: string }; result?: { content: Array<{ text: string }>; isError?: boolean } };
    if (body.error) throw new RoninError(`RPC_${body.error.code}`, body.error.message);
    const text = body.result?.content?.[0]?.text ?? "";
    if (body.result?.isError) {
      const match = text.match(/^([A-Z_]+): ([\s\S]*)$/);
      throw new RoninError(match ? match[1] : "TOOL_ERROR", match ? match[2] : text);
    }
    return JSON.parse(text) as T;
  }
  return {
    catalog: () => call<Catalog>("listar_repos_y_workflows", {}),
    createSession: (input) => call("crear_sesion", { ...input }),
    sessionStatus: (names) => call<SessionStatus[]>("estado_sesiones", names ? { names } : {}),
    replySession: async (name, text) => { await call("responder_sesion", { name, text }); },
  };
}
