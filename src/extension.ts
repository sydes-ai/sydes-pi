import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { CbmClient } from "./cbm/client.js";
import { findExecutable } from "./cbm/paths.js";
import { loadConfig } from "./config.js";
import { buildExplorationGuidance, buildRelevantContext, ensureProjectForRepo } from "./policy/exploration.js";
import {
  buildAffectedContext,
  buildImpactGuidance,
  normalizeRepoPath as normalizeImpactPath
} from "./policy/impact.js";
import type { AffectedContext, RelevantContext } from "./policy/types.js";
import type { ProjectEnsureCacheEntry } from "./policy/types.js";
import { SydesTelemetryRecorder } from "./telemetry/recorder.js";

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
  lastAffectedContext: AffectedContext | null;
  lastReason: string | null;
  impactDirty: boolean;
  pendingMutations: ObservedMutation[];
  testCommandsAfterLastMutation: ObservedTestCommand[];
  lastImpactSignature: string | null;
  projectCache: Map<string, ProjectEnsureCacheEntry>;
  impactInjectionBoundary: "context";
  telemetry?: SydesTelemetryRecorder;
}

export interface ObservedMutation {
  filePath: string;
  toolName: "edit" | "write";
  timestamp: number;
  toolCallId: string;
}

export interface ObservedTestCommand {
  command: string;
  timestamp: number;
  toolCallId: string;
}

export default function sydesPiExtension(pi: ExtensionAPI): void {
  const extension = createSydesExtension();
  const state: SydesRuntimeState = {
    lastContext: null,
    lastAffectedContext: null,
    impactDirty: false,
    pendingMutations: [],
    testCommandsAfterLastMutation: [],
    lastImpactSignature: null,
    lastReason: null,
    projectCache: new Map(),
    impactInjectionBoundary: "context",
    telemetry: new SydesTelemetryRecorder()
  };

  pi.registerCommand("sydes-status", {
    description: "Show Sydes graph policy status",
    handler: async (_args, ctx) => {
      const cbmPath = await findExecutable(extension.cbm.bin);
      const resolution = await ensureProjectForRepo(ctx.cwd, extension.cbm, {
        allowIndex: true,
        cache: state.projectCache
      }).catch((error: unknown) => ({
        project: null,
        indexedThisSession: false,
        reason: error instanceof Error ? error.message : String(error)
      }));
      ctx.ui.notify(
        [
          "Sydes status",
          `policy: ${extension.policyEnabled ? "enabled" : "disabled"}`,
          `cbm: ${cbmPath ?? "not found"}`,
          `CBM transport: ${extension.cbm.transportKind}`,
          `project: ${resolution.project?.name ?? "unresolved"}`,
          `project indexed this session: ${resolution.indexedThisSession ? "yes" : "no"}`,
          `exploration policy ready: ${state.lastContext?.entryPoints.length ? "yes" : "no"}`,
          `impact injection boundary: ${state.impactInjectionBoundary}`,
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

      const context = await buildRelevantContext(task, ctx.cwd, extension.cbm, {
        allowIndex: true,
        projectCache: state.projectCache
      });
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

  pi.registerCommand("sydes-impact", {
    description: "Build Sydes impact guidance for the current git diff without calling a model",
    handler: async (_args, ctx) => {
      const affected = await buildAffectedContext(ctx.cwd, extension.cbm, undefined, {
        allowIndex: true,
        cache: state.projectCache
      });
      if (!affected) {
        state.lastReason = "No current changes or Sydes impact context unavailable";
        ctx.ui.notify(state.lastReason, "warning");
        return;
      }
      state.lastAffectedContext = affected;
      state.lastImpactSignature = affected.signature;
      ctx.ui.notify(renderImpactDebugContext(affected), "info");
    }
  });

  pi.registerCommand("sydes-impact-last", {
    description: "Show the last Sydes impact context from this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        state.lastAffectedContext
          ? renderImpactDebugContext(state.lastAffectedContext)
          : state.lastReason ?? "No Sydes impact context yet",
        state.lastAffectedContext ? "info" : "warning"
      );
    }
  });

  pi.on("before_agent_start", createBeforeAgentStartHandler(extension.cbm, state));
  pi.on("tool_result", (event, ctx) => {
    observeMutationResult(event, ctx.cwd, state);
    observeTestResult(event, state);
  });
  (pi.on as (event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages?: unknown[] } | undefined>) => void)("context", async (event, ctx) => {
    return maybeInjectImpactGuidanceIntoContext(extension.cbm, state, ctx.cwd, event);
  });
  pi.on("session_shutdown", async () => {
    state.telemetry?.recordCbm(extension.cbm.processStartCount, extension.cbm.transportKind);
    await state.telemetry?.flush();
    await extension.cbm.close();
  });
}

export function createBeforeAgentStartHandler(cbm: CbmClient, state: SydesRuntimeState) {
  return async (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!shouldInjectForPrompt(event.prompt)) {
      return undefined;
    }

    const context = await buildRelevantContext(event.prompt, ctx.cwd, cbm, {
      allowIndex: true,
      projectCache: state.projectCache
    });
    if (!context) {
      state.lastContext = null;
      state.lastReason = "Sydes graph guidance unavailable";
      return undefined;
    }

    const guidance = buildExplorationGuidance(context);
    state.lastContext = context;
    state.lastReason = null;
    state.telemetry?.recordExploration(context, guidance);
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
    `indexed this session: ${context.projectIndexedThisSession ? "yes" : "no"}`,
    `project ensure ms: ${context.projectEnsureElapsedMs ?? "n/a"}`,
    `query count: ${context.querySummary.queryCount}`,
    `elapsed ms: ${context.querySummary.elapsedMs}`,
    "",
    buildExplorationGuidance(context)
  ].join("\n");
}

export function observeMutationResult(event: ToolResultEvent, repoPath: string, state: SydesRuntimeState): void {
  if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) {
    return;
  }

  const path = typeof event.input.path === "string" ? event.input.path : undefined;
  const filePath = normalizeImpactPath(repoPath, path);
  if (!filePath) {
    return;
  }

  state.impactDirty = true;
  state.pendingMutations.push({
    filePath,
    toolName: event.toolName,
    timestamp: Date.now(),
    toolCallId: event.toolCallId
  });
  state.testCommandsAfterLastMutation = [];
}

