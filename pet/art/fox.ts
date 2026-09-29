import type { AnimationDef, Frame } from "./sheet";

export type PetAnimation = "sleeping" | "idle" | "sniffing" | "alert" | "working" | "asking" | "celebrate" | "sad";

export const REQUIRED = {
  sleeping:  { minFrames: 4, fps: 3,  loop: true  },
  idle:      { minFrames: 6, fps: 6,  loop: true  },
  sniffing:  { minFrames: 6, fps: 8,  loop: true  },
  alert:     { minFrames: 6, fps: 8,  loop: true  },
  working:   { minFrames: 6, fps: 8,  loop: true  },
  asking:    { minFrames: 4, fps: 6,  loop: true  },
  celebrate: { minFrames: 8, fps: 10, loop: false },
  sad:       { minFrames: 4, fps: 4,  loop: true  },
} as const;

// ---------------------------------------------------------------------------
// Lienzo y capas. Cada capa se pinta con colores de relleno y, al componerla,
// recibe un contorno oscuro de 1 px ("k") alrededor de su silueta. Así las
// partes que se enciman (colas, cuerpo, patas, cabeza) quedan separadas por
// una línea limpia y la silueta exterior nunca tiene huecos.
// ---------------------------------------------------------------------------

const SIZE = 32;
const OUTLINE = "k";
type Grid = string[][];

function blank(): Grid {
  return Array.from({ length: SIZE }, () => Array<string>(SIZE).fill("."));
}

function put(g: Grid, x: number, y: number, ch: string) {
  if (x >= 0 && x < SIZE && y >= 0 && y < SIZE && ch !== ".") g[y][x] = ch;
}

function stamp(g: Grid, rows: string[], ox: number, oy: number) {
  rows.forEach((row, y) => [...row].forEach((ch, x) => put(g, ox + x, oy + y, ch)));
}

function ellipse(g: Grid, cx: number, cy: number, rx: number, ry: number, color: (x: number, y: number) => string) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) put(g, x, y, color(x, y));
    }
  }
}

function rect(g: Grid, x0: number, y0: number, w: number, h: number, ch: string) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(g, x, y, ch);
}

/** Pinta la capa sobre la base y le agrega su contorno de 1 px. */
function composite(base: Grid, layer: Grid, outline = true) {
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (layer[y][x] !== ".") base[y][x] = layer[y][x];
  if (!outline) return;
  const inside = (x: number, y: number) => x >= 0 && x < SIZE && y >= 0 && y < SIZE && layer[y][x] !== ".";
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (inside(x, y)) continue;
      if (inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)) base[y][x] = OUTLINE;
    }
  }
}

function shift(layer: Grid, dx: number, dy: number): Grid {
  const out = blank();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) put(out, x + dx, y + dy, layer[y][x]);
  return out;
}

function flip(g: Grid): Grid {
  return g.map((row) => [...row].reverse());
}

const toFrame = (g: Grid): Frame => g.map((row) => row.join(""));

// ---------------------------------------------------------------------------
// Partes del zorro
// ---------------------------------------------------------------------------

type Pt = [number, number];

/** Cola esponjada: discos a lo largo de una curva de Bézier, con punta crema. */
function tail(from: Pt, ctrl: Pt, to: Pt, fur: string, thick = 2.4): Grid {
  const g = blank();
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const u = 1 - t;
    const cx = u * u * from[0] + 2 * u * t * ctrl[0] + t * t * to[0];
    const cy = u * u * from[1] + 2 * u * t * ctrl[1] + t * t * to[1];
    const r = 1 + thick * Math.sin(Math.PI * (0.1 + 0.8 * Math.pow(t, 0.7)));
    const ch = t > 0.86 ? "c" : fur;
    ellipse(g, cx, cy, r, r, () => ch);
  }
  return g;
}

type Eyes = "open" | "blink" | "happy" | "sad" | "wide";
type Ears = "normal" | "up" | "down" | "flat";

// Cara vista de tres cuartos hacia la derecha (solo relleno; el contorno se agrega al componer).
// "E" marca los ojos (2×2) y "N" la nariz.
const FACE = [
  "...lllllllll.......",
  "..lloooooooool.....",
  ".ooooooooooooooo...",
  ".oooooooooooooooo..",
  "ooooEEoooooEEoooo..",
  "ooooEEoooooEEooooo.",
  "sooooooooooooocccNN",
  "ssoooooooocccccccc.",
  "sscccooocccccccccc.",
  ".sscccccccccccccc..",
  "...ccccccccccccc...",
];

