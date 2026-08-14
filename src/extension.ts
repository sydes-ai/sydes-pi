import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix as pathPosix, resolve } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { CbmClient } from "./cbm/client.js";
import { findExecutable } from "./cbm/paths.js";
import { loadConfig, type SydesIntegrationMode } from "./config.js";
import { buildExplorationGuidance, buildRelevantContext, ensureProjectForRepo } from "./policy/exploration.js";
import {
  analyzeChangeSurfaceDrift,
  buildChangeSurfaceGuidance,
  loadSourceSymbolsForDiff,
  shouldInjectDriftWarning
} from "./policy/drift.js";
import {
  buildAffectedContext,
  buildImpactGuidance,
  gitDiffProvider,
  normalizeRepoPath as normalizeImpactPath
} from "./policy/impact.js";
import type { AffectedContext, ChangeSurfaceDrift, PolicyCbmClient, RelevantContext } from "./policy/types.js";
import type { ProjectEnsureCacheEntry } from "./policy/types.js";
import { SydesTelemetryRecorder, type ExplorationToolEvent } from "./telemetry/recorder.js";

const STRUCTURAL_CONTEXT_CHAR_BUDGET = 2400;
export const SYDES_STRUCTURAL_CONTEXT_HEADER = "[Sydes structural context]";
export const SYDES_PATH_RECOVERY_HEADER = "--- Sydes path recovery ---";

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
  integrationMode: SydesIntegrationMode;
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
    integrationMode: config.integrationMode,
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
  lastDrift: ChangeSurfaceDrift | null;
  lastDriftSignature: string | null;
  projectCache: Map<string, ProjectEnsureCacheEntry>;
  impactInjectionBoundary: "context";
  telemetry?: Partial<SydesTelemetryRecorder>;
  explorationTelemetry: ExplorationTelemetryState;
}

export interface ExplorationTelemetryState {
  sequence: number;
  startedAt: number;
  seenTargets: Set<string>;
  enrichedReadTargets: Set<string>;
  readFileFingerprints: Map<string, string>;
  surfacedGraphFiles: Set<string>;
}

export interface SydesToolResultEventResult {
  content?: ToolResultEvent["content"];
  details?: unknown;
  isError?: boolean;
  usage?: ToolResultEvent["usage"];
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
    lastDrift: null,
    lastDriftSignature: null,
    lastReason: null,
    projectCache: new Map(),
    impactInjectionBoundary: "context",
    telemetry: new SydesTelemetryRecorder(),
    explorationTelemetry: {
      sequence: 0,
      startedAt: Date.now(),
      seenTargets: new Set(),
      enrichedReadTargets: new Set(),
      readFileFingerprints: new Map(),
      surfacedGraphFiles: new Set()
    }
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

  pi.registerCommand("sydes-drift", {
    description: "Analyze current change-surface drift without calling a model",
    handler: async (_args, ctx) => {
      const drift = await buildCurrentDrift(extension.cbm, state, ctx.cwd);
      if (!drift) {
        state.lastReason = "No current changes or Sydes drift context unavailable";
        ctx.ui.notify(state.lastReason, "warning");
        return;
      }
      state.lastDrift = drift;
      ctx.ui.notify(renderDriftDebugContext(drift), drift.severity === "none" || drift.severity === "low" ? "info" : "warning");
    }
  });

  pi.registerCommand("sydes-drift-last", {
    description: "Show the last Sydes change-surface drift analysis",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        state.lastDrift ? renderDriftDebugContext(state.lastDrift) : state.lastReason ?? "No Sydes drift analysis yet",
        state.lastDrift ? "info" : "warning"
      );
    }
  });

  if (extension.integrationMode === "tool-middleware") {
    pi.on("tool_call", observeExplorationToolCall);
    pi.on("tool_result", async (event, ctx) => {
      return handleToolMiddlewareToolResult(event, ctx.cwd, state, extension.cbm);
    });
  } else {
    pi.on("before_agent_start", createBeforeAgentStartHandler(extension.cbm, state));
    pi.on("tool_result", (event, ctx) => {
      observeMutationResult(event, ctx.cwd, state);
      observeTestResult(event, state);
    });
    (pi.on as (event: "context", handler: (event: ContextEvent, ctx: ExtensionContext) => Promise<{ messages?: unknown[] } | undefined>) => void)("context", async (event, ctx) => {
      return maybeInjectPolicyGuidanceIntoContext(extension.cbm, state, ctx.cwd, event);
    });
  }
  pi.on("session_shutdown", async () => {
    state.telemetry?.recordCbm?.(extension.cbm.processStartCount, extension.cbm.transportKind);
    await state.telemetry?.flush?.();
    await extension.cbm.close();
  });
}