export function observeTestResult(event: ToolResultEvent, state: SydesRuntimeState): void {
  if (event.isError || event.toolName !== "bash" || state.pendingMutations.length === 0) {
    return;
  }
  const command = typeof event.input.command === "string" ? event.input.command : "";
  if (!/\bgo\s+test\b/.test(command)) {
    return;
  }
  state.testCommandsAfterLastMutation.push({
    command,
    timestamp: Date.now(),
    toolCallId: event.toolCallId
  });
}

export async function maybeSendImpactGuidance(
  cbm: CbmClient,
  state: SydesRuntimeState,
  cwd: string,
  pi: Pick<ExtensionAPI, "sendMessage">,
  impactBuilder: (repoPath: string, cbmClient: CbmClient) => Promise<AffectedContext | null> = buildAffectedContext
): Promise<void> {
  const guidance = await buildPendingImpactGuidance(cbm, state, cwd, "agent_settled", impactBuilder);
  if (!guidance || guidance.suppressed) {
    return;
  }
  pi.sendMessage(guidance.message, { deliverAs: "followUp", triggerTurn: true });
}

export async function maybeInjectImpactGuidanceIntoContext(
  cbm: CbmClient,
  state: SydesRuntimeState,
  cwd: string,
  event: ContextEvent,
  impactBuilder: (repoPath: string, cbmClient: CbmClient) => Promise<AffectedContext | null> = (repoPath, cbmClient) =>
    buildAffectedContext(repoPath, cbmClient, undefined, {
      allowIndex: true,
      cache: state.projectCache
    })
): Promise<{ messages?: unknown[] } | undefined> {
  const guidance = await buildPendingImpactGuidance(cbm, state, cwd, "context", impactBuilder);
  if (!guidance || guidance.suppressed) {
    return undefined;
  }
  return {
    messages: [
      ...event.messages,
      {
        role: "custom",
        customType: "sydes-impact-guidance",
        content: guidance.message.content,
        display: guidance.message.display,
        details: guidance.message.details,
        timestamp: Date.now()
      } as never
    ]
  };
}

