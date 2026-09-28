import assert from "node:assert/strict";
import test from "node:test";
import { startLoops } from "./daemon.js";

test("un loop que falla hace backoff, alerta al umbral y sigue corriendo", async () => {
  let calls = 0;
  const alerts: unknown[] = [];
  const sleeps: number[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const handle = startLoops([{
    name: "inbox", intervalMs: 10,
    run: async () => { calls++; if (calls <= 3) throw new Error(`fallo ${calls}`); if (calls === 4) resolveDone(); },
    onAlert: async (e) => { alerts.push(e); },
  }], { sleep: async (ms) => { sleeps.push(ms); }, log: () => {}, maxBackoffMs: 1000, alertAfter: 3 });
  await done;
  await handle.stop();
  assert.equal(alerts.length, 1);
  assert.match(String((alerts[0] as Error).message), /fallo 3/);
  assert.deepEqual(sleeps.slice(0, 3), [10, 20, 40]);
});

test("stop() interrumpe un sleep pendiente en vez de esperar el backoff completo", async () => {
  let runs = 0;
  const handle = startLoops(
    [
      {
        name: "watcher",
        intervalMs: 10,
        run: async () => {
          runs++;
          throw new Error("fallo");
        },
      },
    ],
    {
      // Un sleep que jamás resuelve por sí solo: solo resuelve si se aborta.
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      log: () => {},
      maxBackoffMs: 300_000,
      alertAfter: 5,
    },
  );
  // Deja que el loop corra al menos una vez y quede bloqueado en el sleep pendiente.
  await new Promise((r) => setTimeout(r, 20));
  const runsBeforeStop = runs;
  const startedAt = Date.now();
  await handle.stop();
  assert.ok(Date.now() - startedAt < 200, "stop() debe resolver casi de inmediato");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, runsBeforeStop, "run() no debe volver a llamarse tras stop()");
});
