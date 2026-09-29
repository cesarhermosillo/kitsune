import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePetToken } from "./pet-token.js";

const tmp = () => mkdtempSync(join(tmpdir(), "kitsune-pet-token-"));

test("crea un token hex de 64 caracteres con permisos 0600", () => {
  const dir = tmp();
  try {
    const token = ensurePetToken(dir);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(dir, "pet-token"), "utf8").trim(), token);
    assert.equal(statSync(join(dir, "pet-token")).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reutiliza un token existente y le corrige los permisos", () => {
  const dir = tmp();
  try {
    const existing = "a".repeat(64);
    writeFileSync(join(dir, "pet-token"), `${existing}\n`);
    chmodSync(join(dir, "pet-token"), 0o644);
    assert.equal(ensurePetToken(dir), existing);
    assert.equal(statSync(join(dir, "pet-token")).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("un token inválido se reemplaza", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "pet-token"), "corto");
    assert.match(ensurePetToken(dir), /^[0-9a-f]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
