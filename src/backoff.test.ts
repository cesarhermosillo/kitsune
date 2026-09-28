import assert from "node:assert/strict";
import test from "node:test";
import { createFailureTracker, nextDelay } from "./backoff.js";

test("nextDelay crece exponencialmente con tope", () => {
  assert.deepEqual([0, 1, 2, 3, 10].map((f) => nextDelay(f, 1000, 5000)), [1000, 1000, 2000, 4000, 5000]);
});

test("createFailureTracker alerta una sola vez al llegar al umbral y se reinicia con ok", () => {
  const t = createFailureTracker({ baseMs: 1000, maxMs: 300_000, alertAfter: 3 });
  assert.deepEqual([t.fail(), t.fail(), t.fail(), t.fail()].map((r) => r.shouldAlert), [false, false, true, false]);
  t.ok();
  assert.equal(t.fail().failures, 1);
});
