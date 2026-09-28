export interface Engine {
  readonly name: string;
  complete(prompt: string, opts: { timeoutMs: number }): Promise<string>;
}

export class EngineError extends Error {
  constructor(readonly engine: string, message: string) {
    super(`${engine}: ${message}`);
  }
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunProcess = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; cwd: string; stdin?: string }
) => Promise<ProcessResult>;