export function observeExplorationToolCall(event: ToolCallEvent): undefined {
  if (!isExplorationTool(event.toolName)) {
    return undefined;
  }
  return undefined;
}

export async function recordExplorationToolResult(
  event: ToolResultEvent,
  repoPath: string,
  state: SydesRuntimeState,
  now: () => number = Date.now
): Promise<ExplorationToolEvent | null> {
  return recordExplorationToolResultWithEnrichment(event, repoPath, state, now);
}

async function recordExplorationToolResultWithEnrichment(
  event: ToolResultEvent,
  repoPath: string,
  state: SydesRuntimeState,
  now: () => number,
  enrichment?: ExplorationToolEvent["enrichment"]
): Promise<ExplorationToolEvent | null> {
  if (!isExplorationTool(event.toolName)) {
    return null;
  }
  const normalized = normalizeExplorationTarget(event.toolName, event.input, repoPath);
  const repeatKey = normalized.normalizedTarget ?? normalized.normalizedQuery ?? JSON.stringify(safeExplorationInput(event.toolName, event.input));
  const repeated = state.explorationTelemetry.seenTargets.has(repeatKey);
  state.explorationTelemetry.seenTargets.add(repeatKey);
  const timestampMs = now();
  const explorationEvent: ExplorationToolEvent = {
    sequence: ++state.explorationTelemetry.sequence,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    input: safeExplorationInput(event.toolName, event.input),
    normalizedTarget: normalized.normalizedTarget,
    normalizedQuery: normalized.normalizedQuery,
    repeated,
    timestamp: new Date(timestampMs).toISOString(),
    elapsedMs: Math.max(0, timestampMs - state.explorationTelemetry.startedAt),
    resultSizeBytes: safeResultSize(event.content),
    isError: event.isError,
    enrichment
  };
  await state.telemetry?.recordExplorationToolEvent?.(explorationEvent);
  return explorationEvent;
}

export async function handleToolMiddlewareToolResult(
  event: ToolResultEvent,
  repoPath: string,
  state: SydesRuntimeState,
  cbm: PolicyCbmClient,
  now: () => number = Date.now
): Promise<SydesToolResultEventResult | undefined> {
  if (!isExplorationTool(event.toolName)) {
    return undefined;
  }

  const normalized = normalizeExplorationTarget(event.toolName, event.input, repoPath);
  let enrichment: ExplorationToolEvent["enrichment"];
  let footer: string | undefined;
  if (event.toolName === "read") {
    const readEnrichment = event.isError
      ? await maybeBuildFailedReadRecovery(event, repoPath, state, cbm, normalized.normalizedTarget)
      : await maybeBuildReadEnrichment(event, repoPath, state, cbm, normalized.normalizedTarget);
    enrichment = readEnrichment.telemetry;
    footer = readEnrichment.footer;
  } else {
    enrichment = {
      anchorPath: normalized.normalizedTarget,
      cbmQueryCount: 0,
      cbmElapsedMs: 0,
      generated: false,
      enrichmentBytes: 0,
      relationshipsReturned: 0,
      filesSuggested: [],
      testsSuggested: [],
      skippedReason: "passive_search_tool"
    };
  }

  await recordExplorationToolResultWithEnrichment(event, repoPath, state, now, enrichment);
  if (!footer) {
    return undefined;
  }

  return {
    content: [...event.content, { type: "text", text: `\n\n${footer}` }],
    details: event.details,
    isError: event.isError,
    usage: event.usage
  };
}

interface ReadEnrichmentResult {
  footer?: string;
  telemetry: NonNullable<ExplorationToolEvent["enrichment"]>;
}

interface StructuralSymbol {
  name: string;
  qualifiedName: string;
  kind?: string;
  filePath?: string;
}

interface StructuralRelationship {
  from: string;
  to: string;
  type: string;
}

interface NavigationSuggestions {
  sameFileSymbols: string[];
  resolvedRelatedSymbols: Array<{ name: string; filePath: string; kind?: string }>;
  relatedCodeFilesSuggested: string[];
  relatedTestFilesSuggested: string[];
}

