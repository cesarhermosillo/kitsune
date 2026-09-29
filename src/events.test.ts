import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus, type KitsuneEvent } from "./events.js";

test("publish entrega a todos los suscriptores con marca de tiempo", () => {
  const bus = createEventBus(() => 123);
  const a: KitsuneEvent[] = [];
  const b: KitsuneEvent[] = [];
  bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));
  bus.publish({ type: "session_done", name: "cowork-x" });
  assert.deepEqual(a, [{ type: "session_done", name: "cowork-x", at: 123 }]);
  assert.deepEqual(b, a);
});

test("desuscribir deja de entregar", () => {
  const bus = createEventBus(() => 1);
  const got: KitsuneEvent[] = [];
  const off = bus.subscribe((e) => got.push(e));
  off();
  bus.publish({ type: "error", message: "x" });
  assert.deepEqual(got, []);
});

test("un suscriptor que lanza no afecta a los demás ni a quien publica", () => {
  const bus = createEventBus(() => 1);
  const got: string[] = [];
  bus.subscribe(() => { throw new Error("boom"); });
  bus.subscribe((e) => got.push(e.type));
  assert.doesNotThrow(() => bus.publish({ type: "triage_started", title: "t" }));
  assert.deepEqual(got, ["triage_started"]);
});
