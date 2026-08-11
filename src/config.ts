import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface SydesConfig {
  codebaseMemoryBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SydesConfig {
  return {
    codebaseMemoryBin: env.SYDES_CBM_BIN ?? defaultCodebaseMemoryBin()
  };
}

function defaultCodebaseMemoryBin(): string {
  const localBin = resolve(process.cwd(), "node_modules/.bin/codebase-memory-mcp");
  return existsSync(localBin) ? localBin : "codebase-memory-mcp";
}
