import { buildSheet, scaleNearest, validateFrame, type Palette } from "./sheet";

const P: Palette = { a: [255, 0, 0, 255], b: [0, 0, 255, 255] };
const f = (ch: string) => Array.from({ length: 4 }, () => ch.repeat(4));

test("validateFrame detecta tamaño y colores fuera de paleta", () => {
  expect(validateFrame(f("a"), P, 4)).toEqual([]);
  expect(validateFrame(f("a").slice(0, 3), P, 4)[0]).toMatch(/filas/);
  expect(validateFrame(["aaaa", "aaa", "aaaa", "aaaa"], P, 4)[0]).toMatch(/fila 1/);
  expect(validateFrame(["aaaa", "aaza", "aaaa", "aaaa"], P, 4)[0]).toMatch(/'z'/);
});

test("buildSheet coloca una fila por animación y describe los cuadros", () => {
  const { width, height, rgba, meta } = buildSheet({ uno: { fps: 6, loop: true, frames: [f("a"), f("b")] }, dos: { fps: 3, loop: false, frames: [f(".")] } }, P, 4);
  expect([width, height]).toEqual([8, 8]);
  expect(meta).toEqual({ frameSize: 4, animations: {
    uno: { fps: 6, loop: true, frames: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
    dos: { fps: 3, loop: false, frames: [{ x: 0, y: 4 }] },
  } });
  expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);                   // (0,0) = a
  expect([...rgba.subarray(4 * 4, 4 * 4 + 4)]).toEqual([0, 0, 255, 255]);       // (4,0) = b
  expect(rgba[(4 * 8 + 0) * 4 + 3]).toBe(0);                                    // (0,4) transparente
});

test("buildSheet lanza si un cuadro es inválido", () => {
  expect(() => buildSheet({ x: { fps: 1, loop: true, frames: [["zz"]] } }, P, 4)).toThrow(/x\[0\]/);
});

test("scaleNearest multiplica cada pixel", () => {
  const out = scaleNearest(1, 1, new Uint8Array([9, 8, 7, 6]), 3);
  expect([out.width, out.height]).toEqual([3, 3]);
  expect([...out.rgba.subarray(4 * 8, 4 * 9)]).toEqual([9, 8, 7, 6]);
});
