import { readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

interface AnalyzerInput {
  sessionPath: string;
  repoRoot: string;
  sydesPath: string;
  runJsonPath: string;
  finalDiffPath: string;
  repoTestsPath: string;
  oraclePath: string;
  outputPath: string;
}

interface ToolCall {
  id: string;
  name: string;
  args?: unknown;
  turn: number;
}

interface ToolResult {
  id: string;
  name?: string;
  isError?: boolean;
  content?: unknown;
  turn: number;
}

export async function analyzeSession(input: AnalyzerInput): Promise<Record<string, unknown>> {
  const [sessionText, sydesText, runText, diffText, repoTestsText, oracleText] = await Promise.all([
    readFile(input.sessionPath, "utf8"),
    readFile(input.sydesPath, "utf8").catch(() => "{}"),
    readFile(input.runJsonPath, "utf8").catch(() => "{}"),
    readFile(input.finalDiffPath, "utf8").catch(() => ""),
    readFile(input.repoTestsPath, "utf8").catch(() => ""),
    readFile(input.oraclePath, "utf8").catch(() => "")
  ]);
  const entries = sessionText
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const sydes = JSON.parse(sydesText) as any;
  const run = JSON.parse(runText) as any;

  const assistantEntries = entries.filter((entry) => getRole(entry) === "assistant");
  const turns = assistantEntries.length;
  const calls = collectToolCalls(entries);
  const results = collectToolResults(entries);
  const resultIds = new Set(results.map((result) => result.id));
  const successful = results.filter((result) => result.isError === false).length;
  const failed = results.filter((result) => result.isError === true).length;
  const unresolved = calls.filter((call) => !resultIds.has(call.id)).length;
  const reads = calls
    .filter((call) => call.name === "read")
    .map((call) => normalizePath(input.repoRoot, getArgPath(call.args)))
    .filter((path): path is string => !!path);
  const firstEdit = firstSuccessfulEdit(calls, results, input.repoRoot);
  const priority = new Set<string>([
    ...(sydes.explorationContext?.files ?? []),
    ...(sydes.explorationContext?.tests ?? []),
    ...((sydes.explorationContext?.entryPoints ?? []).map((entry: any) => entry.filePath).filter(Boolean) ?? [])
  ]);
  const first5 = reads.slice(0, 5);
  const first10 = reads.slice(0, 10);
  const first5Hits = first5.filter((path) => priority.has(path));
  const first10Hits = first10.filter((path) => priority.has(path));
  const agentTestRuns = calls.filter((call) => call.name === "bash" && /go\s+test/.test(String((call.args as any)?.command ?? "")));
  const agentTestIds = new Set(agentTestRuns.map((call) => call.id));
  const agentTestResults = results.filter((result) => agentTestIds.has(result.id));
  const usage = aggregateUsage(entries);
  const diffSummary = summarizeDiff(diffText);
  const provider429Count = countRateLimitEvidence(sessionText);
  const summary = {
    correctness: {
      repoTests: repoTestsText.includes("REPO_TESTS=PASS") ? "PASS" : "FAIL",
      hiddenOracle: oracleText,
      taskCorrectness: oracleText.includes("TASK_CORRECTNESS=PASS") && repoTestsText.includes("REPO_TESTS=PASS") ? "PASS" : "FAIL"
    },
    contamination: {
      provider429Count,
      rateLimitContaminated: provider429Count > 0 || /rate limit|429/i.test(sessionText)
    },
    usage,
    agent: {
      elapsedSeconds: elapsedSeconds(run.startTime, run.endTime),
      turns,
      turnsToFirstEdit: firstEdit ? firstEdit.turn : null,
      turnsAfterLastEdit: turnsAfterLastSuccessfulEdit(calls, results, turns)
    },
    tools: {
      total: calls.length,
      successful,
      failed,
      unresolved,
      byName: countBy(calls.map((call) => call.name)),
      invariantValid: successful + failed + unresolved === calls.length
    },
    exploration: {
      fileReads: reads.length,
      uniqueReads: new Set(reads).size,
      repeatedReads: reads.length - new Set(reads).size,
      first10Reads: first10,
      readsBeforeFirstEdit: firstEdit ? calls.filter((call) => call.name === "read" && call.turn <= firstEdit.turn).length : reads.length,
      first5PriorityHits: first5Hits,
      first5PriorityHitRate: first5.length ? first5Hits.length / first5.length : null,
      first10PriorityHits: first10Hits,
      first10PriorityHitRate: first10.length ? first10Hits.length / first10.length : null,
      firstPriorityReadTurn: firstPriorityReadTurn(calls, input.repoRoot, priority)
    },
    editing: {
      firstEditFile: firstEdit?.file ?? null,
      firstEditTurn: firstEdit?.turn ?? null,
      timeToFirstEditSeconds: null,
      filesChanged: diffSummary.files,
      insertions: diffSummary.insertions,
      deletions: diffSummary.deletions
    },
    testing: {
      agentTestRuns: agentTestRuns.length,
      successfulAgentTestRuns: agentTestResults.filter((result) => result.isError === false).length,
      failedAgentTestRuns: agentTestResults.filter((result) => result.isError === true).length,
      testsAfterLastEdit: testsAfterLastEdit(agentTestRuns, calls, results)
    },
    sydes: {
      explorationGuidanceInjected: !!sydes.explorationGuidanceInjected,
      impactGuidanceCount: sydes.impactGuidanceCount ?? 0,
      impactFollowupTurns: Math.max(0, (sydes.impactGuidanceCount ?? 0) > 0 ? turns - (lastSuccessfulEditTurn(calls, results) ?? turns) : 0),
      cbmProcessStartCount: sydes.cbmProcessStartCount ?? null,
      cbmFallbackUsed: !!sydes.cbmFallbackUsed
    }
  };
  await writeFile(input.outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function getRole(entry: any): string | undefined {
  return entry?.message?.role ?? entry?.message?.type ?? entry?.role;
}

function collectToolCalls(entries: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  entries.forEach((entry, turn) => {
    for (const object of walkObjects(entry)) {
      const id = stringValue(object.toolCallId ?? object.tool_call_id ?? object.id);
      const name = stringValue(object.toolName ?? object.name);
      if (id && name && (object.args || object.input || object.parameters)) {
        calls.push({ id, name, args: object.args ?? object.input ?? object.parameters, turn });
      }
    }
  });
  return dedupeBy(calls, (call) => call.id);
}

function collectToolResults(entries: unknown[]): ToolResult[] {
  const results: ToolResult[] = [];
  entries.forEach((entry, turn) => {
    for (const object of walkObjects(entry)) {
      const id = stringValue(object.toolCallId ?? object.tool_call_id);
      if (id && ("isError" in object || "content" in object) && !("args" in object)) {
        results.push({ id, name: stringValue(object.toolName), isError: typeof object.isError === "boolean" ? object.isError : undefined, content: object.content, turn });
      }
    }
  });
  return dedupeBy(results, (result) => result.id);
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

function aggregateUsage(entries: unknown[]): Record<string, number | null> {
  const totals: Record<string, number> = {};
  for (const object of walkObjects(entries)) {
    if (object.usage && typeof object.usage === "object") {
      for (const [key, value] of Object.entries(object.usage)) {
        if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }
  return {
    apiCalls: Object.keys(totals).length ? Object.values(totals).length : null,
    inputTokens: totals.inputTokens ?? totals.promptTokens ?? null,
    cachedTokens: totals.cacheReadTokens ?? totals.cachedTokens ?? null,
    cacheWriteTokens: totals.cacheWriteTokens ?? null,
    outputTokens: totals.outputTokens ?? totals.completionTokens ?? null,
    reasoningTokens: totals.reasoningTokens ?? null,
    totalTokens: totals.totalTokens ?? null,
    totalCost: totals.totalCost ?? null
  };
}

function firstSuccessfulEdit(calls: ToolCall[], results: ToolResult[], repoRoot: string): { file: string | null; turn: number } | null {
  const successfulIds = new Set(results.filter((result) => result.isError === false).map((result) => result.id));
  const call = calls.find((item) => (item.name === "edit" || item.name === "write") && successfulIds.has(item.id));
  return call ? { file: normalizePath(repoRoot, getArgPath(call.args)) ?? null, turn: call.turn } : null;
}

function lastSuccessfulEditTurn(calls: ToolCall[], results: ToolResult[]): number | null {
  const successfulIds = new Set(results.filter((result) => result.isError === false).map((result) => result.id));
  const edits = calls.filter((item) => (item.name === "edit" || item.name === "write") && successfulIds.has(item.id));
  return edits.at(-1)?.turn ?? null;
}

function turnsAfterLastSuccessfulEdit(calls: ToolCall[], results: ToolResult[], turns: number): number | null {
  const last = lastSuccessfulEditTurn(calls, results);
  return last === null ? null : Math.max(0, turns - last);
}

function testsAfterLastEdit(testRuns: ToolCall[], calls: ToolCall[], results: ToolResult[]): number {
  const last = lastSuccessfulEditTurn(calls, results);
  return last === null ? 0 : testRuns.filter((run) => run.turn > last).length;
}

function firstPriorityReadTurn(calls: ToolCall[], repoRoot: string, priority: Set<string>): number | null {
  for (const call of calls) {
    if (call.name !== "read") continue;
    const path = normalizePath(repoRoot, getArgPath(call.args));
    if (path && priority.has(path)) return call.turn;
  }
  return null;
}

function getArgPath(args: unknown): string | undefined {
  return typeof (args as any)?.path === "string" ? (args as any).path : undefined;
}

function normalizePath(repoRoot: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const abs = path.startsWith("/") ? path : resolve(repoRoot, path);
  const rel = relative(resolve(repoRoot), resolve(abs)).split(/[\\/]+/).join("/");
  return rel && !rel.startsWith("..") ? rel : path.split(/[\\/]+/).slice(-2).join("/");
}

function summarizeDiff(diffText: string): { files: string[]; insertions: number; deletions: number } {
  const files = [...diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  const insertions = diffText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diffText.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return { files, insertions, deletions };
}

function countRateLimitEvidence(text: string): number {
  return (text.match(/\b429\b|rate limit/gi) ?? []).length;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const k = key(value);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function elapsedSeconds(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  return Math.round((Date.parse(end) - Date.parse(start)) / 1000);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

if (process.argv[1]?.endsWith("session-analyzer.ts")) {
  const [sessionPath, repoRoot, sydesPath, runJsonPath, finalDiffPath, repoTestsPath, oraclePath, outputPath] =
    process.argv.slice(2);
  await analyzeSession({ sessionPath, repoRoot, sydesPath, runJsonPath, finalDiffPath, repoTestsPath, oraclePath, outputPath });
}
