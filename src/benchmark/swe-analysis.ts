import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SweMode } from "./swebench.js";

export interface SweAnalyzeOptions {
  pilotPath: string;
  artifactsRoot: string;
  outputDir: string;
  log?: (message: string) => void;
}

export interface UsageMetrics {
  sessionFileSizeBytes: number | null;
  nonZeroUsageRecords: number;
  maxObservedTotalTokens: number | null;
  finalObservedTotalTokens: number | null;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ToolMetrics {
  totalToolCalls: number;
  readCalls: number;
  uniqueFilesRead: number;
  repeatedReads: number;
  searchCalls: number;
  editWriteCalls: number;
  firstEditTurn: number | null;
  firstEditIndex: number | null;
  first10DistinctFilesRead: string[];
  filesEdited: string[];
}

export interface SydesMetrics {
  explorationGuidanceInjected: boolean | null;
  graphEntryPoints: string[];
  recommendedFiles: string[];
  recommendedTests: string[];
  relationshipCount: number | null;
  queryCount: number | null;
  impactGuidanceCount: number | null;
  driftWarningCount: number | null;
}

export interface GuidanceFollowingMetrics {
  recommendedFilesRead: number | null;
  firstFileReadWasRecommended: boolean | null;
  finalEditedFileWasRecommendedOrEntryPoint: boolean | null;
  distinctRecommendedFilesTouched: number | null;
}

export interface AnalyzedSweRun {
  instanceId: string;
  runId: string;
  mode: SweMode;
  artifactPath: string;
  model: string | null;
  thinking: string | null;
  maxTokens: number | null;
  status: string;
  usage: UsageMetrics;
  tools: ToolMetrics;
  finalChangedFiles: string[];
  sydes: SydesMetrics | null;
  guidanceFollowing: GuidanceFollowingMetrics | null;
  correctness?: {
    resolved?: boolean;
    unresolved?: boolean;
    emptyPatch?: boolean;
    infrastructureFailed?: boolean;
    reason: string;
  };
}

export interface PairComparison {
  instanceId: string;
  runId: string;
  configKey: string;
  stockRunId: string;
  sydesRunId: string;
  maxContextDelta: number | null;
  maxContextDeltaPercent: number | null;
  modelResponseCountDelta: number;
  sessionSizeDelta: number | null;
  readCallDelta: number;
  uniqueFilesReadDelta: number;
  repeatedReadDelta: number;
  toolCallDelta: number;
}

export interface SwePilotAnalysis {
  generatedAt: string;
  pilotPath: string;
  artifactRoot: string;
  outputDir: string;
  note: string;
  runs: AnalyzedSweRun[];
  pairs: PairComparison[];
  configGroups: Array<{ configKey: string; runCount: number; runs: Array<{ instanceId: string; runId: string; mode: SweMode }> }>;
}

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  turn: number;
  index: number;
}

export function parseSweAnalyzeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SweAnalyzeOptions {
  const home = env.HOME ?? homedir();
  const pilotPath = valueAfter(argv, "--pilot") ?? valueWithPrefix(argv, "--pilot=") ?? "benchmarks/swebench/pilot.json";
  const artifactsRoot = valueAfter(argv, "--artifacts-root") ?? valueWithPrefix(argv, "--artifacts-root=") ?? join(home, ".sydes-pi/swebench");
  const outputDir = valueAfter(argv, "--output-dir") ?? valueWithPrefix(argv, "--output-dir=") ?? join(home, "bench-results/pilot-analysis");
  return {
    pilotPath: resolve(expandHome(pilotPath, home)),
    artifactsRoot: resolve(expandHome(artifactsRoot, home)),
    outputDir: resolve(expandHome(outputDir, home)),
    log: console.log
  };
}

