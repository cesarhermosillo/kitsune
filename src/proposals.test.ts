import assert from "node:assert/strict";
import test from "node:test";
import { canTransition } from "./proposals.js";

test("transiciones válidas", () => {
  for (const [from, to] of [["pending", "approved"], ["pending", "rejected"], ["pending", "expired"], ["approved", "launched"], ["approved", "failed"], ["failed", "approved"], ["failed", "rejected"]] as const) {
    assert.equal(canTransition(from, to), true, `${from}→${to}`);
  }
});

test("transiciones inválidas", () => {
  for (const [from, to] of [["approved", "approved"], ["launched", "approved"], ["rejected", "approved"], ["expired", "approved"], ["pending", "launched"], ["failed", "launched"], ["launched", "rejected"], ["approved", "rejected"]] as const) {
    assert.equal(canTransition(from, to), false, `${from}→${to}`);
  }
});
