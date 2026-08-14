import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface SydesConfig {
  codebaseMemoryBin: string;
  integrationMode: SydesIntegrationMode;
}

export type SydesIntegrationMode = "graph-guidance" | "tool-middleware";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SydesConfig {
  return {
    codebaseMemoryBin: env.SYDES_CBM_BIN ?? defaultCodebaseMemoryBin(),
    integrationMode: parseIntegrationMode(env.SYDES_INTEGRATION_MODE)
  };
}

function parseIntegrationMode(value: string | undefined): SydesIntegrationMode {
  return value === "tool-middleware" ? "tool-middleware" : "graph-guidance";
}

function defaultCodebaseMemoryBin(): string {
  const localBin = resolve(process.cwd(), "node_modules/.bin/codebase-memory-mcp");
  return existsSync(localBin) ? localBin : "codebase-memory-mcp";
}
