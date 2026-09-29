// Animated GIF for the README (docs/images/fox-animated.gif): a few of the fox's animations side
// by side, each at its own fps. Frames come from art/ (same source as the sprite sheet);
// ffmpeg (if installed) turns them into a GIF. Skipped with a notice when ffmpeg is missing.
//
// Called by capture.ts (`npm run readme-shots`).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANIMATIONS } from "../../art/fox";
import { PALETTE } from "../../art/palette";
import { encodePng } from "../../art/png";
import { buildSheet, scaleNearest } from "../../art/sheet";

const NAMES = ["idle", "alert", "working", "celebrate"] as const;
const FPS = 24;
const SECONDS = 3;
const SCALE = 4;
const BG = [58, 62, 79, 255];

export function writeFoxGif(outDir: string): void {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    console.log("ffmpeg not found: skipping fox-animated.gif");
    return;
  }

  const { width: sheetW, rgba: sheet, meta } = buildSheet(ANIMATIONS, PALETTE);
  const size = meta.frameSize;
  const w = size * NAMES.length;
  const tmp = mkdtempSync(join(tmpdir(), "kitsune-gif-"));
  try {
    for (let f = 0; f < FPS * SECONDS; f++) {
      const t = f / FPS;
      const strip = new Uint8Array(w * size * 4);
      for (let i = 0; i < strip.length; i += 4) strip.set(BG, i);
      NAMES.forEach((name, col) => {
        const anim = meta.animations[name];
        const step = Math.floor(t * anim.fps);
        const idx = anim.loop ? step % anim.frames.length : Math.min(step, anim.frames.length - 1);
        const { x: fx, y: fy } = anim.frames[idx];
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const s = ((fy + y) * sheetW + fx + x) * 4;
            if (sheet[s + 3] === 0) continue;
            strip.set(sheet.subarray(s, s + 4), (y * w + col * size + x) * 4);
          }
        }
      });
      const big = scaleNearest(w, size, strip, SCALE);
      writeFileSync(join(tmp, `f${String(f).padStart(3, "0")}.png`), encodePng(big.width, big.height, big.rgba));
    }
    const out = join(outDir, "fox-animated.gif");
    const r = spawnSync(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        String(FPS),
        "-i",
        join(tmp, "f%03d.png"),
        "-vf",
        "split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=none",
        "-loop",
        "0",
        out,
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error("ffmpeg failed");
    console.log(`wrote ${out}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
