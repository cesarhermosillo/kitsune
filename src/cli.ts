#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nodeSleep } from "node:timers/promises";
import { createKitsuneApp, processUpdates } from "./app.js";
import { createBrain, createRedactor } from "./brain.js";
import { createTelegramApi } from "./channels/telegram-api.js";
import { createTelegramChannel } from "./channels/telegram.js";
import { ConfigError, defaultConfigDir, loadConfig } from "./config.js";
import { createClickUpConnector } from "./connectors/clickup.js";
import { startLoops } from "./daemon.js";
import { createEngine } from "./engines/index.js";
import { runProcess } from "./engines/process.js";
import { createPolicy } from "./policy.js";
import { createRoninClient } from "./ronin-client.js";
import { openStore } from "./store.js";
import { createWatcher } from "./watcher.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

// Duerme hasta `ms` o hasta que `signal` se aborte (usado por stop() para no
// esperar el backoff completo, hasta maxBackoffMs, al apagar el daemon).
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await nodeSleep(ms, undefined, { signal });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}

function build(dir: string) {
  const { config, secrets } = loadConfig(dir);
  const secretList = [secrets.clickupToken, secrets.telegramBotToken, secrets.roninCapabilityToken];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = join(dir, "kitsune.db");
  const store = openStore(dbPath);
  // La base guarda auditoría y contenido de ClickUp: solo el dueño la lee (también -wal/-shm).
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  const engine = createEngine(config.engine, {
    run: runProcess, tmpDir: () => mkdtempSync(join(tmpdir(), "kitsune-engine-")),
    removeDir: (d) => rmSync(d, { recursive: true, force: true }), readFile: (p) => readFileSync(p, "utf8"),
  });
  const api = createTelegramApi({ token: secrets.telegramBotToken, fetch });
  const channel = createTelegramChannel({ api, chatId: config.telegram.chatId });
  const ronin = createRoninClient({ url: config.ronin.url, token: secrets.roninCapabilityToken, fetch });
  const clickup = createClickUpConnector({ token: secrets.clickupToken, listIds: config.clickup.listIds, fetch, now: Date.now });
  const app = createKitsuneApp({
    store, brain: createBrain(engine, { timeoutMs: config.engineTimeoutSec * 1000, secrets: secretList }), ronin, channel,
    policy: createPolicy({ chatId: config.telegram.chatId }), now: Date.now, ttlMs: config.proposals.ttlHours * 3_600_000, log,
    favoriteWorkflows: config.favoriteWorkflows,
  });
  return { config, store, engine, api, channel, ronin, clickup, app, redact: createRedactor(secretList), watcher: createWatcher({ store, ronin, channel }) };
}

async function start(dir: string) {
  const k = build(dir);
  const interrupted = await k.app.recoverInterrupted();
  if (interrupted > 0) log(`${interrupted} propuesta(s) interrumpida(s) marcadas como fallidas`);
  log(`Kitsune listo · motor ${k.config.engine} · Ronin ${k.config.ronin.url}`);
  const handle = startLoops([
    {
      name: "clickup", intervalMs: k.config.poll.intervalSec * 1000,
      run: async () => {
        // Primera vez: solo la última hora, para no inundar Telegram ni el rate limit de ClickUp.
        const since = Number(k.store.getCursor("clickup") ?? Date.now() - 3_600_000);
        const { events, nextCursor } = await k.clickup.poll(since);
        for (const event of events) await k.app.onInboxEvent(event);
        k.store.setCursor("clickup", String(nextCursor));
      },
      onAlert: async (e) => { await k.channel.sendNotice(`⚠️ ClickUp falla repetidamente: ${e instanceof Error ? e.message : String(e)}`); },
    },
    {
      // Long polling (`timeout: 30`): cada llamada a getUpdates puede tardar hasta 30 s
      // antes de resolver; intervalMs: 1000 solo separa ciclos consecutivos, no limita esta espera.
      // Sin onAlert: si el propio canal de Telegram falla no hay por dónde avisar al usuario.
      // processUpdates aísla cada update y siempre avanza el offset (a lo más una vez).
      name: "telegram", intervalMs: 1000,
      run: async () => {
        const offset = Number(k.store.getCursor("telegram") ?? 0);
        const updates = await k.api.getUpdates(offset, 30);
        await processUpdates(updates, { app: k.app, store: k.store, log, now: Date.now });
      },
    },
    {
      name: "watcher", intervalMs: 15_000, run: () => k.watcher.tick(),
      onAlert: async (e) => { await k.channel.sendNotice(`⚠️ No puedo consultar a Ronin: ${e instanceof Error ? e.message : String(e)}`); },
    },
    {
      // Además de expirar, reenvía las propuestas cuyo envío a Telegram falló.
      // Los avisos (sendNotice) son best-effort: si fallan no se reenvían.
      name: "expiry", intervalMs: 60_000, run: async () => { await k.app.sweepExpired(); await k.app.redeliver(); },
      onAlert: async (e) => { await k.channel.sendNotice(`⚠️ El barrido de propuestas falla repetidamente: ${e instanceof Error ? e.message : String(e)}`); },
    },
  ], { sleep, log, maxBackoffMs: 300_000, alertAfter: 5 });
  const shutdown = async () => { log("deteniendo…"); await handle.stop(); k.store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function doctor(dir: string) {
  const checks: Array<[string, () => Promise<string>]> = [];
  let k: ReturnType<typeof build>;
  try { k = build(dir); } catch (e) { console.log(`✖ configuración: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; return; }
  checks.push(["ClickUp", async () => `${(await k.clickup.poll(Date.now())).events.length} eventos recientes`]);
  checks.push(["Telegram", async () => { await k.channel.sendNotice("🦊 Kitsune doctor: conexión OK"); return "mensaje de prueba enviado"; }]);
  checks.push(["Ronin", async () => { const c = await k.ronin.catalog(); return `${c.repos.length} repos, ${c.workflows.length} workflows`; }]);
  checks.push([`Motor (${k.config.engine})`, async () => k.redact(await k.engine.complete('Responde exactamente: {"ok":true}', { timeoutMs: 60_000 })).slice(0, 60)]);
  for (const [name, check] of checks) {
    try { console.log(`✔ ${name}: ${await check()}`); } catch (e) { console.log(`✖ ${name}: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
  }
  k.store.close();
}

const [command = "start"] = process.argv.slice(2);
const dir = process.env.KITSUNE_HOME ?? defaultConfigDir();
try {
  if (command === "start") await start(dir);
  else if (command === "doctor") await doctor(dir);
  else { console.log("uso: kitsune [start|doctor]"); process.exitCode = 64; }
} catch (e) {
  console.error(e instanceof ConfigError ? `configuración: ${e.message}` : e);
  process.exitCode = 1;
}
