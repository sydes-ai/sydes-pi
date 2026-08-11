import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CbmClient } from "./cbm/client.js";
import { findExecutable } from "./cbm/paths.js";
import { loadConfig } from "./config.js";

export interface SydesExtensionContext {
  registerTool?: (tool: unknown) => void;
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

export interface SydesExtension {
  name: "sydes";
  phase: "foundation";
  cbm: CbmClient;
  activate(context?: SydesExtensionContext): Promise<void>;
}

export function createSydesExtension(): SydesExtension {
  const config = loadConfig();
  const cbm = new CbmClient({ bin: config.codebaseMemoryBin });

  return {
    name: "sydes",
    phase: "foundation",
    cbm,
    async activate(context) {
      const cbmPath = await findExecutable(config.codebaseMemoryBin);
      if (cbmPath) {
        context?.logger?.info?.(`Sydes foundation loaded with Codebase Memory at ${cbmPath}`);
      } else {
        context?.logger?.warn?.(
          "Sydes foundation loaded, but codebase-memory-mcp was not found on PATH"
        );
      }
    }
  };
}

export default function sydesPiExtension(_pi: ExtensionAPI): void {
  createSydesExtension();
}