export async function analyzeSwePilot(options: SweAnalyzeOptions): Promise<SwePilotAnalysis> {
  const log = options.log ?? (() => undefined);
  const pilot = await readPilot(options.pilotPath);
  const instanceIds = pilot.instances.length ? pilot.instances : await childDirs(options.artifactsRoot).catch(() => []);
  const runs: AnalyzedSweRun[] = [];
  for (const instanceId of instanceIds) {
    const instanceRoot = join(options.artifactsRoot, instanceId);
    if (!existsSync(instanceRoot)) continue;
    for (const runId of await childDirs(instanceRoot)) {
      for (const mode of ["stock", "sydes"] as const) {
        const modeDir = join(instanceRoot, runId, mode);
        if (existsSync(modeDir)) runs.push(await analyzeSweRunDir(instanceId, runId, mode, modeDir));
      }
    }
  }

  runs.sort(compareRuns);
  const pairs = buildPairComparisons(runs);
  const analysis: SwePilotAnalysis = {
    generatedAt: new Date().toISOString(),
    pilotPath: options.pilotPath,
    artifactRoot: options.artifactsRoot,
    outputDir: options.outputDir,
    note: "cacheRead/totalTokens sums across turns are not unique tokens consumed; they are per-response telemetry totals.",
    runs,
    pairs,
    configGroups: buildConfigGroups(runs)
  };

  await mkdir(options.outputDir, { recursive: true });
  await writeFile(join(options.outputDir, "pilot-analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`);
  await writeFile(join(options.outputDir, "pilot-analysis.csv"), toCsv(runs));
  printSummary(analysis, log);
  return analysis;
}

export async function analyzeSweRunDir(instanceId: string, runId: string, mode: SweMode, artifactPath: string): Promise<AnalyzedSweRun> {
  const run = await readJson(join(artifactPath, "run.json"));
  const repeatStatus = await readJson(join(artifactPath, "repeat-status.json"));
  const sessionPath = await findSessionPath(artifactPath, run?.piSessionPath);
  const sessionText = sessionPath ? await readFile(sessionPath, "utf8").catch(() => "") : "";
  const entries = parseJsonl(sessionText);
  const calls = collectToolCalls(entries);
  const tools = extractToolMetrics(entries, String(run?.worktree ?? ""));
  const finalDiff = await readFile(join(artifactPath, "final.diff"), "utf8").catch(() => "");
  const finalChangedFiles = changedFilesFromDiff(finalDiff);
  const sydes = mode === "sydes" ? await extractSydesMetrics(artifactPath) : null;
  const guidanceFollowing = mode === "sydes" ? buildGuidanceFollowing(sydes, tools, finalChangedFiles) : null;
  const status = classifyRunStatus({ repeatStatus, sessionPath, finalDiff, run });
  return {
    instanceId,
    runId,
    mode,
    artifactPath,
    model: stringOrNull(run?.model),
    thinking: stringOrNull(run?.thinking),
    maxTokens: numberOrNull(run?.maxTokens),
    status,
    usage: extractUsageMetrics(entries, sessionPath),
    tools: { ...tools, totalToolCalls: calls.length },
    finalChangedFiles,
    sydes,
    guidanceFollowing
  };
}

export function extractUsageMetrics(entries: unknown[], sessionPath?: string | null): UsageMetrics {
  const records = collectUsageRecords(entries).filter((usage) => usageHasNonZeroTokens(usage));
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let maxObservedTotalTokens: number | null = null;
  let finalObservedTotalTokens: number | null = null;

  for (const usage of records) {
    const input = usageNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"]) ?? 0;
    const cacheRead = usageNumber(usage, ["cacheReadTokens", "cache_read_tokens", "cachedTokens", "cached_tokens", "cacheRead"])
      ?? nestedNumber(usage, ["inputTokensDetails", "cachedTokens"])
      ?? nestedNumber(usage, ["input_tokens_details", "cached_tokens"])
      ?? nestedNumber(usage, ["prompt_tokens_details", "cached_tokens"])
      ?? 0;
    const output = usageNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "output"]) ?? 0;
    const reasoning = usageNumber(usage, ["reasoningTokens", "reasoning_tokens"])
      ?? nestedNumber(usage, ["outputTokensDetails", "reasoningTokens"])
      ?? nestedNumber(usage, ["output_tokens_details", "reasoning_tokens"])
      ?? nestedNumber(usage, ["completion_tokens_details", "reasoning_tokens"])
      ?? 0;
    const total = usageNumber(usage, ["totalTokens", "total_tokens", "total"]);
    uncachedInputTokens += Math.max(0, input - cacheRead);
    cacheReadTokens += cacheRead;
    outputTokens += output;
    reasoningTokens += reasoning;
    if (total !== null) {
      maxObservedTotalTokens = maxObservedTotalTokens === null ? total : Math.max(maxObservedTotalTokens, total);
      finalObservedTotalTokens = total;
    }
  }

  return {
    sessionFileSizeBytes: sessionPath && existsSync(sessionPath) ? statSync(sessionPath).size : null,
    nonZeroUsageRecords: records.length,
    maxObservedTotalTokens,
    finalObservedTotalTokens,
    uncachedInputTokens,
    cacheReadTokens,
    outputTokens,
    reasoningTokens
  };
}

