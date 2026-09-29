import { isOpaqueAt } from "./hit";

const alpha = (x: number, y: number) => (x === 33 && y === 1 ? 255 : 0); // un solo píxel opaco en (1,1) del cuadro en x=32

test("detecta el píxel opaco escalado y descarta el resto", () => {
  const frame = { x: 32, y: 0 };
  expect(isOpaqueAt(alpha, frame, 32, 4, 4 * 1 + 2, 4 * 1 + 2)).toBe(true);
  expect(isOpaqueAt(alpha, frame, 32, 4, 0, 0)).toBe(false);
  expect(isOpaqueAt(alpha, frame, 32, 4, -1, 5)).toBe(false);
  expect(isOpaqueAt(alpha, frame, 32, 4, 32 * 4, 0)).toBe(false);
});
