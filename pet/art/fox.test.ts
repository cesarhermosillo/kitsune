import { ANIMATIONS, REQUIRED } from "./fox";
import { PALETTE } from "./palette";
import { buildSheet, validateFrame } from "./sheet";

test("la paleta tiene como máximo 16 colores opacos o translúcidos", () => {
  expect(Object.keys(PALETTE).length).toBeLessThanOrEqual(16);
  expect(Object.keys(PALETTE)).not.toContain(".");
});

test("existen todas las animaciones requeridas con su fps, bucle y cuadros mínimos", () => {
  for (const [name, req] of Object.entries(REQUIRED)) {
    const anim = ANIMATIONS[name as keyof typeof ANIMATIONS];
    expect(anim, name).toBeDefined();
    expect(anim.fps, name).toBe(req.fps);
    expect(anim.loop, name).toBe(req.loop);
    expect(anim.frames.length, name).toBeGreaterThanOrEqual(req.minFrames);
  }
});

test("cada cuadro es válido (32×32, solo colores de la paleta)", () => {
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    anim.frames.forEach((frame, i) => expect(validateFrame(frame, PALETTE), `${name}[${i}]`).toEqual([]));
  }
});

test("cada animación se mueve (no todos sus cuadros son iguales)", () => {
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    const distinct = new Set(anim.frames.map((f) => f.join("\n")));
    expect(distinct.size, name).toBeGreaterThan(1);
  }
});

test("cada cuadro tiene un zorro visible (≥ 150 píxeles opacos)", () => {
  for (const [name, anim] of Object.entries(ANIMATIONS)) {
    anim.frames.forEach((frame, i) => {
      const opaque = frame.join("").replace(/\./g, "").length;
      expect(opaque, `${name}[${i}]`).toBeGreaterThanOrEqual(150);
    });
  }
});

test("la hoja es determinista", () => {
  const a = buildSheet(ANIMATIONS, PALETTE);
  const b = buildSheet(ANIMATIONS, PALETTE);
  expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
});
