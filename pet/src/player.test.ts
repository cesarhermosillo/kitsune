import { frameIndex } from "./player";

const anim = (loop: boolean) => ({ fps: 10, loop, frames: [{ x: 0, y: 0 }, { x: 32, y: 0 }, { x: 64, y: 0 }] });

test("en bucle avanza a fps y da la vuelta", () => {
  expect(frameIndex(anim(true), 0, 0)).toBe(0);
  expect(frameIndex(anim(true), 0, 100)).toBe(1);
  expect(frameIndex(anim(true), 0, 300)).toBe(0);
});

test("sin bucle se queda en el último cuadro", () => {
  expect(frameIndex(anim(false), 0, 250)).toBe(2);
  expect(frameIndex(anim(false), 0, 10_000)).toBe(2);
});
