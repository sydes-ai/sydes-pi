import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AffectedContext, RelevantContext } from "../policy/types.js";

export interface SydesTelemetry {
  explorationGuidanceInjected: boolean;
  explorationGuidanceText?: string;
  explorationContext?: {
    entryPoints: unknown[];
    files: string[];
    tests: string[];
    relationships: unknown[];
    queryCount: number;
    elapsedMs: number;
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
  }>;
  cbmProcessStartCount?: number;
  cbmTransport?: string;
  cbmFallbackUsed?: boolean;
}

export class SydesTelemetryRecorder {
  private readonly runDir: string | undefined;
  private data: SydesTelemetry = {
    explorationGuidanceInjected: false,
    impactGuidanceCount: 0,
    impactGuidanceEvents: []
  };

  constructor(runDir = process.env.SYDES_RUN_DIR) {
    this.runDir = runDir;
  }

  get enabled(): boolean {
    return !!this.runDir;
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
      elapsedMs: context.querySummary.elapsedMs
    };
    this.data.cbmProcessStartCount = context.querySummary.processStartCount ?? this.data.cbmProcessStartCount;
    this.data.cbmTransport = context.querySummary.transport ?? this.data.cbmTransport;
    this.data.cbmFallbackUsed = (context.querySummary.transport ?? "").includes("fallback") || this.data.cbmFallbackUsed;
    void this.flush();
  }

  recordImpact(context: AffectedContext, guidanceText: string): void {
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
      guidanceSignature: context.signature
    });
    this.data.cbmProcessStartCount = context.querySummary.processStartCount ?? this.data.cbmProcessStartCount;
    this.data.cbmTransport = context.querySummary.transport ?? this.data.cbmTransport;
    this.data.cbmFallbackUsed = (context.querySummary.transport ?? "").includes("fallback") || this.data.cbmFallbackUsed;
    void this.flush();
  }

  recordCbm(cbmProcessStartCount: number, cbmTransport: string): void {
    this.data.cbmProcessStartCount = cbmProcessStartCount;
    this.data.cbmTransport = cbmTransport;
    this.data.cbmFallbackUsed = cbmTransport.includes("fallback") || this.data.cbmFallbackUsed;
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
