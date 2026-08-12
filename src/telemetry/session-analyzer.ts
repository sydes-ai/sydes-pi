import { readFile, writeFile } from "node:fs/promises";
import { canonicalRepoRelativePath } from "../policy/paths.js";
import type { RepositoryAction } from "../policy/types.js";

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
  timestamp?: string;
}

interface ToolResult {
  id: string;
  name?: string;
  isError?: boolean;
  content?: unknown;
  turn: number;
  timestamp?: string;
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
    .flatMap((call) => readPathsForCall(call, input.repoRoot))
    .filter((path): path is string => !!path);
  const firstEdit = firstSuccessfulEdit(calls, results, input.repoRoot);
  const priority = new Set<string>(
    [
      ...(sydes.explorationContext?.files ?? []),
      ...(sydes.explorationContext?.tests ?? []),
      ...((sydes.explorationContext?.entryPoints ?? []).map((entry: any) => entry.filePath).filter(Boolean) ?? [])
    ]
      .map((path) => canonicalRepoRelativePath(input.repoRoot, path))
      .filter((path): path is string => !!path)
  );
  const first5 = reads.slice(0, 5);
  const first10 = reads.slice(0, 10);
  const first3 = reads.slice(0, 3);
  const first3Hits = first3.filter((path) => priority.has(path));
  const first5Hits = first5.filter((path) => priority.has(path));
  const first10Hits = first10.filter((path) => priority.has(path));
  const relevanceTerms = taskRelevanceTerms(sydes, priority);
  const repositoryActions = collectRepositoryActions(calls, input.repoRoot, priority, relevanceTerms);
  const firstTaskRelevantAction = repositoryActions.find((action) => action.taskRelevant) ?? null;
  const agentTestRuns = calls.filter((call) => call.name === "bash" && /go\s+test/.test(String(decodeArgs(call.args)?.command ?? "")));
  const agentTestIds = new Set(agentTestRuns.map((call) => call.id));
  const agentTestResults = results.filter((result) => agentTestIds.has(result.id));
  const usage = aggregateUsage(entries);
  const diffSummary = summarizeDiff(diffText);
  const provider429Count = countRateLimitEvidence(sessionText);
  const summary = {
    correctness: {
      repoTests: repoTestsText.includes("REPO_TESTS=PASS") ? "PASS" : "FAIL",
      hiddenOracle: oracleText,
      taskCorrectness: /TASK_CORRECTNESS[:=]\s*PASS/.test(oracleText) && /REPO_TESTS[:=]\s*PASS/.test(repoTestsText) ? "PASS" : "FAIL"
    },
    contamination: {
      provider429Count,
      rateLimitContaminated: provider429Count > 0
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
      first3Reads: first3,
      first10Reads: first10,
      readsBeforeFirstEdit: firstEdit ? calls.filter((call) => readPathsForCall(call, input.repoRoot).length > 0 && call.turn <= firstEdit.turn).length : reads.length,
      first3PriorityHits: first3Hits,
      first3PriorityHitRate: first3.length ? first3Hits.length / first3.length : null,
      first5PriorityHits: first5Hits,
      first5PriorityHitRate: first5.length ? first5Hits.length / first5.length : null,
      first10PriorityHits: first10Hits,
      first10PriorityHitRate: first10.length ? first10Hits.length / first10.length : null,
      firstPriorityReadTurn: firstPriorityReadTurn(calls, input.repoRoot, priority),
      firstRepositoryAction: repositoryActions[0] ?? null,
      firstRepositoryActions: repositoryActions.slice(0, 10),
      firstTaskRelevantActionTurn: firstTaskRelevantAction?.turn ?? null
    },
    editing: {
      firstEditFile: firstEdit?.file ?? null,
      firstEditTurn: firstEdit?.turn ?? null,
      timeToFirstEditSeconds: firstEdit?.timestamp ? elapsedSeconds(run.startTime, firstEdit.timestamp) : null,
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
      cbmFallbackUsed: !!sydes.cbmFallbackUsed,
      projectIndexedThisSession: !!sydes.explorationContext?.projectIndexedThisSession,
      projectEnsureElapsedMs: sydes.explorationContext?.projectEnsureElapsedMs ?? null,
      projectIndexElapsedMs: sydes.explorationContext?.projectIndexElapsedMs ?? null,
      projectReadinessWaitMs: sydes.explorationContext?.projectReadinessWaitMs ?? null,
      projectReadinessPollCount: sydes.explorationContext?.projectReadinessPollCount ?? null,
      projectReadinessStrategy: sydes.explorationContext?.projectReadinessStrategy ?? null,
      driftAnalysisCount: sydes.driftAnalysisCount ?? 0,
      driftWarningCount: sydes.driftWarningCount ?? 0,
      latestDriftSeverity: sydes.driftEvents?.at?.(-1)?.severity ?? null,
      latestUnexpectedChangedSymbols: sydes.driftEvents?.at?.(-1)?.unexpectedChangedSymbols ?? [],
      impactInjectionHook: sydes.impactGuidanceEvents?.at?.(-1)?.injectionHook ?? null,
      impactGuidanceSuppressedAsAlreadyVerified: !!sydes.impactGuidanceEvents?.some?.((event: any) => event.suppressedAsAlreadyVerified),
      impactGuidanceInjectedBeforeNextModelTurn: !!sydes.impactGuidanceEvents?.some?.((event: any) => event.injectedBeforeNextModelTurn)
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
  let assistantTurn = 0;
  entries.forEach((entry) => {
    if (getRole(entry) === "assistant") {
      assistantTurn += 1;
    }
    for (const object of walkObjects(entry)) {
      const id = stringValue(object.toolCallId ?? object.tool_call_id ?? object.id);
      const name = stringValue(object.toolName ?? object.name);
      if (id && name && (object.args || object.input || object.parameters || object.arguments)) {
        calls.push({
          id,
          name,
          args: object.args ?? object.input ?? object.parameters ?? object.arguments,
          turn: assistantTurn,
          timestamp: stringValue(object.timestamp) ?? stringValue((entry as any)?.timestamp)
        });
      }
    }
  });
  return dedupeBy(calls, (call) => call.id);
}

function collectToolResults(entries: unknown[]): ToolResult[] {
  const results: ToolResult[] = [];
  let assistantTurn = 0;
  entries.forEach((entry) => {
    if (getRole(entry) === "assistant") {
      assistantTurn += 1;
    }
    for (const object of walkObjects(entry)) {
      const id = stringValue(object.toolCallId ?? object.tool_call_id);
      if (id && ("isError" in object || "content" in object) && !("args" in object)) {
        results.push({
          id,
          name: stringValue(object.toolName),
          isError: typeof object.isError === "boolean" ? object.isError : undefined,
          content: object.content,
          turn: assistantTurn,
          timestamp: stringValue(object.timestamp) ?? stringValue((entry as any)?.timestamp)
        });
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
  let apiCalls = 0;
  for (const object of walkObjects(entries)) {
    if (object.usage && typeof object.usage === "object") {
      apiCalls += 1;
      for (const [key, value] of Object.entries(object.usage)) {
        if (typeof value === "number") totals[key] = (totals[key] ?? 0) + value;
      }
      const cost = (object.usage as any).cost;
      if (cost && typeof cost === "object") {
        for (const [key, value] of Object.entries(cost)) {
          if (typeof value === "number") totals[`cost.${key}`] = (totals[`cost.${key}`] ?? 0) + value;
        }
      }
    }
  }
  return {
    apiCalls: apiCalls || null,
    inputTokens: totals.inputTokens ?? totals.input_tokens ?? totals.promptTokens ?? totals.prompt_tokens ?? totals.input ?? null,
    cachedTokens: totals.cacheReadTokens ?? totals.cache_read_tokens ?? totals.cachedTokens ?? totals.cached_tokens ?? totals.cacheRead ?? null,
    cacheWriteTokens: totals.cacheWriteTokens ?? totals.cache_write_tokens ?? totals.cacheWrite ?? null,
    outputTokens: totals.outputTokens ?? totals.output_tokens ?? totals.completionTokens ?? totals.completion_tokens ?? totals.output ?? null,
    reasoningTokens: totals.reasoningTokens ?? totals.reasoning_tokens ?? null,
    totalTokens: totals.totalTokens ?? totals.total_tokens ?? null,
    totalCost: totals.totalCost ?? totals.total_cost ?? totals["cost.total"] ?? null
  };
}

function firstSuccessfulEdit(calls: ToolCall[], results: ToolResult[], repoRoot: string): { file: string | null; turn: number; timestamp?: string } | null {
  const successfulIds = new Set(results.filter((result) => result.isError === false).map((result) => result.id));
  const call = calls.find((item) => (item.name === "edit" || item.name === "write") && successfulIds.has(item.id));
  return call ? { file: normalizePath(repoRoot, getArgPath(call.args)) ?? null, turn: call.turn, timestamp: call.timestamp } : null;
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
    if (readPathsForCall(call, repoRoot).some((path) => priority.has(path))) return call.turn;
  }
  return null;
}

function getArgPath(args: unknown): string | undefined {
  const decoded = decodeArgs(args);
  return typeof decoded?.path === "string" ? decoded.path : undefined;
}

function decodeArgs(args: unknown): any {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args as any;
}

function normalizePath(repoRoot: string, path: string | undefined): string | undefined {
  return canonicalRepoRelativePath(repoRoot, path);
}

function readPathsForCall(call: ToolCall, repoRoot: string): string[] {
  if (call.name === "read") {
    const path = normalizePath(repoRoot, getArgPath(call.args));
    return path ? [path] : [];
  }
  if (call.name !== "bash") return [];
  const command = String(decodeArgs(call.args)?.command ?? "");
  const paths = new Set<string>();
  for (const match of command.matchAll(/\b(?:sed|nl|cat)\b(?:\s+-[^\s]+)*\s+(?:'[^']*'\s+|"[^"]*"\s+)?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g)) {
    const path = normalizePath(repoRoot, match[1]);
    if (path) paths.add(path);
  }
  return [...paths];
}

function collectRepositoryActions(
  calls: ToolCall[],
  repoRoot: string,
  priority: Set<string>,
  relevanceTerms: Set<string>
): RepositoryAction[] {
  return calls
    .map((call) => repositoryActionForCall(call, repoRoot, priority, relevanceTerms))
    .filter((action): action is RepositoryAction => !!action);
}

export function repositoryActionForCall(
  call: ToolCall,
  repoRoot: string,
  priority: Set<string>,
  relevanceTerms: Set<string>
): RepositoryAction | null {
  const args = decodeArgs(call.args);
  if (call.name === "read") {
    const target = normalizePath(repoRoot, typeof args?.path === "string" ? args.path : undefined);
    return target
      ? {
          type: "read",
          toolName: call.name,
          turn: call.turn,
          target,
          taskRelevant: priority.has(target)
        }
      : null;
  }
  if (call.name === "edit" || call.name === "write") {
    const target = normalizePath(repoRoot, typeof args?.path === "string" ? args.path : undefined);
    return {
      type: call.name,
      toolName: call.name,
      turn: call.turn,
      target,
      taskRelevant: !!target && priority.has(target)
    };
  }
  if (call.name === "bash") {
    const command = String(args?.command ?? "");
    const search = parseSearchCommand(command);
    if (search) {
      return {
        type: "search",
        toolName: call.name,
        turn: call.turn,
        query: search.query,
        target: search.target,
        taskRelevant: isSearchRelevant(search.query, search.target, priority, relevanceTerms)
      };
    }
    return {
      type: "bash",
      toolName: call.name,
      turn: call.turn,
      target: command.slice(0, 160),
      taskRelevant: readPathsForCall(call, repoRoot).some((path) => priority.has(path))
    };
  }
  return {
    type: "other",
    toolName: call.name,
    turn: call.turn,
    taskRelevant: false
  };
}

function parseSearchCommand(command: string): { query: string; target?: string } | null {
  const match = command.match(/\b(?:rg|grep)\b\s+(.+)/);
  if (!match) {
    return null;
  }
  const tokens = shellishTokens(match[1]);
  const nonOptions = tokens.filter((token) => !token.startsWith("-"));
  const query = nonOptions[0]?.replace(/^['"]|['"]$/g, "");
  const target = nonOptions.slice(1).join(" ") || undefined;
  return query ? { query, target } : { query: match[1].slice(0, 160) };
}

function shellishTokens(text: string): string[] {
  return Array.from(text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g), (match) => match[1] ?? match[2] ?? match[3]);
}

function isSearchRelevant(
  query: string,
  target: string | undefined,
  priority: Set<string>,
  relevanceTerms: Set<string>
): boolean {
  const haystack = `${query} ${target ?? ""}`.toLowerCase();
  if ([...priority].some((path) => haystack.includes(path.toLowerCase()))) {
    return true;
  }
  if ([...relevanceTerms].some((term) => term.length >= 3 && haystack.includes(term))) {
    return true;
  }
  return tokensForRelevance(haystack).some((token) => relevanceTerms.has(token));
}

function taskRelevanceTerms(sydes: any, priority: Set<string>): Set<string> {
  const terms = new Set<string>();
  for (const path of priority) {
    for (const token of tokensForRelevance(path)) {
      terms.add(token);
    }
  }
  const symbols = [
    ...(sydes.explorationContext?.entryPoints ?? []),
    ...(sydes.explorationContext?.relatedSymbols ?? [])
  ];
  for (const symbol of symbols) {
    for (const value of [symbol.name, symbol.qualifiedName]) {
      addRawRelevanceTerm(terms, String(value ?? ""));
      for (const token of tokensForRelevance(String(value ?? ""))) {
        terms.add(token);
      }
    }
  }
  for (const relationship of sydes.explorationContext?.relationships ?? []) {
    for (const value of [relationship.from, relationship.to]) {
      addRawRelevanceTerm(terms, String(value ?? ""));
      for (const token of tokensForRelevance(String(value ?? ""))) {
        terms.add(token);
      }
    }
  }
  return terms;
}

function addRawRelevanceTerm(terms: Set<string>, value: string): void {
  const raw = value.split(".").at(-1)?.toLowerCase();
  if (raw && raw.length >= 3) {
    terms.add(raw);
  }
}

function tokensForRelevance(text: string): string[] {
  return unique(
    text
      .split(/[^A-Za-z0-9_]+/)
      .flatMap((part) => part.split(/(?=[A-Z])/))
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 3)
  );
}

function summarizeDiff(diffText: string): { files: string[]; insertions: number; deletions: number } {
  const files = [...diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  const insertions = diffText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diffText.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return { files, insertions, deletions };
}

function countRateLimitEvidence(text: string): number {
  const cleaned = text.replace(/RATE_LIMIT_CONTAMINATED[:=]\s*NO/gi, "");
  return (cleaned.match(/rate limit|http\s+429|status(?:\s+code)?\s+429|\b429\b[^\n]{0,80}(?:too many|rate)/gi) ?? []).length;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
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

async function main(args: string[]): Promise<void> {
  const [sessionPath, repoRoot, sydesPath, runJsonPath, finalDiffPath, repoTestsPath, oraclePath, outputPath] =
    args;
  await analyzeSession({ sessionPath, repoRoot, sydesPath, runJsonPath, finalDiffPath, repoTestsPath, oraclePath, outputPath });
}

const scriptArgIndex = process.argv.findIndex((arg) => arg.endsWith("session-analyzer.ts"));
if (scriptArgIndex >= 0) {
  void main(process.argv.slice(scriptArgIndex + 1)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
