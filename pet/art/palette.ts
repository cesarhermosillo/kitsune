import type { Palette } from "./sheet";

// Paleta del zorro kitsune (≤ 16 colores). "." es transparente y no forma parte de la paleta.
export const PALETTE: Palette = {
  k: [0x1a, 0x14, 0x26, 255], // contorno
  o: [0xf0, 0x8a, 0x3c, 255], // naranja base
  s: [0xc8, 0x5a, 0x24, 255], // naranja sombra
  l: [0xff, 0xb0, 0x70, 255], // naranja luz
  c: [0xff, 0xf1, 0xd6, 255], // crema
  w: [0xff, 0xff, 0xff, 255], // blanco
  p: [0x91, 0x84, 0xd9, 255], // morado de acento (brillo, chispas, "!" y "?")
  g: [0x4a, 0x4e, 0x63, 255], // laptop oscuro
  h: [0x7a, 0x7f, 0x99, 255], // laptop claro
  b: [0x6f, 0xb6, 0xff, 255], // lágrima
  y: [0xff, 0xe0, 0x66, 255], // chispa
};
