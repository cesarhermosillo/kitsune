import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VALID = /^[0-9a-f]{64}$/;

/** Token compartido con la mascota (~/.kitsune/pet-token). Solo el dueño puede leerlo. */
export function ensurePetToken(dir: string): string {
  const path = join(dir, "pet-token");
  let token = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
  if (!VALID.test(token)) {
    token = randomBytes(32).toString("hex");
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return token;
}