export function extractToolMetrics(entries: unknown[], repoRoot = ""): ToolMetrics {
  const calls = collectToolCalls(entries);
  const readFiles: string[] = [];
  const editedFiles: string[] = [];
  let searchCalls = 0;
  let firstEditTurn: number | null = null;
  let firstEditIndex: number | null = null;

  for (const call of calls) {
    const kind = toolKind(call);
    if (kind === "read") readFiles.push(...pathsFromArgs(call.args, repoRoot));
    if (kind === "search") searchCalls += 1;
    if (kind === "edit") {
      editedFiles.push(...pathsFromArgs(call.args, repoRoot));
      if (firstEditTurn === null) {
        firstEditTurn = call.turn;
        firstEditIndex = call.index;
      }
    }
  }
  const distinctReads = unique(readFiles);
  return {
    totalToolCalls: calls.length,
    readCalls: calls.filter((call) => toolKind(call) === "read").length,
    uniqueFilesRead: distinctReads.length,
    repeatedReads: Math.max(0, readFiles.length - distinctReads.length),
    searchCalls,
    editWriteCalls: calls.filter((call) => toolKind(call) === "edit").length,
    firstEditTurn,
    firstEditIndex,
    first10DistinctFilesRead: distinctReads.slice(0, 10),
    filesEdited: unique(editedFiles)
  };
}

