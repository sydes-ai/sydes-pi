import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeSwePilot,
  buildGuidanceFollowing,
  buildPairComparisons,
  extractToolMetrics,
  extractUsageMetrics,
  parseSweAnalyzeArgs,
  type AnalyzedSweRun
} from "../src/benchmark/swe-analysis.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("SWE artifact analyzer", () => {
  it("extracts usage while ignoring zero-token records", async () => {
    const root = await tempRoot();
    const sessionPath = join(root, "session.jsonl");
    await writeFile(sessionPath, lines([
      { message: { role: "assistant", usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 } } },
      { message: { role: "assistant", usage: { inputTokens: 100, cacheReadTokens: 40, outputTokens: 20, reasoningTokens: 5, totalTokens: 120 } } },
      { message: { role: "assistant", usage: { input_tokens: 80, input_tokens_details: { cached_tokens: 10 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 7 }, total_tokens: 150 } } }
    ]));

    expect(extractUsageMetrics(parseJsonl(await readFile(sessionPath, "utf8")), sessionPath)).toMatchObject({
      sessionFileSizeBytes: (await readFile(sessionPath, "utf8")).length,
      nonZeroUsageRecords: 2,
      maxObservedTotalTokens: 150,
      finalObservedTotalTokens: 150,
      uncachedInputTokens: 130,
      cacheReadTokens: 50,
      outputTokens: 50,
      reasoningTokens: 12
    });
  });

  it("extracts tool reads, unique/repeated files, searches, edits, and first edit", () => {
    const entries = [
      { message: { role: "assistant", content: [{ toolCallId: "1", name: "read", args: { path: "/repo/lib/a.js" } }] } },
      { message: { role: "assistant", content: [{ toolCallId: "2", name: "read", args: { path: "/repo/lib/a.js" } }, { toolCallId: "3", name: "bash", args: { command: "rg axios lib" } }] } },
      { message: { role: "assistant", content: [{ toolCallId: "4", name: "edit", args: { path: "/repo/lib/b.js" } }] } }
    ];

    expect(extractToolMetrics(entries, "/repo")).toMatchObject({
      totalToolCalls: 4,
      readCalls: 2,
      uniqueFilesRead: 1,
      repeatedReads: 1,
      searchCalls: 1,
      editWriteCalls: 1,
      firstEditTurn: 3,
      firstEditIndex: 3,
      first10DistinctFilesRead: ["lib/a.js"],
      filesEdited: ["lib/b.js"]
    });
  });

  it("calculates Sydes recommendation overlap without judging quality", () => {
    const signal = buildGuidanceFollowing(
      {
        explorationGuidanceInjected: true,
        graphEntryPoints: ["lib/core.js"],
        recommendedFiles: ["lib/a.js", "lib/b.js"],
        recommendedTests: ["test/a.test.js"],
        relationshipCount: 2,
        queryCount: 3,
        impactGuidanceCount: 1,
        driftWarningCount: 0
      },
      {
        totalToolCalls: 4,
        readCalls: 2,
        uniqueFilesRead: 2,
        repeatedReads: 0,
        searchCalls: 0,
        editWriteCalls: 1,
        firstEditTurn: 2,
        firstEditIndex: 2,
        first10DistinctFilesRead: ["lib/a.js", "README.md"],
        filesEdited: ["lib/core.js"]
      },
      ["lib/other.js"]
    );

    expect(signal).toEqual({
      recommendedFilesRead: 1,
      firstFileReadWasRecommended: true,
      finalEditedFileWasRecommendedOrEntryPoint: true,
      distinctRecommendedFilesTouched: 2
    });
  });

  it("builds pair deltas only for exact run and config matches", () => {
    const stock = runFixture({
      mode: "stock",
      runId: "paired",
      usage: { maxObservedTotalTokens: 100, sessionFileSizeBytes: 100 },
      tools: { readCalls: 2, uniqueFilesRead: 2, repeatedReads: 0, totalToolCalls: 5 }
    });
    const sydes = runFixture({
      mode: "sydes",
      runId: "paired",
      usage: { maxObservedTotalTokens: 150, sessionFileSizeBytes: 120 },
      tools: { readCalls: 4, uniqueFilesRead: 3, repeatedReads: 1, totalToolCalls: 8 }
    });
    const older = runFixture({ mode: "sydes", runId: "older", maxTokens: null });

    expect(buildPairComparisons([stock, sydes, older])).toEqual([
      expect.objectContaining({
        instanceId: "repo__task-1",
        runId: "paired",
        maxContextDelta: 50,
        maxContextDeltaPercent: 50,
        modelResponseCountDelta: 0,
        sessionSizeDelta: 20,
        readCallDelta: 2,
        uniqueFilesReadDelta: 1,
        repeatedReadDelta: 1,
        toolCallDelta: 3
      })
    ]);
  });

  it("analyzes fixture artifact directories, classifies infrastructure failure, groups configs, and writes JSON/CSV", async () => {
    const root = await tempRoot();
    const pilotPath = join(root, "pilot.json");
    const artifactsRoot = join(root, "artifacts");
    const outputDir = join(root, "out");
    await writeFile(pilotPath, JSON.stringify({ name: "fixture", instances: ["repo__task-1"] }));
    await makeRun(artifactsRoot, "repo__task-1", "paired", "stock", {
      session: [
        { message: { role: "assistant", usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 10, totalTokens: 110 }, content: [{ toolCallId: "s1", name: "read", args: { path: "/repo/a.go" } }] } },
        { message: { role: "assistant", usage: { inputTokens: 150, cacheReadTokens: 50, outputTokens: 15, totalTokens: 160 }, content: [{ toolCallId: "s2", name: "edit", args: { path: "/repo/b.go" } }] } }
      ],
      diff: "diff --git a/b.go b/b.go\n+fix\n"
    });
    await makeRun(artifactsRoot, "repo__task-1", "paired", "sydes", {
      session: [
        { message: { role: "assistant", usage: { inputTokens: 120, cacheReadTokens: 30, outputTokens: 12, totalTokens: 130 }, content: [{ toolCallId: "y1", name: "read", args: { path: "/repo/a.go" } }] } },
        { message: { role: "assistant", usage: { inputTokens: 190, cacheReadTokens: 60, outputTokens: 20, totalTokens: 210 }, content: [{ toolCallId: "y2", name: "write", args: { path: "/repo/c.go" } }] } }
      ],
      diff: "diff --git a/c.go b/c.go\n+fix\n",
      sydes: true
    });
    await makeRun(artifactsRoot, "repo__task-1", "failed", "sydes", {
      session: [
        { message: { role: "assistant", usage: { inputTokens: 70000, cacheReadTokens: 1000, outputTokens: 50, totalTokens: 71050 } } }
      ],
      repeatStatus: { status: "infrastructure_failed", exitCode: 1 },
      maxTokens: null
    });

    const log = vi.fn();
    const analysis = await analyzeSwePilot({ pilotPath, artifactsRoot, outputDir, log });
    expect(analysis.runs).toHaveLength(3);
    expect(analysis.pairs).toHaveLength(1);
    expect(analysis.runs.find((run) => run.runId === "failed")?.status).toBe("infrastructure_failed");
    expect(analysis.configGroups.map((group) => group.configKey).sort()).toEqual([
      "model=openai/gpt-5-nano;thinking=medium;maxTokens=16384",
      "model=openai/gpt-5-nano;thinking=medium;maxTokens=unknown"
    ]);
    const json = JSON.parse(await readFile(join(outputDir, "pilot-analysis.json"), "utf8"));
    const csv = await readFile(join(outputDir, "pilot-analysis.csv"), "utf8");
    expect(json.note).toContain("not unique tokens consumed");
    expect(csv).toContain("maxObservedTotalTokens");
    expect(log.mock.calls.flat().join("\n")).toContain("Paired summary:");
  });

  it("parses CLI args with optional artifact and output roots", () => {
    const parsed = parseSweAnalyzeArgs([
      "--pilot", "benchmarks/swebench/pilot.json",
      "--artifacts-root", "~/artifacts",
      "--output-dir", "~/out"
    ], { HOME: "/tmp/home" });
    expect(parsed.pilotPath).toBe("/Users/ksnaik/Projects/sydes-pi/benchmarks/swebench/pilot.json");
    expect(parsed.artifactsRoot).toBe("/tmp/home/artifacts");
    expect(parsed.outputDir).toBe("/tmp/home/out");
  });
});

