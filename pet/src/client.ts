import type { KitsuneEvent, PetState } from "./types";

export function parseSse(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: string[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (data.length) events.push(data.join("\n"));
  }
  return { events, rest };
}

/** m3: sin bytes en el stream durante este tiempo (el latido llega cada 15 s) se aborta y se reconecta. */
export const STREAM_IDLE_MS = 45_000;

/** Texto legible de lo que haya lanzado fetch/invoke (invoke rechaza con strings). */
export const errorReason = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : String(e);

export const retryDelay = (offlineSinceMs: number): number =>
  offlineSinceMs < 60_000 ? 5000 : 30000;

export interface ClientDeps {
  baseUrl: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
  onSnapshot(s: PetState): void;
  onEvent(e: KitsuneEvent): void;
  /** `reason` es el motivo de la desconexión (vacío si el stream se cerró sin error). */
  onConnected(connected: boolean, reason?: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Plazo sin bytes en /events antes de reconectar (por defecto STREAM_IDLE_MS). */
  idleMs?: number;
}

export function startClient(deps: ClientDeps): { stop(): void } {
  let stopped = false;
  let controller: AbortController | null = null;
  let offlineSince: number | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const idleMs = deps.idleMs ?? STREAM_IDLE_MS;

  void (async () => {
    while (!stopped) {
      controller = new AbortController();
      const ctl = controller;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let stale = false;
      // Si no llega nada (ni el latido) en `idleMs`, se aborta la petición y se cancela el lector.
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          stale = true;
          ctl.abort();
          void reader?.cancel().catch(() => {});
        }, idleMs);
      };
      let reason: string | undefined;
      try {
        const headers = { "x-kitsune-token": await deps.token() };
        const stateRes = await deps.fetch(`${deps.baseUrl}/state`, {
          headers,
          signal: controller.signal,
        });
        if (stateRes.status === 401) throw new Error("El token de la mascota no es válido (HTTP 401)");
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        deps.onSnapshot((await stateRes.json()) as PetState);
        offlineSince = null;
        deps.onConnected(true);

        armIdle();
        const stream = await deps.fetch(`${deps.baseUrl}/events`, {
          headers,
          signal: controller.signal,
        });
        if (!stream.ok || !stream.body) throw new Error(`HTTP ${stream.status}`);

        reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          for (const raw of parsed.events) {
            try {
              deps.onEvent((JSON.parse(raw)) as KitsuneEvent);
            } catch {
              /* evento malformado: se ignora */
            }
          }
        }
        if (stale) throw new Error("stale");
      } catch (e) {
        /* sin conexión: cae a la reconexión con el motivo */
        reason = stale ? `Sin latido de Kitsune en ${Math.round(idleMs / 1000)} s` : errorReason(e);
      } finally {
        clearTimeout(idleTimer);
        reader = null;
      }

      if (stopped) break;
      deps.onConnected(false, reason);
      offlineSince ??= deps.now();
      await deps.sleep(retryDelay(deps.now() - offlineSince));
    }
  })();

  return {
    stop() {
      stopped = true;
      controller?.abort();
      void reader?.cancel().catch(() => {});
    },
  };
}
