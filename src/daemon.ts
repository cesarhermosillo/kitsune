import { createFailureTracker } from "./backoff.js";

export interface Loop { name: string; run(): Promise<void>; intervalMs: number; onAlert?(error: unknown): Promise<void> }

export function startLoops(
  loops: Loop[],
  opts: { sleep: (ms: number, signal: AbortSignal) => Promise<void>; log: (line: string) => void; maxBackoffMs: number; alertAfter: number },
): { stop(): Promise<void> } {
  let running = true;
  const controller = new AbortController();
  const tasks = loops.map(async (loop) => {
    const tracker = createFailureTracker({ baseMs: loop.intervalMs, maxMs: opts.maxBackoffMs, alertAfter: opts.alertAfter });
    while (running) {
      let delay = loop.intervalMs;
      try {
        await loop.run();
        tracker.ok();
      } catch (error) {
        const state = tracker.fail();
        delay = state.delayMs;
        opts.log(`[${loop.name}] fallo ${state.failures}: ${error instanceof Error ? error.message : String(error)}`);
        if (state.shouldAlert && loop.onAlert) {
          try { await loop.onAlert(error); } catch (alertError) { opts.log(`[${loop.name}] no se pudo alertar: ${String(alertError)}`); }
        }
      }
      // stop() aborta esta señal para no esperar hasta `delay` (hasta maxBackoffMs) al apagar.
      if (running) await opts.sleep(delay, controller.signal);
    }
  });
  return {
    async stop() {
      running = false;
      controller.abort();
      await Promise.allSettled(tasks);
    },
  };
}
