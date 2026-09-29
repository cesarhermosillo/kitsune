import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, loadConfig, parseEnv } from "./config.js";

function dir(files: { config?: unknown; env?: string; envMode?: number }) {
  const d = mkdtempSync(join(tmpdir(), "kitsune-cfg-"));
  if (files.config !== undefined) writeFileSync(join(d, "config.json"), JSON.stringify(files.config));
  if (files.env !== undefined) {
    writeFileSync(join(d, ".env"), files.env);
    chmodSync(join(d, ".env"), files.envMode ?? 0o600);
  }
  return { d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

const ENV = "CLICKUP_TOKEN=pk_test\nTELEGRAM_BOT_TOKEN=123:abc\n# comentario\nRONIN_CAPABILITY_TOKEN=cap\n";
const MIN = { clickup: { listIds: ["901"] }, telegram: { chatId: 42 } };

test("parseEnv ignora comentarios y líneas vacías y quita comillas", () => {
  assert.deepEqual(parseEnv("A=1\n\n# x\nB=\"dos\"\nC='tres'\n"), { A: "1", B: "dos", C: "tres" });
});

test("loadConfig aplica valores por defecto", () => {
  const { d, cleanup } = dir({ config: MIN, env: ENV });
  try {
    const { config, secrets } = loadConfig(d);
    assert.deepEqual(config, {
      engine: "claude", engineTimeoutSec: 60, poll: { intervalSec: 60 },
      clickup: { listIds: ["901"] }, telegram: { chatId: 42 },
      ronin: { url: "http://localhost:8787" }, proposals: { ttlHours: 24 }, favoriteWorkflows: [],
    });
    assert.deepEqual(secrets, { clickupToken: "pk_test", telegramBotToken: "123:abc", roninCapabilityToken: "cap" });
  } finally { cleanup(); }
});

test("A: loadConfig acepta favoriteWorkflows y rechaza uno inválido", () => {
  const ok = dir({ config: { ...MIN, favoriteWorkflows: ["claude-plan-codex-impl", "pr-review-merge-dev"] }, env: ENV });
  try { assert.deepEqual(loadConfig(ok.d).config.favoriteWorkflows, ["claude-plan-codex-impl", "pr-review-merge-dev"]); } finally { ok.cleanup(); }

  for (const bad of [{ ...MIN, favoriteWorkflows: [1, 2] }, { ...MIN, favoriteWorkflows: [""] }, { ...MIN, favoriteWorkflows: "x" }]) {
    const { d, cleanup } = dir({ config: bad, env: ENV });
    try { assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && /favoriteWorkflows/.test(e.message)); } finally { cleanup(); }
  }
});

test("A: favoriteWorkflows deduplica manteniendo el orden", () => {
  const { d, cleanup } = dir({ config: { ...MIN, favoriteWorkflows: ["hotfix", "pr-review-merge-dev", "hotfix", "claude-plan-codex-impl", "pr-review-merge-dev"] }, env: ENV });
  try { assert.deepEqual(loadConfig(d).config.favoriteWorkflows, ["hotfix", "pr-review-merge-dev", "claude-plan-codex-impl"]); } finally { cleanup(); }
});

test("loadConfig rechaza un .env legible por otros usuarios", () => {
  const { d, cleanup } = dir({ config: MIN, env: ENV, envMode: 0o644 });
  try {
    assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && /chmod 600/.test(e.message));
  } finally { cleanup(); }
});

test("loadConfig exige los tres secretos", () => {
  const { d, cleanup } = dir({ config: MIN, env: "CLICKUP_TOKEN=x\n" });
  try {
    assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && /TELEGRAM_BOT_TOKEN/.test(e.message));
  } finally { cleanup(); }
});

test("loadConfig exige chatId numérico y al menos una lista", () => {
  for (const bad of [{ clickup: { listIds: [] }, telegram: { chatId: 42 } }, { clickup: { listIds: ["1"] }, telegram: { chatId: "42" } }]) {
    const { d, cleanup } = dir({ config: bad, env: ENV });
    try { assert.throws(() => loadConfig(d), ConfigError); } finally { cleanup(); }
  }
});

test("loadConfig rechaza un motor desconocido", () => {
  const { d, cleanup } = dir({ config: { ...MIN, engine: "gpt" }, env: ENV });
  try { assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && /engine/.test(e.message)); } finally { cleanup(); }
});

test("loadConfig sin config.json explica cómo crearlo", () => {
  const { d, cleanup } = dir({ env: ENV });
  try { assert.throws(() => loadConfig(d), (e: unknown) => e instanceof ConfigError && /config\.json/.test(e.message)); } finally { cleanup(); }
});
