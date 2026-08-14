import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AffectedContext, ChangeSurfaceDrift, RelevantContext } from "../policy/types.js";

export interface ExplorationToolEvent {
  sequence: number;
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  normalizedTarget?: string;
  normalizedQuery?: string;
  repeated: boolean;
  timestamp: string;
  elapsedMs: number;
  resultSizeBytes: number;
  isError: boolean;
  enrichment?: {
    anchorPath?: string;
    cbmQueryCount: number;
    cbmElapsedMs: number;
    generated: boolean;
    enrichmentBytes: number;
    relationshipsReturned: number;
    filesSuggested: string[];
    testsSuggested: string[];
    skippedReason?: string;
    failureReason?: string;
  };
}

export interface SydesTelemetry {
  explorationGuidanceInjected: boolean;
  explorationToolEventCount: number;
  explorationGuidanceText?: string;
  explorationContext?: {
    entryPoints: unknown[];
    files: string[];
    tests: string[];
    relationships: unknown[];
    queryCount: number;
    elapsedMs: number;
    projectIndexedThisSession?: boolean;
    projectEnsureElapsedMs?: number;
    projectIndexElapsedMs?: number;
    projectReadinessWaitMs?: number;
    projectReadinessPollCount?: number;
    projectReadinessStrategy?: string;
  };
  impactGuidanceCount: number;
  impactGuidanceEvents: Array<{
    changedFiles: string[];
    changedSymbols: unknown[];
    impactedSymbols: unknown[];
    routes: unknown[];
    tests: string[];
    relationships: unknown[];
    detectChangesElapsedMs?: number;
    totalElapsedMs: number;
    guidanceText: string;
    guidanceSignature: string;
    injectionHook?: string;
    suppressedAsAlreadyVerified?: boolean;
    injectedBeforeNextModelTurn?: boolean;
  }>;
  driftAnalysisCount: number;
  driftWarningCount: number;
  driftEvents: Array<{
    changedFiles: string[];
    expectedFiles: string[];
    unexpectedFiles: string[];
    expectedChangedSymbols: unknown[];
    unexpectedChangedSymbols: unknown[];
    severity: string;
    reasons: string[];
    insertions: number;
    deletions: number;
    signature: string;
    injected: boolean;
    injectionHook?: string;
    injectedBeforeNextModelTurn?: boolean;
    guidanceText?: string;
  }>;
  cbmProcessStartCount?: number;
  cbmTransport?: string;
  cbmFallbackUsed?: boolean;
}

export class SydesTelemetryRecorder {
  private readonly runDir: string | undefined;
  private data: SydesTelemetry = {
    explorationGuidanceInjected: false,
    explorationToolEventCount: 0,
    impactGuidanceCount: 0,
    impactGuidanceEvents: [],
    driftAnalysisCount: 0,
    driftWarningCount: 0,
    driftEvents: []
  };

  constructor(runDir = process.env.SYDES_RUN_DIR) {
    this.runDir = runDir;
  }

  get enabled(): boolean {
    return !!this.runDir;
  }

  async recordExplorationToolEvent(event: ExplorationToolEvent): Promise<void> {
    this.data.explorationToolEventCount += 1;
    if (!this.runDir) {
      return;
    }
    await mkdir(this.runDir, { recursive: true });
    await appendFile(join(this.runDir, "exploration-events.jsonl"), `${JSON.stringify(event)}\n`);
    await this.flush();
  }

