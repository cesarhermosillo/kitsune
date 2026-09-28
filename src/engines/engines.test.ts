import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "./index.js";
import { EngineError, type RunProcess } from "./types.js";

function recorder(result: { code?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }) {
  const calls: Array<{ cmd: string; args: string[]; stdin?: string; cwd: string }> = [];
  const run: RunProcess = async (cmd, args, opts) => {
    calls.push({ cmd, args, stdin: opts.stdin, cwd: opts.cwd });
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.timedOut ?? false };
  };
  return { run, calls };
}
const deps = (run: RunProcess, files: Record<string, string> = {}) => ({ run, tmpDir: () => "/tmp/k1", readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; } });

test("claude: sin herramientas, prompt por stdin, devuelve .result", async () => {
  const { run, calls } = recorder({ stdout: JSON.stringify({ result: "{\"action\":\"ignore\"}" }) });
  const out = await createEngine("claude", deps(run)).complete("hola", { timeoutMs: 1000 });
  assert.equal(out, "{\"action\":\"ignore\"}");
  assert.deepEqual(calls, [{ cmd: "claude", args: ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"], stdin: "hola", cwd: "/tmp/k1" }]);
});

test("claude: is_error o JSON inválido lanza EngineError", async () => {
  await assert.rejects(() => createEngine("claude", deps(recorder({ stdout: JSON.stringify({ result: "x", is_error: true }) }).run)).complete("p", { timeoutMs: 1 }), EngineError);
  await assert.rejects(() => createEngine("claude", deps(recorder({ stdout: "no json" }).run)).complete("p", { timeoutMs: 1 }), EngineError);
});

test("codex: lee el último mensaje del archivo de salida", async () => {
  const { run, calls } = recorder({});
  const out = await createEngine("codex", deps(run, { "/tmp/k1/last.txt": "respuesta" })).complete("hola", { timeoutMs: 1000 });
  assert.equal(out, "respuesta");
  assert.deepEqual(calls[0].args, ["exec", "--skip-git-repo-check", "-s", "read-only", "-o", "/tmp/k1/last.txt", "-"]);
  assert.equal(calls[0].stdin, "hola");
});

test("agy: prompt como argumento, devuelve stdout", async () => {
  const { run, calls } = recorder({ stdout: "respuesta\n" });
  assert.equal(await createEngine("agy", deps(run)).complete("hola", { timeoutMs: 1000 }), "respuesta");
  assert.deepEqual(calls[0].args, ["-p", "hola", "--output-format", "text", "--sandbox"]);
});

test("timeout y código de salida distinto de 0 lanzan EngineError", async () => {
  await assert.rejects(() => createEngine("agy", deps(recorder({ timedOut: true }).run)).complete("p", { timeoutMs: 1 }), (e: unknown) => e instanceof EngineError && /tiempo/.test(e.message));
  await assert.rejects(() => createEngine("agy", deps(recorder({ code: 2, stderr: "boom" }).run)).complete("p", { timeoutMs: 1 }), (e: unknown) => e instanceof EngineError && /boom/.test(e.message));
});

test("runProcess real: captura stdout, stdin y timeout", async () => {
  const { runProcess } = await import("./process.js");
  const echo = await runProcess("cat", [], { timeoutMs: 5000, cwd: process.cwd(), stdin: "eco" });
  assert.deepEqual({ code: echo.code, stdout: echo.stdout, timedOut: echo.timedOut }, { code: 0, stdout: "eco", timedOut: false });
  const slow = await runProcess("sleep", ["5"], { timeoutMs: 100, cwd: process.cwd() });
  assert.equal(slow.timedOut, true);
});
