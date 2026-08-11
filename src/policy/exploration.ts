import { realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  BuildRelevantContextOptions,
  CbmProject,
  PolicyCbmClient,
  ProjectResolution,
  RelevantContext,
  RelevantRelationship,
  RelevantSymbol
} from "./types.js";

const STOP_WORDS = new Set([
  "the",
  "and",
  "with",
  "must",
  "return",
  "preserve",
  "existing",
  "valid",
  "behavior",
  "update",
  "add",
  "relevant",
  "tests",
  "test",
  "run",
  "affected",
  "make",
  "only",
  "minimal",
  "necessary",
  "changes",
  "http"
]);

const LIMITS = {
  entryPoints: 5,
  relatedSymbols: 12,
  files: 10,
  tests: 5,
  relationships: 20,
  guidanceChars: 1500
};

interface CbmEnvelope<T> {
  structuredContent?: T;
}

interface SearchRows {
  total?: number;
  cols?: string[];
  rows?: unknown[][];
  groups?: Array<{ qn_prefix?: string; rows?: unknown[][] }>;
}

interface TraceRows {
  function?: string;
  callees?: SearchRows;
  callers?: SearchRows;
}

export function extractHttpRoutes(task: string): string[] {
  return unique(
    (task.match(/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) ?? []).map((route) =>
      route.replace(/[.,;:!?]+$/g, "")
    )
  );
}