const EARS: Record<Ears, { back: string[]; front: string[]; bx: number; fx: number; by: number; fy: number }> = {
  normal: {
    back: [".o...", ".oo..", "ocoo.", "occoo", "occco", "occco"],
    front: ["...o.", "..oo.", ".ooco", "oocco", "occco", "occco"],
    bx: 1, fx: 10, by: -5, fy: -5,
  },
  up: {
    back: [".o...", ".o...", ".oo..", "ocoo.", "occoo", "occco", "occco"],
    front: ["...o.", "...o.", "..oo.", ".ooco", "oocco", "occco", "occco"],
    bx: 1, fx: 10, by: -6, fy: -6,
  },
  down: {
    back: ["oo.....", "ocoo...", ".occoo.", "..ooooo"],
    front: [".....oo", "...ooco", ".oocco.", "ooooo.."],
    bx: -4, fx: 11, by: -1, fy: -1,
  },
  flat: {
    back: ["ooo...", ".occoo", "..oooo"],
    front: ["....", "..oo", "oooo"],
    bx: -3, fx: 10, by: -1, fy: -1,
  },
};

const EYE_ROWS: Record<Eyes, [string, string]> = {
  open: ["kp", "kk"],
  wide: ["kp", "kk"],
  blink: ["oo", "kk"],
  happy: ["kk", "oo"],
  sad: ["oo", "kk"],
};

interface HeadOpts { eyes?: Eyes; ears?: Ears; nose?: 0 | 1; tilt?: number; mouth?: boolean }

function head(ox: number, oy: number, o: HeadOpts = {}): Grid {
  const g = blank();
  const ears = EARS[o.ears ?? "normal"];
  stamp(g, ears.back, ox + ears.bx, oy + ears.by);
  stamp(g, ears.front, ox + ears.fx, oy + ears.fy);
  const [e0, e1] = EYE_ROWS[o.eyes ?? "open"];
  const face = FACE.map((row, y) => {
    let r = row;
    if (y === 4) r = r.replace("EE", e0).replace("EE", e0);
    if (y === 5) r = r.replace("EE", e1).replace("EE", e1);
    return r.replace(/N/g, "k");
  });
  stamp(g, face, ox, oy);
  // Nariz que olfatea: se asoma un píxel arriba o abajo.
  if (o.nose === 1) { put(g, ox + 18, oy + 6, "."); put(g, ox + 18, oy + 7, "k"); put(g, ox + 17, oy + 7, "c"); }
  if (o.mouth) put(g, ox + 15, oy + 8, "k");
  if (o.eyes === "wide") { put(g, ox + 4, oy + 3, "k"); put(g, ox + 11, oy + 3, "k"); }
  if (o.eyes === "happy") for (const x of [3, 6, 10, 13]) put(g, ox + x, oy + 5, "k");
  if (o.eyes === "sad") { put(g, ox + 5, oy + 3, "k"); put(g, ox + 4, oy + 4, "k"); put(g, ox + 11, oy + 3, "k"); put(g, ox + 12, oy + 4, "k"); }
  if (!o.tilt) return g;
  // Cabeza ladeada: desplaza cada columna según su distancia al centro.
  const out = blank();
  const pivot = ox + 9;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) put(out, x, y + Math.round((x - pivot) * o.tilt), g[y][x]);
  return out;
}

// Tres colas por fase de balanceo (0, 1, 2), de atrás hacia delante.
function tails(phase: number): Grid[] {
  const sway = [-1, 0, 1][phase];
  return [
    tail([11, 26], [5 + sway, 23], [6 + sway, 10], "s"),
    tail([11, 25], [10 + sway, 20], [10 + sway * 2, 7], "o", 2.2),
    tail([11, 27], [3 + sway, 28], [4 + sway, 17], "o", 2.1),
  ];
}

function body(): Grid {
  const g = blank();
  ellipse(g, 15.5, 24.5, 6, 6.5, (x) => (x < 12 ? "s" : "o"));
  ellipse(g, 19.5, 22, 2.2, 3.2, () => "c");
  return g;
}

function haunch(): Grid {
  const g = blank();
  ellipse(g, 12, 26.5, 4.2, 3.7, (_x, y) => (y >= 29 ? "s" : "o"));
  rect(g, 13, 30, 3, 1, "c");
  return g;
}

type Legs = "sit" | "typeA" | "typeB";

function legs(kind: Legs): Grid[] {
  const a = blank();
  const b = blank();
  const liftA = kind === "typeA" ? 2 : 0;
  const liftB = kind === "typeB" ? 2 : 0;
  rect(a, 17, 24, 2, 7 - liftA, "o");
  rect(a, 17, 30 - liftA, 2, 1, "c");
  rect(b, 20, 25, 2, 6 - liftB, "o");
  rect(b, 20, 30 - liftB, 2, 1, "c");
  return [a, b];
}