async function buildPendingImpactGuidance(
  cbm: CbmClient,
  state: SydesRuntimeState,
  cwd: string,
  injectionHook: string,
  impactBuilder: (repoPath: string, cbmClient: CbmClient) => Promise<AffectedContext | null>
): Promise<
  | {
      message: {
        customType: string;
        content: string;
        display: true;
        details: { context: AffectedContext };
      };
      suppressed: boolean;
    }
  | null
> {
  if (!state.impactDirty) {
    return null;
  }

  const affected = await impactBuilder(cwd, cbm);
  state.impactDirty = false;
  state.pendingMutations = [];
  const testsAfterMutation = state.testCommandsAfterLastMutation;
  state.testCommandsAfterLastMutation = [];
  if (!affected) {
    state.lastReason = "Sydes impact guidance unavailable";
    return null;
  }
  if (affected.signature === state.lastImpactSignature) {
    state.lastAffectedContext = affected;
    return null;
  }

  state.lastAffectedContext = affected;
  state.lastImpactSignature = affected.signature;
  state.lastReason = null;
  const guidance = buildImpactGuidance(affected);
  if (hasRelevantTestAfterLastMutation(affected, testsAfterMutation)) {
    state.telemetry?.recordImpactSuppressed(affected, guidance, injectionHook);
    return {
      message: {
        customType: "sydes-impact-guidance",
        content: guidance,
        display: true,
        details: { context: affected }
      },
      suppressed: true
    };
  }

  state.telemetry?.recordImpact(affected, guidance, {
    injectionHook,
    injectedBeforeNextModelTurn: injectionHook === "context"
  });
  return {
    message: {
      customType: "sydes-impact-guidance",
      content: guidance,
      display: true,
      details: { context: affected }
    },
    suppressed: false
  };
}

function hasRelevantTestAfterLastMutation(context: AffectedContext, tests: ObservedTestCommand[]): boolean {
  if (tests.length === 0) {
    return false;
  }
  if (context.tests.length === 0) {
    return false;
  }
  return tests.some((test) => {
    if (/\bgo\s+test\s+\.\/\.\.\./.test(test.command)) {
      return true;
    }
    return context.tests.some((target) => test.command.includes(packagePathForTest(target)));
  });
}

function packagePathForTest(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? `./${path.slice(0, index)}` : ".";
}

export function renderImpactDebugContext(context: AffectedContext): string {
  return [
    "Sydes impact",
    `project: ${context.project}`,
    `changed files: ${context.changedFiles.join(", ") || "none"}`,
    `impacted: ${context.impactedSymbols.map((symbol) => `${symbol.filePath ?? "?"}:${symbol.name}`).join(", ") || "none"}`,
    `routes: ${context.routes.map((route) => `${route.method ?? ""} ${route.path}`.trim()).join(", ") || "none"}`,
    `tests: ${context.tests.join(", ") || "none"}`,
    `indexed this session: ${context.projectIndexedThisSession ? "yes" : "no"}`,
    `project ensure ms: ${context.projectEnsureElapsedMs ?? "n/a"}`,
    `query count: ${context.querySummary.queryCount}`,
    `detect_changes ms: ${context.querySummary.detectChangesElapsedMs ?? "n/a"}`,
    `elapsed ms: ${context.querySummary.elapsedMs}`,
    "",
    buildImpactGuidance(context)
  ].join("\n");
}
