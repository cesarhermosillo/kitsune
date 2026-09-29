import { inflateSync } from "node:zlib";
import { encodePng } from "./png";

function chunks(png: Buffer) {
  const out: Record<string, Buffer> = {};
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    out[type] = Buffer.concat([out[type] ?? Buffer.alloc(0), png.subarray(offset + 8, offset + 8 + length)]);
    offset += 12 + length;
  }
  return out;
}

test("firma PNG, IHDR y pixeles recuperables", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 1, 2, 3, 4]); // 2×2
  const png = encodePng(2, 2, rgba);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const c = chunks(png);
  expect(c.IHDR.readUInt32BE(0)).toBe(2);
  expect(c.IHDR.readUInt32BE(4)).toBe(2);
  expect(c.IHDR[8]).toBe(8);   // bit depth
  expect(c.IHDR[9]).toBe(6);   // RGBA
  const raw = inflateSync(c.IDAT);
  expect([...raw]).toEqual([0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 128, 1, 2, 3, 4]); // filtro 0 por fila
  expect(c.IEND.length).toBe(0);
});

test("es determinista", () => {
  const rgba = new Uint8Array(4 * 4 * 4).fill(7);
  expect(encodePng(4, 4, rgba).equals(encodePng(4, 4, rgba))).toBe(true);
});