interface Pose {
  dy?: number;
  tail?: number;
  head?: HeadOpts;
  headDx?: number;
  headDy?: number;
  legs?: Legs;
  /** Accesorios que van delante del cuerpo pero detrás de las patas (la laptop). */
  props?: Grid[];
}

const HEAD_X = 12;
const HEAD_Y = 9;

function sitting(p: Pose = {}): Grid {
  const g = blank();
  const dy = p.dy ?? 0;
  for (const t of tails(p.tail ?? 1)) composite(g, shift(t, 0, dy));
  composite(g, shift(body(), 0, dy));
  composite(g, shift(haunch(), 0, dy));
  for (const prop of p.props ?? []) composite(g, prop);
  for (const l of legs(p.legs ?? "sit")) composite(g, shift(l, 0, dy));
  composite(g, head(HEAD_X + (p.headDx ?? 0), HEAD_Y + dy + (p.headDy ?? 0), p.head));
  return g;
}

// ---------------------------------------------------------------------------
// Accesorios y efectos
// ---------------------------------------------------------------------------

const GLYPHS = {
  bang: ["pp", "pp", "pp", "pp", "..", "pp"],
  question: [".ppp.", "pp.pp", "...pp", "..pp.", "..pp.", ".....", "..pp."],
  zBig: ["ppppp", "...p.", "..p..", ".p...", "ppppp"],
  zSmall: ["pppp", "...p", "..p.", ".p..", "pppp"],
  sparkle: [".y.", "yyy", ".y."],
  sparkleP: [".p.", "ppp", ".p."],
  dot: ["y"],
  sparkleDot: ["y"],
  dotP: ["p"],
  tear: ["b", "b"],
};

function glyph(g: Grid, rows: string[], x: number, y: number, outline = true) {
  const l = blank();
  stamp(l, rows, x, y);
  composite(g, l, outline);
}

/** Efectos flotantes finos (z, chispas, puntos): sin contorno para que no se empasten. */
const fx = (g: Grid, rows: string[], x: number, y: number) => glyph(g, rows, x, y, false);

function laptop(): Grid[] {
  // Tapa abierta vista de espaldas (inclinada hacia el zorro) y teclado en el piso.
  const lid = blank();
  stamp(lid, [
    ".....ggg",
    "....ghhg",
    "....ghhg",
    "...ghhhg",
    "...ghphg",
    "..ghhhg.",
    "..ghhhg.",
    ".ghhhg..",
    "gggggg..",
  ], 23, 20);
  const base = blank();
  stamp(base, [
    "..hhhhhhhhhhhhh",
    ".hghghghghghgh.",
    "ggggggggggggg..",
  ], 16, 28);
  return [lid, base];
}

// ---------------------------------------------------------------------------
// Animaciones
// ---------------------------------------------------------------------------

function idleFrames(): Frame[] {
  return [
    sitting({ tail: 0 }),
    sitting({ tail: 1 }),
    sitting({ tail: 2 }),
    sitting({ tail: 1, head: { eyes: "blink" } }),
    sitting({ tail: 0 }),
    sitting({ tail: 1 }),
  ].map(toFrame);
}

// Cabeza dormida, apoyada en el piso: más baja y compacta, ojos cerrados y orejas hacia atrás.
const SLEEP_HEAD = [
  "oo..............",
  "occoolllllll....",
  ".ooooooooooooo..",
  "..oooooooooooooo.",
  "..ookkoooookkoooo.",
  "..sooooooooooocckk",
  "..ssccoooocccccc..",
  "...scccccccccccc..",
  ".....ccccccccc....",
];

function curled(breath: number, zStep: number): Frame {
  const g = blank();
  const up = breath; // el lomo sube 1 px al inhalar
  // Primera cola: detrás del lomo, con la punta hacia arriba.
  composite(g, tail([6, 28], [2, 22], [5, 15 - up], "s", 2.0));
  // Cuerpo enroscado.
  const b = blank();
  ellipse(b, 13, 26.5 - up * 0.5, 10.5, 4.5 + up * 0.5, (x, y) => (y > 28 ? "s" : x < 7 ? "s" : "o"));
  composite(g, b);
  // Segunda cola: se arquea sobre el lomo como una cobija.
  composite(g, tail([5, 28], [4, 16 - up], [13, 19 - up], "o", 2.0));
  // Tercera cola: rodea el frente; la cabeza descansa sobre ella.
  composite(g, tail([3, 26], [6, 30], [23, 28.3], "o", 1.8));
  const h = blank();
  stamp(h, SLEEP_HEAD, 13, 21 - up);
  composite(g, h);
  // "z" que suben.
  const zs: Array<Array<[string[], number, number]>> = [
    [[GLYPHS.zSmall, 25, 15]],
    [[GLYPHS.zSmall, 26, 12]],
    [[GLYPHS.zSmall, 25, 15], [GLYPHS.zBig, 26, 6]],
    [[GLYPHS.zSmall, 26, 12], [GLYPHS.zBig, 27, 3]],
  ];
  for (const [rows, x, y] of zs[zStep]) fx(g, rows, x, y);
  return toFrame(g);
}

