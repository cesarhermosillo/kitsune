export function nextDelay(failures: number, baseMs: number, maxMs: number): number {
  if (failures <= 1) return baseMs;
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

export interface FailureTracker { ok(): void; fail(): { failures: number; shouldAlert: boolean; delayMs: number } }

export function createFailureTracker(opts: { baseMs: number; maxMs: number; alertAfter: number }): FailureTracker {
  let failures = 0;
  return {
    ok: () => { failures = 0; },
    fail: () => {
      failures++;
      return { failures, shouldAlert: failures === opts.alertAfter, delayMs: nextDelay(failures, opts.baseMs, opts.maxMs) };
    },
  };
}