  recordExploration(context: RelevantContext, guidanceText: string): void {
    this.data.explorationGuidanceInjected = true;
    this.data.explorationGuidanceText = guidanceText;
    this.data.explorationContext = {
      entryPoints: context.entryPoints,
      files: context.files,
      tests: context.tests,
      relationships: context.relationships,
      queryCount: context.querySummary.queryCount,
      elapsedMs: context.querySummary.elapsedMs,
      projectIndexedThisSession: context.projectIndexedThisSession,
      projectEnsureElapsedMs: context.projectEnsureElapsedMs,
      projectIndexElapsedMs: context.projectIndexElapsedMs,
      projectReadinessWaitMs: context.projectReadinessWaitMs,
      projectReadinessPollCount: context.projectReadinessPollCount,
      projectReadinessStrategy: context.projectReadinessStrategy
    };
    this.data.cbmProcessStartCount = context.querySummary.processStartCount ?? this.data.cbmProcessStartCount;
    this.data.cbmTransport = context.querySummary.transport ?? this.data.cbmTransport;
    this.data.cbmFallbackUsed = (context.querySummary.transport ?? "").includes("fallback") || this.data.cbmFallbackUsed;
    void this.flush();
  }

  recordImpact(
    context: AffectedContext,
    guidanceText: string,
    options: {
      injectionHook?: string;
      suppressedAsAlreadyVerified?: boolean;
      injectedBeforeNextModelTurn?: boolean;
    } = {}
  ): void {
    this.data.impactGuidanceCount += 1;
    this.data.impactGuidanceEvents.push({
      changedFiles: context.changedFiles,
      changedSymbols: context.changedSymbols,
      impactedSymbols: context.impactedSymbols,
      routes: context.routes,
      tests: context.tests,
      relationships: context.relationships,
      detectChangesElapsedMs: context.querySummary.detectChangesElapsedMs,
      totalElapsedMs: context.querySummary.elapsedMs,
      guidanceText,
      guidanceSignature: context.signature,
      injectionHook: options.injectionHook,
      suppressedAsAlreadyVerified: options.suppressedAsAlreadyVerified,
      injectedBeforeNextModelTurn: options.injectedBeforeNextModelTurn
    });
    this.data.cbmProcessStartCount = context.querySummary.processStartCount ?? this.data.cbmProcessStartCount;
    this.data.cbmTransport = context.querySummary.transport ?? this.data.cbmTransport;
    this.data.cbmFallbackUsed = (context.querySummary.transport ?? "").includes("fallback") || this.data.cbmFallbackUsed;
    void this.flush();
  }

  recordImpactSuppressed(context: AffectedContext, guidanceText: string, injectionHook: string): void {
    this.recordImpact(context, guidanceText, {
      injectionHook,
      suppressedAsAlreadyVerified: true,
      injectedBeforeNextModelTurn: false
    });
  }

  recordCbm(cbmProcessStartCount: number, cbmTransport: string): void {
    this.data.cbmProcessStartCount = cbmProcessStartCount;
    this.data.cbmTransport = cbmTransport;
    this.data.cbmFallbackUsed = cbmTransport.includes("fallback") || this.data.cbmFallbackUsed;
    void this.flush();
  }

  recordDrift(
    drift: ChangeSurfaceDrift,
    guidanceText: string,
    options: {
      injectionHook?: string;
      injected?: boolean;
      injectedBeforeNextModelTurn?: boolean;
    } = {}
  ): void {
    this.data.driftAnalysisCount += 1;
    if (options.injected) {
      this.data.driftWarningCount += 1;
    }
    this.data.driftEvents.push({
      changedFiles: drift.changedFiles,
      expectedFiles: drift.expectedFiles,
      unexpectedFiles: drift.unexpectedFiles,
      expectedChangedSymbols: drift.expectedChangedSymbols,
      unexpectedChangedSymbols: drift.unexpectedChangedSymbols,
      severity: drift.severity,
      reasons: drift.reasons,
      insertions: drift.insertionCount,
      deletions: drift.deletionCount,
      signature: drift.signature,
      injected: !!options.injected,
      injectionHook: options.injectionHook,
      injectedBeforeNextModelTurn: options.injectedBeforeNextModelTurn,
      guidanceText: options.injected ? guidanceText : undefined
    });
    void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.runDir) {
      return;
    }
    await mkdir(this.runDir, { recursive: true });
    await writeFile(join(this.runDir, "sydes.json"), `${JSON.stringify(this.data, null, 2)}\n`);
  }
}