function sleepingFrames(): Frame[] {
  return [curled(0, 0), curled(1, 1), curled(1, 2), curled(0, 3)];
}

function sniffingFrames(): Frame[] {
  const f = (nose: 0 | 1, headDy: number, t: number) =>
    toFrame(sitting({ tail: t, headDx: 1, headDy, head: { nose, eyes: "blink" } }));
  return [f(0, 3, 1), f(1, 3, 1), f(0, 4, 2), f(1, 4, 2), f(0, 3, 1), f(1, 2, 0)];
}

function alertFrames(): Frame[] {
  const hops = [0, -1, -2, -2, -1, 0];
  return hops.map((dy, i) => {
    const g = sitting({ dy, tail: i % 3, head: { ears: "up", eyes: "wide" } });
    glyph(g, GLYPHS.bang, 28, 1 + (i % 2));
    return toFrame(g);
  });
}

function workingFrames(): Frame[] {
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const g = sitting({
      tail: [0, 1, 2, 1, 0, 1][i],
      legs: i % 2 ? "typeA" : "typeB",
      head: { eyes: i === 4 ? "blink" : "open" },
      props: laptop(),
    });
    // Puntos del cursor que se van escribiendo sobre la laptop.
    for (let d = 0; d <= i % 3; d++) fx(g, GLYPHS.sparkleDot, 25 + d * 2, 2);
    return toFrame(g);
  });
}

function askingFrames(): Frame[] {
  const tilt = [0.18, 0.2, 0.18, 0.2];
  return tilt.map((t, i) => {
    const g = sitting({ tail: [0, 1, 2, 1][i], head: { tilt: -t, mouth: false } });
    glyph(g, GLYPHS.question, 26, i % 2);
    return toFrame(g);
  });
}

function celebrateFrames(): Frame[] {
  const frames: Frame[] = [];
  const spark = (g: Grid, step: number) => {
    const pts: Array<[number, number, string[]]> = [
      [4, 4, GLYPHS.sparkle], [26, 2, GLYPHS.sparkleP], [1, 14, GLYPHS.sparkleP], [28, 12, GLYPHS.sparkle],
    ];
    pts.forEach(([x, y, rows], i) => {
      if ((i + step) % 2 === 0) fx(g, rows, x, y);
      else fx(g, i % 2 ? GLYPHS.dotP : GLYPHS.dot, x + 1, y + 1);
    });
  };
  frames.push(toFrame(sitting({ headDy: 1, tail: 1, head: { eyes: "happy" } })));
  frames.push(toFrame(sitting({ dy: -2, tail: 2, head: { eyes: "happy" } })));
  let g = flip(sitting({ dy: -3, tail: 2, head: { eyes: "happy" } }));
  spark(g, 0);
  frames.push(toFrame(g));
  g = sitting({ dy: -3, tail: 0, head: { eyes: "happy" } });
  spark(g, 1);
  frames.push(toFrame(g));
  g = sitting({ dy: -1, tail: 1, head: { eyes: "happy" } });
  spark(g, 0);
  frames.push(toFrame(g));
  g = sitting({ headDy: 1, tail: 1, head: { eyes: "happy" } });
  spark(g, 1);
  frames.push(toFrame(g));
  g = sitting({ tail: 1, head: { eyes: "happy" } });
  fx(g, GLYPHS.dot, 5, 5);
  fx(g, GLYPHS.dotP, 29, 13);
  frames.push(toFrame(g));
  frames.push(idleFrames()[0]);
  return frames;
}

function sadFrames(): Frame[] {
  return [0, 1, 2, 3].map((i) => {
    const g = sitting({ tail: 0, headDy: 1, head: { ears: "down", eyes: "sad" } });
    const ty = [15, 17, 19, 22][i];
    glyph(g, GLYPHS.tear, 24, ty);
    return toFrame(g);
  });
}

const anim = (name: PetAnimation, frames: Frame[]): AnimationDef => ({ fps: REQUIRED[name].fps, loop: REQUIRED[name].loop, frames });

export const ANIMATIONS: Record<PetAnimation, AnimationDef> = {
  sleeping: anim("sleeping", sleepingFrames()),
  idle: anim("idle", idleFrames()),
  sniffing: anim("sniffing", sniffingFrames()),
  alert: anim("alert", alertFrames()),
  working: anim("working", workingFrames()),
  asking: anim("asking", askingFrames()),
  celebrate: anim("celebrate", celebrateFrames()),
  sad: anim("sad", sadFrames()),
};
