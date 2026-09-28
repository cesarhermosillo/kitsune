import { join } from "node:path";
import type { EngineName } from "../config.js";
import { EngineError, type Engine, type ProcessResult, type RunProcess } from "./types.js";

interface EngineDeps {
  run: RunProcess;
  tmpDir: () => string;
  readFile: (path: string) => string;
}

function check(engine: string, result: ProcessResult): void {
  if (result.timedOut) throw new EngineError(engine, "se agotó el tiempo de espera");
  if (result.code !== 0)
    throw new EngineError(engine, `salió con código ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
}

export function createEngine(name: EngineName, deps: EngineDeps): Engine {
  if (name === "claude") {
    return {
      name,
      async complete(prompt, { timeoutMs }) {
        const result = await deps.run(
          "claude",
          ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
          { timeoutMs, cwd: deps.tmpDir(), stdin: prompt }
        );
        check(name, result);
        let parsed: { result?: unknown; is_error?: boolean };
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          throw new EngineError(name, "la salida no es JSON");
        }
        if (parsed.is_error || typeof parsed.result !== "string") {
          throw new EngineError(name, "respuesta con error o sin result");
        }
        return parsed.result;
      },
    };
  }
  if (name === "codex") {
    return {
      name,
      async complete(prompt, { timeoutMs }) {
        const dir = deps.tmpDir();
        const out = join(dir, "last.txt");
        // Codex no tiene un modo "sin herramientas" verificable: se apagan las herramientas de
        // shell (`--disable shell_tool`, `--disable unified_exec`, ver `codex features list`) y se
        // deja el sandbox en solo lectura. No se considera tool-less (ver README).
        const result = await deps.run("codex", ["exec", "--skip-git-repo-check", "-s", "read-only",
          "--disable", "shell_tool", "--disable", "unified_exec", "-o", out, "-"],
          { timeoutMs, cwd: dir, stdin: prompt }
        );
        check(name, result);
        try {
          return deps.readFile(out).trim();
        } catch {
          throw new EngineError(name, "no escribió el último mensaje");
        }
      },
    };
  }
  return {
    name,
    async complete(prompt, { timeoutMs }) {
      const result = await deps.run("agy", ["-p", prompt, "--output-format", "text", "--sandbox"],
        { timeoutMs, cwd: deps.tmpDir() }
      );
      check(name, result);
      return result.stdout.trim();
    },
  };
}