export function buildPairComparisons(runs: AnalyzedSweRun[]): PairComparison[] {
  const byKey = new Map<string, AnalyzedSweRun[]>();
  for (const run of runs) {
    const key = `${run.instanceId}\0${run.runId}\0${configKey(run)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), run]);
  }
  const pairs: PairComparison[] = [];
  for (const group of byKey.values()) {
    const stock = group.find((run) => run.mode === "stock");
    const sydes = group.find((run) => run.mode === "sydes");
    if (!stock || !sydes) continue;
    const stockMax = stock.usage.maxObservedTotalTokens;
    const sydesMax = sydes.usage.maxObservedTotalTokens;
    const maxContextDelta = stockMax !== null && sydesMax !== null ? sydesMax - stockMax : null;
    pairs.push({
      instanceId: stock.instanceId,
      runId: stock.runId,
      configKey: configKey(stock),
      stockRunId: stock.runId,
      sydesRunId: sydes.runId,
      maxContextDelta,
      maxContextDeltaPercent: maxContextDelta !== null && stockMax ? (maxContextDelta / stockMax) * 100 : null,
      modelResponseCountDelta: sydes.usage.nonZeroUsageRecords - stock.usage.nonZeroUsageRecords,
      sessionSizeDelta: stock.usage.sessionFileSizeBytes !== null && sydes.usage.sessionFileSizeBytes !== null
        ? sydes.usage.sessionFileSizeBytes - stock.usage.sessionFileSizeBytes
        : null,
      readCallDelta: sydes.tools.readCalls - stock.tools.readCalls,
      uniqueFilesReadDelta: sydes.tools.uniqueFilesRead - stock.tools.uniqueFilesRead,
      repeatedReadDelta: sydes.tools.repeatedReads - stock.tools.repeatedReads,
      toolCallDelta: sydes.tools.totalToolCalls - stock.tools.totalToolCalls
    });
  }
  return pairs.sort((a, b) => `${a.instanceId}/${a.runId}`.localeCompare(`${b.instanceId}/${b.runId}`));
}

export function buildGuidanceFollowing(sydes: SydesMetrics | null, tools: ToolMetrics, finalChangedFiles: string[]): GuidanceFollowingMetrics {
  if (!sydes) {
    return {
      recommendedFilesRead: null,
      firstFileReadWasRecommended: null,
      finalEditedFileWasRecommendedOrEntryPoint: null,
      distinctRecommendedFilesTouched: null
    };
  }
  const recommended = new Set([...sydes.recommendedFiles, ...sydes.graphEntryPoints].map(normalizePath).filter(Boolean));
  const read = tools.first10DistinctFilesRead.map(normalizePath).filter(Boolean);
  const edited = unique([...tools.filesEdited, ...finalChangedFiles].map(normalizePath).filter(Boolean));
  const readHits = read.filter((file) => recommended.has(file));
  const touchedHits = edited.filter((file) => recommended.has(file));
  return {
    recommendedFilesRead: readHits.length,
    firstFileReadWasRecommended: read.length > 0 ? recommended.has(read[0]) : null,
    finalEditedFileWasRecommendedOrEntryPoint: edited.length > 0 ? touchedHits.length > 0 : null,
    distinctRecommendedFilesTouched: unique([...readHits, ...touchedHits]).length
  };
}

async function extractSydesMetrics(artifactPath: string): Promise<SydesMetrics> {
  const sydes = await readJson(join(artifactPath, "sydes.json"));
  const preflight = await readJson(join(artifactPath, "preflight-context.json"));
  const context = sydes?.explorationContext ?? preflight ?? {};
  const entryPoints = arrayOfObjects(context.entryPoints).map((entry) => normalizePath(stringOrNull(entry.filePath) ?? "")).filter(Boolean);
  return {
    explorationGuidanceInjected: typeof sydes?.explorationGuidanceInjected === "boolean" ? sydes.explorationGuidanceInjected : null,
    graphEntryPoints: unique(entryPoints),
    recommendedFiles: unique(arrayOfStrings(context.files).map(normalizePath).filter(Boolean)),
    recommendedTests: unique(arrayOfStrings(context.tests).map(normalizePath).filter(Boolean)),
    relationshipCount: Array.isArray(context.relationships) ? context.relationships.length : null,
    queryCount: numberOrNull(context.queryCount ?? context.querySummary?.queryCount),
    impactGuidanceCount: numberOrNull(sydes?.impactGuidanceCount),
    driftWarningCount: numberOrNull(sydes?.driftWarningCount)
  };
}

function collectUsageRecords(entries: unknown[]): any[] {
  const records: any[] = [];
  for (const object of walkObjects(entries)) {
    if (object?.usage && typeof object.usage === "object") records.push(object.usage);
  }
  return records;
}

function usageHasNonZeroTokens(usage: any): boolean {
  return [
    usageNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"]),
    usageNumber(usage, ["cacheReadTokens", "cache_read_tokens", "cachedTokens", "cached_tokens", "cacheRead"]),
    usageNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "output"]),
    usageNumber(usage, ["reasoningTokens", "reasoning_tokens"]),
    usageNumber(usage, ["totalTokens", "total_tokens", "total"])
  ].some((value) => (value ?? 0) > 0);
}

function collectToolCalls(entries: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  let turn = 0;
  let index = 0;
  for (const entry of entries) {
    if (getRole(entry) === "assistant") turn += 1;
    for (const object of walkObjects(entry)) {
      const id = stringOrNull(object.toolCallId ?? object.tool_call_id ?? object.id);
      const name = stringOrNull(object.toolName ?? object.name);
      const args = object.args ?? object.input ?? object.parameters ?? object.arguments;
      if (id && name && args !== undefined) calls.push({ id, name, args, turn, index: index++ });
    }
  }
  return dedupeBy(calls, (call) => call.id);
}

function toolKind(call: ToolCall): "read" | "search" | "edit" | "other" {
  const name = call.name.toLowerCase();
  const command = String((call.args as any)?.command ?? "");
  if (["edit", "write", "replace"].includes(name)) return "edit";
  if (["read", "open", "view", "cat"].includes(name)) return "read";
  if (["search", "grep", "rg"].includes(name)) return "search";
  if (name === "bash" || name === "shell") {
    if (/^\s*(cat|sed|nl|head|tail)\b/.test(command)) return "read";
    if (/^\s*(rg|grep|find)\b/.test(command)) return "search";
    if (/(^|\s)(apply_patch|python|perl|ruby|node)\b/.test(command) || />/.test(command)) return "edit";
  }
  return "other";
}

function pathsFromArgs(args: unknown, repoRoot: string): string[] {
  const found: string[] = [];
  for (const object of walkObjects(args)) {
    for (const key of ["path", "file", "filePath", "filepath", "filename", "target"]) {
      const value = stringOrNull(object[key]);
      if (value) found.push(relativePath(value, repoRoot));
    }
    const command = stringOrNull(object.command);
    if (command) found.push(...pathsFromCommand(command, repoRoot));
  }
  return unique(found.map(normalizePath).filter(Boolean));
}

function pathsFromCommand(command: string, repoRoot: string): string[] {
  const tokens = command.match(/(?:'[^']+'|"[^"]+"|\S+)/g) ?? [];
  return tokens
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token) => /[./][A-Za-z0-9_.-]/.test(token) && !token.startsWith("-") && !/[|;&$<>]/.test(token))
    .map((token) => relativePath(token, repoRoot));
}

function relativePath(path: string, repoRoot: string): string {
  if (repoRoot && path.startsWith(`${repoRoot}/`)) return path.slice(repoRoot.length + 1);
  return path.replace(/^\.\/+/, "");
}

function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.push(match[2]);
  }
  return unique(files.map(normalizePath).filter(Boolean));
}

function classifyRunStatus(input: { repeatStatus: any; sessionPath: string | null; finalDiff: string; run: any }): string {
  const status = stringOrNull(input.repeatStatus?.status);
  if (status) return status;
  if (input.run?.dryRun) return "dry_run";
  if (input.sessionPath) return "completed";
  if (existsSync(join(dirname(String(input.run?.artifactPath ?? "")), "repeat-status.json"))) return "infrastructure_failed";
  return input.finalDiff ? "completed_without_session" : "unknown";
}

async function findSessionPath(artifactPath: string, recorded: unknown): Promise<string | null> {
  const fromRun = stringOrNull(recorded);
  if (fromRun && existsSync(fromRun)) return fromRun;
  const sessionRoot = join(artifactPath, "pi-sessions");
  if (!existsSync(sessionRoot)) return null;
  const files = await collectFiles(sessionRoot);
  return files.filter((file) => file.endsWith(".jsonl")).sort().at(-1) ?? null;
}

async function readPilot(path: string): Promise<{ name: string; instances: string[] }> {
  const raw = await readJson(path);
  const instances = Array.isArray(raw?.instances)
    ? raw.instances.map((item: any) => typeof item === "string" ? item : stringOrNull(item?.instance_id)).filter(Boolean)
    : [];
  return {
    name: stringOrNull(raw?.name) ?? basename(path, ".json"),
    instances
  };
}

function buildConfigGroups(runs: AnalyzedSweRun[]): SwePilotAnalysis["configGroups"] {
  const groups = new Map<string, AnalyzedSweRun[]>();
  for (const run of runs) groups.set(configKey(run), [...(groups.get(configKey(run)) ?? []), run]);
  return [...groups.entries()].map(([key, groupedRuns]) => ({
    configKey: key,
    runCount: groupedRuns.length,
    runs: groupedRuns.map((run) => ({ instanceId: run.instanceId, runId: run.runId, mode: run.mode }))
  })).sort((a, b) => a.configKey.localeCompare(b.configKey));
}

function configKey(run: Pick<AnalyzedSweRun, "model" | "thinking" | "maxTokens">): string {
  return `model=${run.model ?? "unknown"};thinking=${run.thinking ?? "unknown"};maxTokens=${run.maxTokens ?? "unknown"}`;
}

function toCsv(runs: AnalyzedSweRun[]): string {
  const header = [
    "instanceId", "runId", "mode", "status", "model", "thinking", "maxTokens",
    "sessionFileSizeBytes", "nonZeroUsageRecords", "maxObservedTotalTokens", "finalObservedTotalTokens",
    "uncachedInputTokens", "cacheReadTokens", "outputTokens", "reasoningTokens",
    "totalToolCalls", "readCalls", "uniqueFilesRead", "repeatedReads", "searchCalls", "editWriteCalls",
    "firstEditTurn", "finalChangedFiles", "recommendedFilesRead", "firstFileReadWasRecommended",
    "finalEditedFileWasRecommendedOrEntryPoint", "artifactPath"
  ];
  const rows = runs.map((run) => [
    run.instanceId, run.runId, run.mode, run.status, run.model, run.thinking, run.maxTokens,
    run.usage.sessionFileSizeBytes, run.usage.nonZeroUsageRecords, run.usage.maxObservedTotalTokens, run.usage.finalObservedTotalTokens,
    run.usage.uncachedInputTokens, run.usage.cacheReadTokens, run.usage.outputTokens, run.usage.reasoningTokens,
    run.tools.totalToolCalls, run.tools.readCalls, run.tools.uniqueFilesRead, run.tools.repeatedReads, run.tools.searchCalls, run.tools.editWriteCalls,
    run.tools.firstEditTurn, run.finalChangedFiles.join(";"), run.guidanceFollowing?.recommendedFilesRead,
    run.guidanceFollowing?.firstFileReadWasRecommended, run.guidanceFollowing?.finalEditedFileWasRecommendedOrEntryPoint, run.artifactPath
  ]);
  return `${[header, ...rows].map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

function printSummary(analysis: SwePilotAnalysis, log: (message: string) => void): void {
  log(`SWE pilot analysis: ${analysis.runs.length} runs`);
  log(`Artifacts: ${analysis.artifactRoot}`);
  log(`Output JSON: ${join(analysis.outputDir, "pilot-analysis.json")}`);
  log(`Output CSV: ${join(analysis.outputDir, "pilot-analysis.csv")}`);
  log("Note: cacheRead/totalTokens sums across turns are not unique tokens consumed.");
  log("Run summary:");
  log("Instance                        Run ID                                                Mode   Status                 MaxCtx   Reads Unique Repeat Tools");
  for (const run of analysis.runs) {
    log([
      pad(run.instanceId, 31),
      pad(run.runId, 53),
      pad(run.mode, 6),
      pad(run.status, 22),
      pad(String(run.usage.maxObservedTotalTokens ?? "n/a"), 8),
      pad(String(run.tools.readCalls), 5),
      pad(String(run.tools.uniqueFilesRead), 6),
      pad(String(run.tools.repeatedReads), 6),
      String(run.tools.totalToolCalls)
    ].join(" "));
  }
  log("Paired summary:");
  if (analysis.pairs.length === 0) {
    log("No exact stock/sydes pairs with matching instance, run ID, and configuration.");
    return;
  }
  for (const pair of analysis.pairs) {
    log(`${pair.instanceId} ${pair.runId}: maxContextDelta=${formatNullable(pair.maxContextDelta)} (${formatPercent(pair.maxContextDeltaPercent)}), toolCallDelta=${pair.toolCallDelta}, readCallDelta=${pair.readCallDelta}`);
  }
}

function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function childDirs(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  }));
  return nested.flat();
}

function* walkObjects(value: unknown): Generator<any> {
  if (!value || typeof value !== "object") return;
  yield value as any;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkObjects(item);
  } else {
    for (const item of Object.values(value)) yield* walkObjects(item);
  }
}

function getRole(entry: any): string | undefined {
  return entry?.message?.role ?? entry?.role;
}

function usageNumber(usage: any, keys: string[]): number | null {
  for (const key of keys) {
    if (typeof usage?.[key] === "number") return usage[key];
  }
  return null;
}

function nestedNumber(value: any, path: string[]): number | null {
  let current = value;
  for (const key of path) current = current?.[key];
  return typeof current === "number" ? current : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayOfObjects(value: unknown): any[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function compareRuns(a: AnalyzedSweRun, b: AnalyzedSweRun): number {
  return `${a.instanceId}/${a.runId}/${a.mode}`.localeCompare(`${b.instanceId}/${b.runId}/${b.mode}`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1) : value.padEnd(width);
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function expandHome(value: string, home: string): string {
  return value.replace(/^~(?=$|\/)/, home);
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function valueWithPrefix(argv: string[], prefix: string): string | undefined {
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