export function extractTaskIdentifiers(task: string): string[] {
  const quoted = Array.from(task.matchAll(/[`"']([^`"']{2,80})[`"']/g), (match) => match[1]);
  const identifiers =
    task
      .match(/\b[A-Z][A-Za-z0-9]*\b|\b[a-z]+_[a-z0-9_]+\b/g)
      ?.filter((identifier) => !STOP_WORDS.has(identifier.toLowerCase())) ?? [];
  const lower = task
    .toLowerCase()
    .match(/\b[a-z][a-z0-9]{2,}\b/g)
    ?.filter((word) => !STOP_WORDS.has(word) && !/^\d+$/.test(word)) ?? [];

  return unique([...quoted, ...identifiers, ...lower, ...deriveRouteActionIdentifiers(task)]).slice(0, 12);
}

export async function resolveCbmProject(
  repoPath: string,
  cbmClient: Pick<PolicyCbmClient, "listProjects">
): Promise<ProjectResolution> {
  const repoReal = await safeRealpath(repoPath);
  const response = await cbmClient.listProjects();
  const projects = unwrapStructured<{ projects?: CbmProject[] }>(response.parsed)?.projects ?? [];
  const withRoots = await Promise.all(
    projects.map(async (project) => ({
      project,
      root: project.root_path ?? project.rootPath,
      realRoot: project.root_path || project.rootPath ? await safeRealpath(project.root_path ?? project.rootPath ?? "") : null
    }))
  );

  const exact = withRoots.filter((candidate) => candidate.realRoot === repoReal);
  if (exact.length === 1) {
    return { project: exact[0].project };
  }
  if (exact.length > 1) {
    return { project: null, reason: `ambiguous exact CBM projects for ${repoPath}` };
  }

  const base = basename(repoReal);
  const baseMatches = withRoots.filter((candidate) => candidate.root && basename(candidate.root) === base);
  if (baseMatches.length === 1) {
    return { project: baseMatches[0].project };
  }

  return {
    project: null,
    reason: baseMatches.length > 1 ? `ambiguous basename CBM projects for ${base}` : `no CBM project for ${repoPath}`
  };
}

export async function buildRelevantContext(
  task: string,
  repoPath: string,
  cbmClient: PolicyCbmClient,
  options: BuildRelevantContextOptions = {}
): Promise<RelevantContext | null> {
  const start = options.now?.() ?? performance.now();
  let queryCount = 0;
  const calls: Array<{ name: string; elapsedMs: number; transport?: string }> = [];

  try {
    let resolution = await timed(calls, "list_projects", () => resolveCbmProject(repoPath, cbmClient));
    if (!resolution.project && options.allowIndex && cbmClient.indexRepository) {
      await timed(calls, "index_repository", () => cbmClient.indexRepository!(repoPath));
      queryCount += 1;
      resolution = await timed(calls, "list_projects", () => resolveCbmProject(repoPath, cbmClient));
    }
    if (!resolution.project) {
      return null;
    }

    const project = resolution.project.name;
    const routes = extractHttpRoutes(task);
    const identifiers = extractTaskIdentifiers(task);
    const candidates: RelevantSymbol[] = [];
    const relationships: RelevantRelationship[] = [];

    for (const route of routes.slice(0, 1)) {
      queryCount += 1;
      const routeSearch = await timed(calls, "route search_graph", () => cbmClient.searchGraphByArgs({
        project,
        query: route,
        label: "Route",
        limit: 5
      }));
      candidates.push(...symbolsFromSearch(routeSearch.parsed, repoPath, task, 40));

      if (candidates.length === 0) {
        queryCount += 1;
        const routeCode = await timed(calls, "route search_code", () => cbmClient.searchCode(project, route));
        candidates.push(...symbolsFromSearch(routeCode.parsed, repoPath, task, 15));
      }
    }

    const symbolQuery = buildSymbolQuery(identifiers, routes);
    if (symbolQuery) {
      queryCount += 1;
      const symbolSearch = await timed(calls, "symbol search_graph", () => cbmClient.searchGraphByArgs({
        project,
        query: symbolQuery,
        limit: 12
      }));
      candidates.push(...symbolsFromSearch(symbolSearch.parsed, repoPath, task, 25));
    }

    const ranked = rankSymbols(dedupeSymbols(candidates), task, routes, identifiers);
    const traceTargets = ranked.slice(0, 2);
    const related: RelevantSymbol[] = [];
    for (const [index, target] of traceTargets.entries()) {
      queryCount += 1;
      const trace = await timed(calls, `trace_path #${index + 1}`, () => cbmClient.tracePath(project, target.qualifiedName));
      const traced = symbolsFromTrace(trace.parsed, repoPath);
      related.push(...traced.symbols);
      relationships.push(...traced.relationships);
    }

    const entryPoints = rankSymbols(dedupeSymbols([...ranked]), task, routes, identifiers).slice(
      0,
      LIMITS.entryPoints
    );
    const relatedSymbols = rankSymbols(dedupeSymbols(related), task, routes, identifiers)
      .filter((symbol) => !entryPoints.some((entry) => entry.qualifiedName === symbol.qualifiedName))
      .slice(0, LIMITS.relatedSymbols);
    const allSymbols = [...entryPoints, ...relatedSymbols];
    const files = unique(allSymbols.map((symbol) => symbol.filePath).filter(isString))
      .filter((path) => !isTestPath(path))
      .slice(0, LIMITS.files);
    const tests = unique(allSymbols.map((symbol) => symbol.filePath).filter(isString).filter(isTestPath)).slice(
      0,
      LIMITS.tests
    );
    const elapsedMs = Math.round((options.now?.() ?? performance.now()) - start);

    return {
      project,
      task,
      entryPoints,
      relatedSymbols,
      files,
      tests,
      relationships: relationships.slice(0, LIMITS.relationships),
      querySummary: {
        queryCount,
        elapsedMs,
        transport: cbmClient.transportKind,
        processStartCount: cbmClient.processStartCount,
        calls
      }
    };
  } catch {
    return null;
  }
}

async function timed<T>(
  calls: Array<{ name: string; elapsedMs: number; transport?: string }>,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  const result = await fn();
  const maybeTimed = result as { elapsedMs?: unknown; transport?: unknown };
  const elapsedMs =
    typeof maybeTimed.elapsedMs === "number" ? maybeTimed.elapsedMs : Math.round(performance.now() - startedAt);
  calls.push({
    name,
    elapsedMs,
    transport: typeof maybeTimed.transport === "string" ? maybeTimed.transport : undefined
  });
  return result;
}

export function buildExplorationGuidance(context: RelevantContext): string {
  const lines = ["[Sydes graph guidance]", "", "Start here:"];
  for (const symbol of context.entryPoints.slice(0, LIMITS.entryPoints)) {
    lines.push(`- ${symbol.filePath ?? "(unknown file)"} - ${symbol.name} (${symbol.kind})`);
  }

  if (context.tests.length > 0) {
    lines.push("", "Relevant tests:");
    for (const test of context.tests.slice(0, LIMITS.tests)) {
      lines.push(`- ${test}`);
    }
  }

  if (context.relationships.length > 0) {
    lines.push("", "Structural path:");
    for (const relationship of context.relationships.slice(0, 6)) {
      lines.push(`- ${shortName(relationship.from)} -> ${shortName(relationship.to)} (${relationship.type})`);
    }
  }

  lines.push("", "Treat this as navigation guidance and verify against source before editing.");
  return clampGuidance(lines.join("\n"));
}

export function normalizeRepoPath(repoPath: string, filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const absolute = filePath.startsWith("/") ? filePath : resolve(repoPath, filePath);
  const normalized = relative(resolve(repoPath), resolve(absolute)).split(/[\\/]+/).join("/");
  if (!normalized || normalized.startsWith("..") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

export function rankSymbols(
  symbols: RelevantSymbol[],
  task: string,
  routes: string[] = extractHttpRoutes(task),
  identifiers: string[] = extractTaskIdentifiers(task)
): RelevantSymbol[] {
  return symbols
    .map((symbol) => ({ ...symbol, score: scoreSymbol(symbol, task, routes, identifiers) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName));
}

export function boundContext(context: RelevantContext): RelevantContext {
  return {
    ...context,
    entryPoints: context.entryPoints.slice(0, LIMITS.entryPoints),
    relatedSymbols: context.relatedSymbols.slice(0, LIMITS.relatedSymbols),
    files: context.files.slice(0, LIMITS.files),
    tests: context.tests.slice(0, LIMITS.tests),
    relationships: context.relationships.slice(0, LIMITS.relationships)
  };
}

function buildSymbolQuery(identifiers: string[], routes: string[]): string {
  const routeTerms = routes.flatMap((route) => route.split("/")).filter(Boolean);
  return unique([...identifiers, ...routeTerms]).slice(0, 8).join(" ");
}

function deriveRouteActionIdentifiers(task: string): string[] {
  const method = task.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase();
  const route = extractHttpRoutes(task)[0];
  if (!method || !route) {
    return [];
  }

  const noun = route.split("/").filter(Boolean).at(-1);
  if (!noun) {
    return [];
  }

  const verbByMethod: Record<string, string> = {
    GET: "Get",
    POST: "Add",
    PUT: "Update",
    PATCH: "Update",
    DELETE: "Delete"
  };
  const verb = verbByMethod[method];
  if (!verb) {
    return [];
  }

  const pascalNoun = noun
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
  const pascal = `${verb}${pascalNoun}`;
  return [pascal, pascal[0].toLowerCase() + pascal.slice(1)];
}

function symbolsFromSearch(parsed: unknown, repoPath: string, task: string, baseScore: number): RelevantSymbol[] {
  const structured = unwrapStructured<SearchRows>(parsed);
  const rows = rowsFromSearch(structured ?? undefined);
  return rows.map((row) => {
    const qualifiedName = String(row.qn);
    return {
      name: shortName(qualifiedName),
      qualifiedName,
      kind: String(row.label || "Symbol"),
      filePath: normalizeRepoPath(repoPath, typeof row.file === "string" ? row.file : undefined),
      startLine: parseStartLine(row.lines),
      score: baseScore + scoreSymbolName(qualifiedName, task)
    };
  });
}

function symbolsFromTrace(parsed: unknown, repoPath: string): {
  symbols: RelevantSymbol[];
  relationships: RelevantRelationship[];
} {
  const trace = unwrapStructured<TraceRows>(parsed);
  if (!trace?.function) {
    return { symbols: [], relationships: [] };
  }

  const symbols: RelevantSymbol[] = [];
  const relationships: RelevantRelationship[] = [];
  for (const direction of ["callees", "callers"] as const) {
    const rows = rowsFromSearch(trace[direction]);
    for (const row of rows) {
      const qualifiedName = String(row.qn);
      symbols.push({
        name: shortName(qualifiedName),
        qualifiedName,
        kind: "Symbol",
        filePath: normalizeRepoPath(repoPath, typeof row.file === "string" ? row.file : undefined),
        startLine: parseStartLine(row.lines)
      });
      relationships.push({
        from: direction === "callees" ? trace.function : qualifiedName,
        to: direction === "callees" ? qualifiedName : trace.function,
        type: direction === "callees" ? "calls" : "called_by"
      });
    }
  }

  return { symbols, relationships };
}

function rowsFromSearch(search: SearchRows | undefined): Array<Record<string, unknown>> {
  if (!search) {
    return [];
  }
  if (search.rows && search.cols) {
    return search.rows.map((row) => Object.fromEntries(search.cols!.map((col, index) => [col, row[index]])));
  }
  if (search.groups && search.cols) {
    return search.groups.flatMap((group) =>
      (group.rows ?? []).map((row) => {
        const values = Object.fromEntries(search.cols!.map((col, index) => [col, row[index]]));
        if (group.qn_prefix && typeof values.name === "string") {
          values.qn = `${group.qn_prefix}.${values.name}`;
        }
        return values;
      })
    );
  }
  return [];
}

function scoreSymbol(
  symbol: RelevantSymbol,
  task: string,
  routes: string[],
  identifiers: string[]
): number {
  let score = symbol.score ?? 0;
  const haystack = `${symbol.qualifiedName} ${symbol.filePath ?? ""}`.toLowerCase();
  for (const identifier of identifiers) {
    if (haystack.includes(identifier.toLowerCase())) {
      score += /^[A-Z]/.test(identifier) ? 25 : 10;
    }
  }
  for (const route of routes) {
    const routeTail = route.split("/").filter(Boolean).at(-1);
    if (routeTail && haystack.includes(routeTail.toLowerCase())) {
      score += 20;
    }
  }
  if (isTestPath(symbol.filePath)) {
    score -= 20;
  }
  if (/handler|route|controller/.test(haystack)) {
    score += 30;
  }
  if (routes.length > 0 && /handler|route|controller/.test(haystack)) {
    score += 30;
  }
  if (task.toLowerCase().includes("test") && isTestPath(symbol.filePath)) {
    score += 6;
  }
  return score;
}

function scoreSymbolName(qualifiedName: string, task: string): number {
  return task.toLowerCase().includes(shortName(qualifiedName).toLowerCase()) ? 20 : 0;
}

function parseStartLine(lines: unknown): number | undefined {
  const match = String(lines ?? "").match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

function shortName(qualifiedName: string): string {
  return qualifiedName.split(".").at(-1) ?? qualifiedName;
}

function dedupeSymbols(symbols: RelevantSymbol[]): RelevantSymbol[] {
  const seen = new Map<string, RelevantSymbol>();
  for (const symbol of symbols) {
    if (!seen.has(symbol.qualifiedName)) {
      seen.set(symbol.qualifiedName, symbol);
    }
  }
  return [...seen.values()];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTestPath(path: string | undefined): boolean {
  return !!path && /(^|\/)(test|tests|__tests__|.*_test\.)/.test(path);
}

function unwrapStructured<T>(value: unknown): T | null {
  const envelope = value as CbmEnvelope<T> | T | null;
  if (envelope && typeof envelope === "object" && "structuredContent" in envelope) {
    return (envelope as CbmEnvelope<T>).structuredContent ?? null;
  }
  return (value as T) ?? null;
}

function clampGuidance(guidance: string): string {
  if (guidance.length <= LIMITS.guidanceChars) {
    return guidance;
  }
  return `${guidance.slice(0, LIMITS.guidanceChars - 32).trimEnd()}\n...`;
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