async function maybeBuildReadEnrichment(
  event: ToolResultEvent,
  repoPath: string,
  state: SydesRuntimeState,
  cbm: PolicyCbmClient,
  anchorPath: string | undefined,
  now: () => number = Date.now
): Promise<ReadEnrichmentResult> {
  const startedAt = now();
  const base = (overrides: Partial<NonNullable<ExplorationToolEvent["enrichment"]>>): ReadEnrichmentResult => ({
    telemetry: {
      anchorPath,
      cbmQueryCount: 0,
      cbmElapsedMs: Math.max(0, now() - startedAt),
      generated: false,
      enrichmentBytes: 0,
      relationshipsReturned: 0,
      filesSuggested: [],
      testsSuggested: [],
      ...overrides
    }
  });

  if (event.isError) {
    return base({ skippedReason: "read_error" });
  }
  if (!anchorPath) {
    return base({ skippedReason: "no_anchor_path" });
  }
  const fingerprint = await fingerprintRepositoryFile(repoPath, anchorPath);
  if (!fingerprint) {
    return base({ failureReason: "file_fingerprint_unavailable" });
  }
  const previousFingerprint = state.explorationTelemetry.readFileFingerprints.get(anchorPath);
  const repeatedReadUnchanged = previousFingerprint === fingerprint;
  const repeatedReadAfterModification = !!previousFingerprint && previousFingerprint !== fingerprint;
  state.explorationTelemetry.readFileFingerprints.set(anchorPath, fingerprint);
  const enrichmentKey = `${anchorPath}\0${fingerprint}`;
  if (state.explorationTelemetry.enrichedReadTargets.has(enrichmentKey)) {
    const note = "[Sydes note: this unchanged file was previously inspected; structural context is unchanged.]";
    const result = base({
      skippedReason: "already_enriched",
      repeatedReadUnchanged,
      repeatedReadAfterModification,
      repeatedEnrichmentAvoided: true,
      enrichmentBytes: repeatedReadUnchanged ? Buffer.byteLength(note, "utf8") : 0
    });
    return repeatedReadUnchanged ? { ...result, footer: note } : result;
  }
  state.explorationTelemetry.enrichedReadTargets.add(enrichmentKey);

  let cbmQueryCount = 0;
  try {
    const resolution = await ensureProjectForRepo(repoPath, cbm, {
      allowIndex: true,
      cache: state.projectCache
    });
    if (!resolution.project?.name) {
      return base({
        cbmElapsedMs: Math.max(0, now() - startedAt),
        failureReason: resolution.reason ?? "project_unresolved",
        repeatedReadUnchanged,
        repeatedReadAfterModification
      });
    }

    cbmQueryCount += 1;
    const graph = await cbm.searchGraphByArgs({
      project: resolution.project.name,
      query: anchorPath,
      limit: 12
    });
    const symbols = uniqueSymbols(rowsFromCbmResult(graph).map((row) => symbolFromRow(row, repoPath))).filter(
      (symbol): symbol is StructuralSymbol => !!symbol && symbol.filePath === anchorPath
    );

    const relationships: StructuralRelationship[] = [];
    const relatedSymbols: StructuralSymbol[] = [];
    for (const symbol of symbols.slice(0, 2)) {
      cbmQueryCount += 1;
      const trace = await cbm.tracePath(resolution.project.name, symbol.qualifiedName);
      const traced = parseTraceSymbols(trace, repoPath, symbol.qualifiedName);
      relatedSymbols.push(...traced.symbols);
      relationships.push(...traced.relationships);
    }
    const uniqueRelated = uniqueSymbols(relatedSymbols);
    const resolutionResult = await resolveMissingSymbolPaths(
      resolution.project.name,
      repoPath,
      cbm,
      uniqueRelated,
      10
    );
    cbmQueryCount += resolutionResult.queryCount;

    const uniqueRelationList = uniqueRelationships(relationships);
    const relationshipsReturned = uniqueRelationList.length;
    const suggestions = buildNavigationSuggestions(anchorPath, symbols, resolutionResult.symbols, state);
    for (const path of [anchorPath, ...suggestions.relatedCodeFilesSuggested, ...suggestions.relatedTestFilesSuggested]) {
      state.explorationTelemetry.surfacedGraphFiles.add(path);
    }
    const footer = renderStructuralFooter(anchorPath, symbols, suggestions, uniqueRelationList, repeatedReadAfterModification);

    if (!footer) {
      return base({
        cbmQueryCount,
        cbmElapsedMs: Math.max(0, now() - startedAt),
        skippedReason: "no_structural_context",
        repeatedReadUnchanged,
        repeatedReadAfterModification
      });
    }

    return {
      footer,
      telemetry: {
        anchorPath,
        cbmQueryCount,
        cbmElapsedMs: Math.max(0, now() - startedAt),
        generated: true,
        enrichmentBytes: Buffer.byteLength(footer, "utf8"),
        relationshipsReturned,
        filesSuggested: suggestions.relatedCodeFilesSuggested,
        testsSuggested: suggestions.relatedTestFilesSuggested,
        resolvedRelatedSymbols: suggestions.resolvedRelatedSymbols,
        relatedCodeFilesSuggested: suggestions.relatedCodeFilesSuggested,
        relatedTestFilesSuggested: suggestions.relatedTestFilesSuggested,
        repeatedReadUnchanged,
        repeatedReadAfterModification,
        repeatedEnrichmentAvoided: false
      }
    };
  } catch (error) {
    return base({
      cbmQueryCount,
      cbmElapsedMs: Math.max(0, now() - startedAt),
      failureReason: error instanceof Error ? error.message : String(error),
      repeatedReadUnchanged,
      repeatedReadAfterModification
    });
  }
}

