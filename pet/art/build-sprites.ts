import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANIMATIONS } from "./fox";
import { PALETTE } from "./palette";
import { encodePng } from "./png";
import { buildSheet, scaleNearest } from "./sheet";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(out, { recursive: true });
const sheet = buildSheet(ANIMATIONS, PALETTE);
writeFileSync(join(out, "sprites.png"), encodePng(sheet.width, sheet.height, sheet.rgba));
writeFileSync(join(out, "sprites.json"), `${JSON.stringify(sheet.meta, null, 2)}\n`);

// Ícono de la app: primer cuadro de idle a 16× (512×512).
const first = buildSheet({ icon: { fps: 1, loop: false, frames: [ANIMATIONS.idle.frames[0]] } }, PALETTE);
const icon = scaleNearest(first.width, first.height, first.rgba, 16);
writeFileSync(join(out, "icon.png"), encodePng(icon.width, icon.height, icon.rgba));
console.log(`sprites: ${sheet.width}×${sheet.height}, ${Object.keys(sheet.meta.animations).length} animaciones`);
