import { writeFileSync } from "node:fs";
import { ANIMATIONS } from "./fox";
import { PALETTE } from "./palette";
import { encodePng } from "./png";
import { buildSheet, scaleNearest } from "./sheet";

const sheet = buildSheet(ANIMATIONS, PALETTE);
// fondo gris medio para ver la silueta y el contorno
const bg = new Uint8Array(sheet.rgba);
for (let i = 0; i < bg.length; i += 4) if (bg[i + 3] === 0) bg.set([58, 62, 79, 255], i);
const big = scaleNearest(sheet.width, sheet.height, bg, 8);
writeFileSync(process.argv[2] ?? "/tmp/kitsune-contact.png", encodePng(big.width, big.height, big.rgba));
