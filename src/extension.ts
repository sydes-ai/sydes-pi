import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { CbmClient } from "./cbm/client.js";
import { findExecutable } from "./cbm/paths.js";
import { loadConfig } from "./config.js";
import { buildExplorationGuidance, buildRelevantContext, resolveCbmProject } from "./policy/exploration.js";
import type { RelevantContext } from "./policy/types.js";

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
  policyEnabled: boolean;
  activate(context?: SydesExtensionContext): Promise<void>;
}

export function createSydesExtension(): SydesExtension {
  const config = loadConfig();
  const cbm = new CbmClient({ bin: config.codebaseMemoryBin });

  return {
    name: "sydes",
    phase: "foundation",
    cbm,
    policyEnabled: true,
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

export interface SydesRuntimeState {
  lastContext: RelevantContext | null;
  lastReason: string | null;
}

export default function sydesPiExtension(pi: ExtensionAPI): void {
  const extension = createSydesExtension();
  const state: SydesRuntimeState = {
    lastContext: null,
    lastReason: null
  };

  pi.registerCommand("sydes-status", {
    description: "Show Sydes graph policy status",
    handler: async (_args, ctx) => {
      const cbmPath = await findExecutable(extension.cbm.bin);
      const resolution = await resolveCbmProject(ctx.cwd, extension.cbm).catch((error: unknown) => ({
        project: null,
        reason: error instanceof Error ? error.message : String(error)
      }));
      ctx.ui.notify(
        [
          "Sydes status",
          `policy: ${extension.policyEnabled ? "enabled" : "disabled"}`,
          `cbm: ${cbmPath ?? "not found"}`,
          `project: ${resolution.project?.name ?? "unresolved"}`,
          resolution.reason ? `reason: ${resolution.reason}` : undefined
        ]
          .filter(Boolean)
          .join("\n"),
        "info"
      );
    }
  });

  pi.registerCommand("sydes-context", {
    description: "Build Sydes graph context for a task without calling a model",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /sydes-context <task>", "warning");
        return;
      }

      const context = await buildRelevantContext(task, ctx.cwd, extension.cbm);
      if (!context) {
        state.lastContext = null;
        state.lastReason = "Sydes could not resolve graph context";
        ctx.ui.notify(state.lastReason, "warning");
        return;
      }

      state.lastContext = context;
      state.lastReason = null;
      ctx.ui.notify(renderDebugContext(context), "info");
    }
  });

  pi.registerCommand("sydes-context-last", {
    description: "Show the last Sydes graph context from this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        state.lastContext ? renderDebugContext(state.lastContext) : state.lastReason ?? "No Sydes context yet",
        state.lastContext ? "info" : "warning"
      );
    }
  });

  pi.on("before_agent_start", createBeforeAgentStartHandler(extension.cbm, state));
}

export function createBeforeAgentStartHandler(cbm: CbmClient, state: SydesRuntimeState) {
  return async (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!shouldInjectForPrompt(event.prompt)) {
      return undefined;
    }

    const context = await buildRelevantContext(event.prompt, ctx.cwd, cbm);
    if (!context) {
      state.lastContext = null;
      state.lastReason = "Sydes graph guidance unavailable";
      return undefined;
    }

    const guidance = buildExplorationGuidance(context);
    state.lastContext = context;
    state.lastReason = null;
    return {
      message: {
        customType: "sydes-graph-guidance",
        content: guidance,
        display: true,
        details: { context }
      }
    };
  };
}

export function shouldInjectForPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return false;
  }
  return /(fix|add|update|change|implement|test|bug|route|api|endpoint|handler|function|class|method|file|code|repo|build|run|edit|write)/i.test(
    trimmed
  );
}

export function renderDebugContext(context: RelevantContext): string {
  return [
    "Sydes context",
    `project: ${context.project}`,
    `entry points: ${context.entryPoints.map((symbol) => `${symbol.filePath ?? "?"}:${symbol.name}`).join(", ") || "none"}`,
    `files: ${context.files.join(", ") || "none"}`,
    `tests: ${context.tests.join(", ") || "none"}`,
    `relationships: ${context.relationships.length}`,
    `query count: ${context.querySummary.queryCount}`,
    `elapsed ms: ${context.querySummary.elapsedMs}`,
    "",
    buildExplorationGuidance(context)
  ].join("\n");
}