async function maybeBuildFailedReadRecovery(
  event: ToolResultEvent,
  repoPath: string,
  state: SydesRuntimeState,
  cbm: PolicyCbmClient,
  requestedPath: string | undefined,
  now: () => number = Date.now
): Promise<ReadEnrichmentResult> {
  const startedAt = now();
  const base = (overrides: Partial<NonNullable<ExplorationToolEvent["enrichment"]>>): ReadEnrichmentResult => ({
    telemetry: {
      anchorPath: requestedPath,
      cbmQueryCount: 0,
      cbmElapsedMs: Math.max(0, now() - startedAt),
      generated: false,
      enrichmentBytes: 0,
      relationshipsReturned: 0,
      filesSuggested: [],
      testsSuggested: [],
      failedReadRecoveryGenerated: false,
      failedReadRecoveryCandidates: [],
      ...overrides
    }
  });

  if (!requestedPath) {
    return base({ skippedReason: "no_anchor_path" });
  }

  let cbmQueryCount = 0;
  try {
    const knownCandidates = rankRecoveryCandidates(
      requestedPath,
      [...state.explorationTelemetry.surfacedGraphFiles],
      true
    );
    let graphCandidates: string[] = [];
    const query = recoveryQueryForPath(requestedPath);
    if (query) {
      const resolution = await ensureProjectForRepo(repoPath, cbm, {
        allowIndex: true,
        cache: state.projectCache
      });
      if (resolution.project?.name) {
        cbmQueryCount += 1;
        const result = await cbm.searchGraphByArgs({
          project: resolution.project.name,
          query,
          limit: 20
        });
        graphCandidates = rowsFromCbmResult(result)
          .map((row) => sourcePathFromRow(row, repoPath))
          .filter(isDefined);
      }
    }

    const candidates = rankRecoveryCandidates(requestedPath, [...knownCandidates, ...graphCandidates], false).slice(0, 3);
    if (candidates.length === 0) {
      return base({
        cbmQueryCount,
        cbmElapsedMs: Math.max(0, now() - startedAt),
        skippedReason: "no_recovery_candidates"
      });
    }

    const footer = boundFooter([
      SYDES_PATH_RECOVERY_HEADER,
      "Requested path does not exist.",
      "",
      "Existing nearby candidates:",
      ...candidates.map((candidate) => `- ${candidate}`)
    ].join("\n"));
    return {
      footer,
      telemetry: {
        anchorPath: requestedPath,
        cbmQueryCount,
        cbmElapsedMs: Math.max(0, now() - startedAt),
        generated: true,
        enrichmentBytes: Buffer.byteLength(footer, "utf8"),
        relationshipsReturned: 0,
        filesSuggested: candidates.filter((path) => !isTestPath(path)),
        testsSuggested: candidates.filter(isTestPath),
        failedReadRecoveryGenerated: true,
        failedReadRecoveryCandidates: candidates,
        relatedCodeFilesSuggested: candidates.filter((path) => !isTestPath(path)),
        relatedTestFilesSuggested: candidates.filter(isTestPath)
      }
    };
  } catch (error) {
    return base({
      cbmQueryCount,
      cbmElapsedMs: Math.max(0, now() - startedAt),
      failureReason: error instanceof Error ? error.message : String(error)
    });
  }
}

