import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EngineName = "claude" | "codex" | "agy";
export interface KitsuneConfig {
  engine: EngineName;
  engineTimeoutSec: number;
  poll: { intervalSec: number };
  clickup: { listIds: string[] };
  telegram: { chatId: number };
  ronin: { url: string };
  proposals: { ttlHours: number };
  favoriteWorkflows: string[];
}
export interface Secrets { clickupToken: string; telegramBotToken: string; roninCapabilityToken: string }
export class ConfigError extends Error {}

const ENGINES: EngineName[] = ["claude", "codex", "agy"];

export function defaultConfigDir(): string {
  return join(homedir(), ".kitsune");
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function positive(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new ConfigError(`${key} debe ser un número positivo`);
  return value;
}

export function loadConfig(dir: string): { config: KitsuneConfig; secrets: Secrets } {
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) throw new ConfigError(`falta ${configPath}; copia config.example.json y ajústalo`);
  let raw: Record<string, any>;
  try { raw = JSON.parse(readFileSync(configPath, "utf8")); } catch { throw new ConfigError(`${configPath} no es JSON válido`); }

  const engine = raw.engine ?? "claude";
  if (!ENGINES.includes(engine)) throw new ConfigError(`engine debe ser uno de: ${ENGINES.join(", ")}`);
  const listIds = raw.clickup?.listIds;
  if (!Array.isArray(listIds) || listIds.length === 0 || !listIds.every((id) => typeof id === "string" && id.trim())) {
    throw new ConfigError("clickup.listIds debe ser una lista no vacía de ids");
  }
  const chatId = raw.telegram?.chatId;
  if (typeof chatId !== "number" || !Number.isInteger(chatId)) throw new ConfigError("telegram.chatId debe ser un número entero");
  const url = raw.ronin?.url ?? "http://localhost:8787";
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new ConfigError("ronin.url debe ser una URL http(s)");
  const favoriteWorkflows = raw.favoriteWorkflows ?? [];
  if (!Array.isArray(favoriteWorkflows) || !favoriteWorkflows.every((w) => typeof w === "string" && w.trim())) {
    throw new ConfigError("favoriteWorkflows debe ser una lista de strings no vacíos");
  }

  const config: KitsuneConfig = {
    engine,
    engineTimeoutSec: positive(raw.engineTimeoutSec, 60, "engineTimeoutSec"),
    poll: { intervalSec: positive(raw.poll?.intervalSec, 60, "poll.intervalSec") },
    clickup: { listIds },
    telegram: { chatId },
    ronin: { url: url.replace(/\/+$/, "") },
    proposals: { ttlHours: positive(raw.proposals?.ttlHours, 24, "proposals.ttlHours") },
    favoriteWorkflows,
  };

  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) throw new ConfigError(`falta ${envPath}`);
  if ((statSync(envPath).mode & 0o077) !== 0) throw new ConfigError(`${envPath} es legible por otros usuarios; corre: chmod 600 ${envPath}`);
  const env = parseEnv(readFileSync(envPath, "utf8"));
  const need = (key: string) => {
    const value = env[key];
    if (!value) throw new ConfigError(`falta ${key} en ${envPath}`);
    return value;
  };
  const secrets: Secrets = {
    clickupToken: need("CLICKUP_TOKEN"),
    telegramBotToken: need("TELEGRAM_BOT_TOKEN"),
    roninCapabilityToken: need("RONIN_CAPABILITY_TOKEN"),
  };
  return { config, secrets };
}
