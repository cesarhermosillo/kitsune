export type Frame = string[];
export type Palette = Record<string, [number, number, number, number]>;
export interface AnimationDef { fps: number; loop: boolean; frames: Frame[] }
export interface SheetMeta { frameSize: number; animations: Record<string, { fps: number; loop: boolean; frames: Array<{ x: number; y: number }> }> }

export function validateFrame(frame: Frame, palette: Palette, size = 32): string[] {
  const errors: string[] = [];
  if (frame.length !== size) errors.push(`se esperaban ${size} filas y hay ${frame.length}`);
  frame.forEach((row, y) => {
    if (row.length !== size) errors.push(`fila ${y}: se esperaban ${size} columnas y hay ${row.length}`);
    for (const ch of row) if (ch !== "." && !(ch in palette)) errors.push(`fila ${y}: color '${ch}' fuera de la paleta`);
  });
  return errors;
}

export function buildSheet(animations: Record<string, AnimationDef>, palette: Palette, size = 32) {
  const names = Object.keys(animations);
  for (const name of names) {
    animations[name].frames.forEach((frame, i) => {
      const errors = validateFrame(frame, palette, size);
      if (errors.length) throw new Error(`${name}[${i}]: ${errors[0]}`);
    });
  }
  const cols = Math.max(...names.map((n) => animations[n].frames.length));
  const width = size * cols;
  const height = size * names.length;
  const rgba = new Uint8Array(width * height * 4);
  const meta: SheetMeta = { frameSize: size, animations: {} };
  names.forEach((name, row) => {
    const def = animations[name];
    meta.animations[name] = { fps: def.fps, loop: def.loop, frames: [] };
    def.frames.forEach((frame, col) => {
      const ox = col * size;
      const oy = row * size;
      meta.animations[name].frames.push({ x: ox, y: oy });
      frame.forEach((line, y) => {
        [...line].forEach((ch, x) => {
          if (ch === ".") return;
          const i = ((oy + y) * width + (ox + x)) * 4;
          rgba.set(palette[ch], i);
        });
      });
    });
  });
  return { width, height, rgba, meta };
}

export function scaleNearest(width: number, height: number, rgba: Uint8Array, factor: number) {
  const w = width * factor;
  const h = height * factor;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((Math.floor(y / factor) * width) + Math.floor(x / factor)) * 4;
      out.set(rgba.subarray(src, src + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, rgba: out };
}