function renderStructuralFooter(
  anchorPath: string,
  symbols: StructuralSymbol[],
  suggestions: NavigationSuggestions,
  relationships: StructuralRelationship[],
  repeatedAfterModification = false
): string | undefined {
  if (
    suggestions.sameFileSymbols.length === 0 &&
    suggestions.resolvedRelatedSymbols.length === 0 &&
    suggestions.relatedCodeFilesSuggested.length === 0 &&
    suggestions.relatedTestFilesSuggested.length === 0
  ) {
    return undefined;
  }

  const lines = [
    SYDES_STRUCTURAL_CONTEXT_HEADER,
    `Anchor: ${anchorPath}`,
    repeatedAfterModification ? "File changed since previous read; structural context refreshed." : undefined,
    formatFooterList("Symbols in this file", suggestions.sameFileSymbols),
    formatFooterList("Related code", suggestions.resolvedRelatedSymbols.map((symbol) => `${symbol.name} - ${symbol.filePath}`)),
    formatFooterList("Next code files", suggestions.relatedCodeFilesSuggested),
    formatFooterList("Related tests", suggestions.relatedTestFilesSuggested),
    relationships.length ? `Relationships returned: ${relationships.length}` : undefined,
    "Verify graph hints against source before editing."
  ].filter(isDefined);
  return boundFooter(lines.join("\n"));
}

function buildNavigationSuggestions(
  anchorPath: string,
  symbols: StructuralSymbol[],
  relatedSymbols: StructuralSymbol[],
  state: SydesRuntimeState
): NavigationSuggestions {
  const alreadyRead = new Set(state.explorationTelemetry.readFileFingerprints.keys());
  const sameFileSymbols = uniqueStrings(symbols.map((symbol) => symbol.name)).slice(0, 4);
  const resolvedRelatedSymbols = uniqueResolvedSymbols(
    relatedSymbols
      .filter((symbol) => symbol.filePath && symbol.filePath !== anchorPath)
      .map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath as string
      }))
  ).slice(0, 8);
  const relatedCodeFilesSuggested = rankSuggestedFiles(
    resolvedRelatedSymbols.map((symbol) => symbol.filePath),
    anchorPath,
    alreadyRead,
    false
  ).slice(0, 3);
  const relatedTestFilesSuggested = rankSuggestedFiles(
    resolvedRelatedSymbols.map((symbol) => symbol.filePath),
    anchorPath,
    alreadyRead,
    true
  ).slice(0, 2);
  return {
    sameFileSymbols,
    resolvedRelatedSymbols,
    relatedCodeFilesSuggested,
    relatedTestFilesSuggested
  };
}

function rankSuggestedFiles(paths: string[], anchorPath: string, alreadyRead: Set<string>, testsOnly: boolean): string[] {
  return uniqueStrings(paths)
    .filter((path) => path !== anchorPath)
    .filter((path) => isTestPath(path) === testsOnly)
    .filter((path) => !isGenericPath(path))
    .sort((a, b) => Number(alreadyRead.has(a)) - Number(alreadyRead.has(b)) || a.localeCompare(b))
    .filter((path) => !alreadyRead.has(path));
}

async function resolveMissingSymbolPaths(
  project: string,
  repoPath: string,
  cbm: PolicyCbmClient,
  symbols: StructuralSymbol[],
  limit: number
): Promise<{ symbols: StructuralSymbol[]; queryCount: number }> {
  const resolved = [...symbols];
  let queryCount = 0;
  for (const symbol of resolved.filter((item) => !item.filePath).slice(0, limit)) {
    const query = fileResolutionQuery(symbol.qualifiedName);
    if (!query) {
      continue;
    }
    queryCount += 1;
    const result = await cbm.searchGraphByArgs({
      project,
      query,
      limit: 8
    });
    const match = findSourcePathForSymbol(rowsFromCbmResult(result), repoPath, symbol);
    if (match) {
      symbol.filePath = match.filePath;
      symbol.kind = symbol.kind ?? match.kind;
    }
  }
  return { symbols: resolved, queryCount };
}

function findSourcePathForSymbol(
  rows: Record<string, unknown>[],
  repoPath: string,
  symbol: StructuralSymbol
): { filePath: string; kind?: string } | undefined {
  const matches = rows
    .map((row) => ({ row, parsed: symbolFromRow(row, repoPath) }))
    .filter((entry): entry is { row: Record<string, unknown>; parsed: StructuralSymbol } => {
      if (!entry.parsed?.filePath) {
        return false;
      }
      return entry.parsed.qualifiedName === symbol.qualifiedName;
    });
  if (matches.length !== 1) {
    return undefined;
  }
  return {
    filePath: matches[0].parsed.filePath!,
    kind: matches[0].parsed.kind
  };
}

