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

export const retryDelay = (offlineSinceMs: number): number =>
  offlineSinceMs < 60_000 ? 5000 : 30000;

export interface ClientDeps {
  baseUrl: string;
  token: () => Promise<string>;
  fetch: typeof fetch;
  onSnapshot(s: PetState): void;
  onEvent(e: KitsuneEvent): void;
  onConnected(connected: boolean): void;
  sleep(ms: number): Promise<void>;
  now(): number;
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
        const stateRes = await deps.fetch(`${deps.baseUrl}/state`, {
          headers,
          signal: controller.signal,
        });
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        deps.onSnapshot((await stateRes.json()) as PetState);
        offlineSince = null;
        deps.onConnected(true);

        const stream = await deps.fetch(`${deps.baseUrl}/events`, {
          headers,
          signal: controller.signal,
        });
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
            try {
              deps.onEvent((JSON.parse(raw)) as KitsuneEvent);
            } catch {
              /* evento malformado: se ignora */
            }
          }
        }
      } catch {
        /* sin conexión: cae a la reconexión */
      }

      if (stopped) break;
      deps.onConnected(false);
      offlineSince ??= deps.now();
      await deps.sleep(retryDelay(deps.now() - offlineSince));
    }
  })();

  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
