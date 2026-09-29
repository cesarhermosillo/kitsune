// Takes the README screenshots of the pet bubble flow (docs/images/pet-*.png) and the fox GIF.
// Serves the real pet UI with a fake daemon (scripts/readme-shots/vite.config.ts), drives a
// headless Chrome through the DevTools Protocol, and closes both when done. No window is shown,
// nothing talks to the real Kitsune daemon.
//
//   npm run readme-shots [-- <outDir>]      (default: ../docs/images)
//   CHROME=/path/to/chrome SHOTS_PORT=5199  (optional overrides)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { writeFoxGif } from "./fox-gif";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, "../../../docs/images"));
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = ["collapsed", "expanded", "choose", "confirm", "result"] as const;
const VIEW = { width: 320, height: 330, deviceScaleFactor: 2 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, what: string, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, (msg: { result?: any; error?: unknown }) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  };
  const opened = new Promise<void>((r) => { ws.onopen = () => r(); });
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    await opened;
    const msgId = ++id;
    const msg = await new Promise<{ result?: any; error?: unknown }>((r) => {
      pending.set(msgId, r);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  };
  return { send, close: () => ws.close() };
}

const server = await createServer({ configFile: join(here, "vite.config.ts") });
await server.listen();
const port = server.config.server.port;
const profile = mkdtempSync(join(tmpdir(), "kitsune-shots-"));
const browser = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
], { stdio: "ignore" });

try {
  const portFile = join(profile, "DevToolsActivePort");
  const devtoolsPort = await waitFor(() => (existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n")[0] || undefined : undefined), "Chrome");
  const targets = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = cdp(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await page.send("Emulation.setDeviceMetricsOverride", { ...VIEW, mobile: false });

  for (const shot of SHOTS) {
    await page.send("Page.navigate", { url: `http://127.0.0.1:${port}/scripts/readme-shots/desktop.html?shot=${shot}` });
    await waitFor(async () => {
      const r = await page.send("Runtime.evaluate", {
        expression: `document.getElementById("pet")?.contentDocument?.documentElement.dataset.shotReady === "1" || undefined`,
        returnByValue: true,
      });
      return r.result.value;
    }, `shot ${shot}`);
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    const file = join(outDir, `pet-${shot}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`wrote ${file}`);
  }
  page.close();
} finally {
  browser.kill();
  await server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

writeFoxGif(outDir);