function fileResolutionQuery(qualifiedName: string): string {
  if (!qualifiedName || qualifiedName === "undefined") {
    return "";
  }
  const parts = qualifiedName.split(".");
  const short = leafName(qualifiedName) ?? "";
  const owner = parts.at(-2) && parts.at(-2) !== short ? parts.at(-2) : "";
  const layer = parts.find((part) => /^(handler|service|repository|controller|route|helpers?)s?$/.test(part)) ?? "";
  return uniqueStrings([owner, short, layer].filter(isDefined)).join(" ");
}

function formatFooterList(label: string, values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

function boundFooter(text: string): string {
  if (text.length <= STRUCTURAL_CONTEXT_CHAR_BUDGET) {
    return text;
  }
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const candidate = [...lines, line, "..."].join("\n");
    if (candidate.length > STRUCTURAL_CONTEXT_CHAR_BUDGET) {
      break;
    }
    lines.push(line);
  }
  return [...lines, "..."].join("\n");
}

export async function fingerprintRepositoryFile(repoPath: string, normalizedPath: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(resolve(repoPath, normalizedPath));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}

function recoveryQueryForPath(requestedPath: string): string | undefined {
  const basename = pathPosix.basename(requestedPath);
  const stem = basename.replace(/\.[^.]+$/, "");
  return stem.length >= 3 ? stem : basename.length >= 3 ? basename : undefined;
}

function rankRecoveryCandidates(requestedPath: string, candidates: string[], allowPreviouslySurfaced: boolean): string[] {
  const ranked = uniqueStrings(candidates)
    .map((candidate) => ({
      candidate,
      score: recoveryScore(requestedPath, candidate, allowPreviouslySurfaced)
    }))
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .map((item) => item.candidate);
  return ranked;
}

function recoveryScore(requestedPath: string, candidate: string, allowPreviouslySurfaced: boolean): number {
  if (!candidate || candidate === requestedPath) {
    return 0;
  }
  const requestedSegments = pathSegments(requestedPath);
  const candidateSegments = pathSegments(candidate);
  const requestedBase = requestedSegments[requestedSegments.length - 1] ?? "";
  const candidateBase = candidateSegments[candidateSegments.length - 1] ?? "";
  let score = 0;
  if (requestedBase === candidateBase) {
    score += 5;
  } else if (stripExtension(requestedBase) === stripExtension(candidateBase)) {
    score += 4;
  } else if (stripExtension(candidateBase).includes(stripExtension(requestedBase)) || stripExtension(requestedBase).includes(stripExtension(candidateBase))) {
    score += 2;
  } else if (sharedPrefixLength(stripExtension(requestedBase), stripExtension(candidateBase)) >= 4) {
    score += 2;
  }
  const sharedSegments = requestedSegments.filter((segment) => candidateSegments.includes(segment) && !GENERIC_PATH_SEGMENTS.has(segment)).length;
  score += Math.min(sharedSegments, 3);
  if (allowPreviouslySurfaced) {
    score += 1;
  }
  return score;
}

function sharedPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function pathSegments(path: string): string[] {
  return path.split("/").map((segment) => stripExtension(segment.toLowerCase())).filter(Boolean);
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, "").toLowerCase();
}

function rowsFromCbmResult(result: { parsed?: unknown } | unknown): Record<string, unknown>[] {
  const parsed = isRecord(result) && "parsed" in result ? result.parsed : result;
  const content = unwrapStructuredContent(parsed);
  return collectRows(content);
}

function unwrapStructuredContent(value: unknown): unknown {
  if (isRecord(value) && "structuredContent" in value) {
    return value.structuredContent;
  }
  if (isRecord(value) && "parsed" in value) {
    return unwrapStructuredContent(value.parsed);
  }
  return value;
}