async function makeRun(
  root: string,
  instanceId: string,
  runId: string,
  mode: "stock" | "sydes",
  options: { session: unknown[]; diff?: string; sydes?: boolean; repeatStatus?: unknown; maxTokens?: number | null }
): Promise<void> {
  const dir = join(root, instanceId, runId, mode);
  const sessionDir = join(dir, "pi-sessions");
  const sessionPath = join(sessionDir, "session.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionPath, lines(options.session));
  await writeFile(join(dir, "run.json"), JSON.stringify({
    model: "openai/gpt-5-nano",
    thinking: "medium",
    maxTokens: options.maxTokens === undefined ? 16384 : options.maxTokens,
    worktree: "/repo",
    piSessionPath: sessionPath
  }));
  if (options.diff !== undefined) await writeFile(join(dir, "final.diff"), options.diff);
  if (options.repeatStatus) await writeFile(join(dir, "repeat-status.json"), JSON.stringify(options.repeatStatus));
  if (options.sydes) {
    await writeFile(join(dir, "sydes.json"), JSON.stringify({
      explorationGuidanceInjected: true,
      explorationContext: {
        entryPoints: [{ filePath: "c.go" }],
        files: ["a.go", "c.go"],
        tests: ["c_test.go"],
        relationships: [{ from: "A", to: "C", type: "calls" }],
        queryCount: 3
      },
      impactGuidanceCount: 1,
      driftWarningCount: 0
    }));
  }
}

function runFixture(overrides: Partial<Omit<AnalyzedSweRun, "usage" | "tools">> & {
  usage?: Partial<AnalyzedSweRun["usage"]>;
  tools?: Partial<AnalyzedSweRun["tools"]>;
}): AnalyzedSweRun {
  const base: AnalyzedSweRun = {
    instanceId: "repo__task-1",
    runId: "paired",
    mode: "stock",
    artifactPath: "/tmp/run",
    model: "openai/gpt-5-nano",
    thinking: "medium",
    maxTokens: 16384,
    status: "completed",
    usage: {
      sessionFileSizeBytes: 100,
      nonZeroUsageRecords: 2,
      maxObservedTotalTokens: 100,
      finalObservedTotalTokens: 100,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0
    },
    tools: {
      totalToolCalls: 5,
      readCalls: 2,
      uniqueFilesRead: 2,
      repeatedReads: 0,
      searchCalls: 0,
      editWriteCalls: 1,
      firstEditTurn: 1,
      firstEditIndex: 1,
      first10DistinctFilesRead: [],
      filesEdited: []
    },
    finalChangedFiles: [],
    sydes: null,
    guidanceFollowing: null
  };
  return {
    ...base,
    ...overrides,
    usage: { ...base.usage, ...(overrides.usage ?? {}) },
    tools: { ...base.tools, ...(overrides.tools ?? {}) }
  };
}

function lines(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sydes-swe-analysis-test-"));
  tempRoots.push(root);
  return root;
}
