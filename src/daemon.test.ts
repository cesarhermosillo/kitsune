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