function collectRows(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  if (Array.isArray(value.rows) && Array.isArray(value.cols)) {
    rows.push(...rowsWithCols(value.cols, value.rows));
  }
  if (Array.isArray(value.groups)) {
    for (const group of value.groups) {
      if (!isRecord(group) || !Array.isArray(group.rows)) {
        continue;
      }
      const groupRows = Array.isArray(group.cols) ? group.rows : group.rows;
      const cols = Array.isArray(group.cols) ? group.cols : Array.isArray(value.cols) ? value.cols : [];
      rows.push(
        ...rowsWithCols(cols, groupRows).map((row) => ({
          ...row,
          qn_prefix: typeof group.qn_prefix === "string" ? group.qn_prefix : undefined,
          file: row.file ?? group.file
        }))
      );
    }
  }
  for (const key of ["callers", "callees", "symbols", "matches"]) {
    if (key in value) {
      rows.push(...collectRows(value[key]));
    }
  }
  return rows;
}

function rowsWithCols(cols: unknown[], rows: unknown[]): Record<string, unknown>[] {
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      Object.fromEntries(
        cols.map((col, index) => [String(col), row[index]])
      )
    );
}

function symbolFromRow(row: Record<string, unknown>, repoPath?: string): StructuralSymbol | undefined {
  const qualifiedName = stringValue(row.qn) ?? stringValue(row.qualifiedName) ?? joinedQualifiedName(row);
  const name = stringValue(row.name) ?? leafName(qualifiedName);
  if (!qualifiedName || !name) {
    return undefined;
  }
  return {
    name,
    qualifiedName,
    kind: stringValue(row.label) ?? stringValue(row.kind),
    filePath: sourcePathFromRow(row, repoPath)
  };
}

function parseTraceSymbols(result: { parsed?: unknown } | unknown, repoPath: string, sourceQualifiedName: string): { symbols: StructuralSymbol[]; relationships: StructuralRelationship[] } {
  const symbols = uniqueSymbols(rowsFromCbmResult(result).map((row) => symbolFromRow(row, repoPath))).filter(isDefined);
  return {
    symbols,
    relationships: symbols.map((symbol) => ({
      from: sourceQualifiedName,
      to: symbol.qualifiedName,
      type: "related"
    }))
  };
}

function sourcePathFromRow(row: Record<string, unknown>, repoPath?: string): string | undefined {
  const raw =
    stringValue(row.file) ??
    stringValue(row.filePath) ??
    stringValue(row.file_path) ??
    stringValue(row.path);
  if (!raw) {
    return undefined;
  }
  return repoPath ? normalizeImpactPath(repoPath, raw) : raw;
}

function joinedQualifiedName(row: Record<string, unknown>): string | undefined {
  const prefix = stringValue(row.qn_prefix);
  const name = stringValue(row.name);
  return prefix && name ? `${prefix}.${name}` : undefined;
}

function displaySymbol(symbol: StructuralSymbol): string {
  const kind = symbol.kind ? `${symbol.kind} ` : "";
  const location = symbol.filePath ? ` (${symbol.filePath})` : "";
  return `${kind}${symbol.name}${location}`;
}

function leafName(qualifiedName: string | undefined): string | undefined {
  if (!qualifiedName) {
    return undefined;
  }
  const parts = qualifiedName.split(".");
  return parts[parts.length - 1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__)(\/|$)|(_test|\.test|\.spec)\.[^.]+$/i.test(path);
}

const GENERIC_PATH_SEGMENTS = new Set(["cmd", "config", "configs", "main", "server", "app", "internal", "pkg", "src", "lib"]);

function isGenericPath(path: string): boolean {
  const stem = stripExtension(pathPosix.basename(path));
  return GENERIC_PATH_SEGMENTS.has(stem);
}

function uniqueResolvedSymbols(symbols: Array<{ name: string; filePath: string; kind?: string }>): Array<{ name: string; filePath: string; kind?: string }> {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.name}\0${symbol.filePath}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueSymbols(symbols: Array<StructuralSymbol | undefined>): StructuralSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol): symbol is StructuralSymbol => {
    if (!symbol) {
      return false;
    }
    const key = symbol.qualifiedName;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueRelationships(relationships: StructuralRelationship[]): StructuralRelationship[] {
  const seen = new Set<string>();
  return relationships.filter((relationship) => {
    const key = `${relationship.from}\0${relationship.to}\0${relationship.type}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
    state.telemetry?.recordExploration?.(context, guidance);
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

export async function maybeInjectPolicyGuidanceIntoContext(
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
  const messages = [...event.messages];
  const impact = await buildPendingImpactGuidance(cbm, state, cwd, "context", impactBuilder);
  if (impact && !impact.suppressed) {
    messages.push({
      role: "custom",
      customType: "sydes-impact-guidance",
      content: impact.message.content,
      display: impact.message.display,
      details: impact.message.details,
      timestamp: Date.now()
    } as never);
  }

  const drift = await buildCurrentDrift(cbm, state, cwd);
  if (drift) {
    state.lastDrift = drift;
    const injected = shouldInjectDriftWarning(drift, state.lastDriftSignature);
    const guidance = buildChangeSurfaceGuidance(drift);
    state.telemetry?.recordDrift?.(drift, guidance, {
      injectionHook: "context",
      injected,
      injectedBeforeNextModelTurn: injected
    });
    if (injected) {
      state.lastDriftSignature = drift.signature;
      messages.push({
        role: "custom",
        customType: "sydes-change-surface-warning",
        content: guidance,
        display: true,
        details: { drift },
        timestamp: Date.now()
      } as never);
    }
  }

  return messages.length === event.messages.length ? undefined : { messages };
}

export async function buildCurrentDrift(
  cbm: CbmClient,
  state: SydesRuntimeState,
  cwd: string
): Promise<ChangeSurfaceDrift | null> {
  if (!state.lastContext) {
    return null;
  }
  const diff = await gitDiffProvider.getCurrentDiff(cwd);
  if (!diff) {
    return null;
  }
  const resolution = await ensureProjectForRepo(cwd, cbm, {
    allowIndex: true,
    cache: state.projectCache
  });
  const project = resolution.project?.name ?? state.lastContext.project;
  const repoRoot = resolution.repoRoot ?? cwd;
  const sourceSymbols = await loadSourceSymbolsForDiff(project, repoRoot, cbm, diff.diffText, state.lastContext);
  return analyzeChangeSurfaceDrift({
    relevantContext: state.lastContext,
    affectedContext: state.lastAffectedContext,
    diffText: diff.diffText,
    sourceSymbols
  });
}

function isExplorationTool(toolName: string): toolName is "read" | "grep" | "find" {
  return toolName === "read" || toolName === "grep" || toolName === "find";
}

function normalizeExplorationTarget(
  toolName: string,
  input: Record<string, unknown>,
  repoPath: string
): { normalizedTarget?: string; normalizedQuery?: string } {
  if (toolName === "read") {
    return { normalizedTarget: normalizeImpactPath(repoPath, stringInput(input, "path")) ?? undefined };
  }
  if (toolName === "grep") {
    return {
      normalizedTarget: normalizeImpactPath(repoPath, stringInput(input, "path")) ?? undefined,
      normalizedQuery: stringInput(input, "pattern") ?? stringInput(input, "query") ?? undefined
    };
  }
  if (toolName === "find") {
    return {
      normalizedTarget: normalizeImpactPath(repoPath, stringInput(input, "path")) ?? undefined,
      normalizedQuery: stringInput(input, "pattern") ?? undefined
    };
  }
  return {};
}

function safeExplorationInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "read") {
    return pickInput(input, ["path", "offset", "limit"]);
  }
  if (toolName === "grep") {
    return pickInput(input, ["pattern", "query", "path", "include", "limit"]);
  }
  if (toolName === "find") {
    return pickInput(input, ["pattern", "path", "limit"]);
  }
  return {};
}

function pickInput(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      picked[key] = value;
    }
  }
  return picked;
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value ? value : undefined;
}

function safeResultSize(content: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(content ?? []), "utf8");
  } catch {
    return 0;
  }
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
    state.telemetry?.recordImpactSuppressed?.(affected, guidance, injectionHook);
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

  state.telemetry?.recordImpact?.(affected, guidance, {
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

export function renderDriftDebugContext(drift: ChangeSurfaceDrift): string {
  return [
    "Sydes drift",
    `severity: ${drift.severity}`,
    `changed files: ${drift.changedFiles.join(", ") || "none"}`,
    `expected files: ${drift.expectedFiles.join(", ") || "none"}`,
    `unexpected files: ${drift.unexpectedFiles.join(", ") || "none"}`,
    `expected changed symbols: ${drift.expectedChangedSymbols.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ") || "none"}`,
    `unexpected changed symbols: ${drift.unexpectedChangedSymbols.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ") || "none"}`,
    `unrelated deletions: ${drift.unrelatedDeletions.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ") || "none"}`,
    `insertions/deletions: ${drift.insertionCount}/${drift.deletionCount}`,
    `reasons: ${drift.reasons.join("; ") || "none"}`,
    `signature: ${drift.signature}`,
    "",
    buildChangeSurfaceGuidance(drift)
  ].join("\n");
}
