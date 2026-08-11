import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type {
  AffectedContext,
  AffectedRelationship,
  AffectedRoute,
  AffectedSymbol,
  GitDiffProvider,
  GitDiffResult,
  PolicyCbmClient
} from "./types.js";
import { resolveCbmProject } from "./exploration.js";

const execFileAsync = promisify(execFile);

const LIMITS = {
  changedSymbols: 10,
  impactedSymbols: 20,
  routes: 10,
  tests: 10,
  relationships: 30,
  guidanceChars: 1500
};

interface CbmEnvelope<T> {
  structuredContent?: T;
}

interface DetectChangesResult {
  changed_files?: string[];
  impacted?: Array<{
    qn?: string;
    label?: string;
    file?: string;
    hop?: number;
  }>;
  risk?: string | number;
}

export const gitDiffProvider: GitDiffProvider = {
  async getCurrentDiff(repoPath: string): Promise<GitDiffResult | null> {
    try {
      const diff = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=0"], {
        cwd: repoPath,
        maxBuffer: 5_000_000
      });
      const names = await execFileAsync("git", ["diff", "--no-ext-diff", "--name-only"], {
        cwd: repoPath,
        maxBuffer: 1_000_000
      });
      const diffText = diff.stdout.trim();
      const changedFiles = names.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((path) => normalizeRepoPath(repoPath, path))
        .filter(isString);
      if (!diffText || changedFiles.length === 0) {
        return null;
      }
      return { changedFiles, diffText };
    } catch {
      return null;
    }
  }
};

export async function buildAffectedContext(
  repoPath: string,
  cbmClient: PolicyCbmClient,
  diffProvider: GitDiffProvider = gitDiffProvider
): Promise<AffectedContext | null> {
  const startedAt = performance.now();
  try {
    const diff = await diffProvider.getCurrentDiff(repoPath);
    if (!diff) {
      return null;
    }

    const resolution = await resolveCbmProject(repoPath, cbmClient);
    if (!resolution.project) {
      return null;
    }

    const detect = await cbmClient.detectChanges(resolution.project.name);
    const parsed = unwrapStructured<DetectChangesResult>(detect.parsed);
    if (!parsed) {
      return null;
    }

    const changedFiles = unique(
      (parsed.changed_files ?? diff.changedFiles).map((path) => normalizeRepoPath(repoPath, path)).filter(isString)
    );
    const impacted = parsed.impacted ?? [];
    const routes = impacted
      .filter((item) => item.label === "Route" || item.qn?.startsWith("__route__"))
      .map((item) => routeFromImpact(item))
      .slice(0, LIMITS.routes);
    const impactedSymbols = impacted
      .filter((item) => item.label !== "Route" && !item.qn?.startsWith("__route__"))
      .map((item) => symbolFromImpact(repoPath, item))
      .filter((symbol): symbol is AffectedSymbol => !!symbol)
      .sort(rankAffectedSymbol)
      .slice(0, LIMITS.impactedSymbols);
    const tests = unique([...changedFiles, ...impactedSymbols.map((symbol) => symbol.filePath).filter(isString)])
      .filter(isTestPath)
      .slice(0, LIMITS.tests);
    const changedSymbols: AffectedSymbol[] = [];
    const relationships: AffectedRelationship[] = [];
    const elapsedMs = Math.round(performance.now() - startedAt);

    const context: AffectedContext = {
      project: resolution.project.name,
      changedFiles: changedFiles.slice(0, 20),
      changedSymbols: changedSymbols.slice(0, LIMITS.changedSymbols),
      impactedSymbols,
      routes,
      tests,
      relationships: relationships.slice(0, LIMITS.relationships),
      risk: parsed.risk,
      signature: "",
      querySummary: {
        queryCount: 1,
        elapsedMs,
        detectChangesElapsedMs: detect.elapsedMs,
        transport: cbmClient.transportKind,
        processStartCount: cbmClient.processStartCount
      }
    };
    context.signature = signatureForAffectedContext(context);
    return context;
  } catch {
    return null;
  }
}

export function buildImpactGuidance(context: AffectedContext): string {
  const lines = ["[Sydes impact guidance]", "", "Changed:"];
  for (const file of context.changedFiles.slice(0, 8)) {
    lines.push(`- ${file}`);
  }

  if (context.routes.length > 0 || context.impactedSymbols.length > 0) {
    lines.push("", "Potentially affected:");
    for (const route of context.routes.slice(0, 5)) {
      lines.push(`- ${route.method ? `${route.method} ` : ""}${route.path}`);
    }
    for (const symbol of context.impactedSymbols.slice(0, 8)) {
      lines.push(`- ${symbol.filePath ?? "(unknown file)"} - ${symbol.name} (${symbol.kind})`);
    }
  }

  lines.push("", "Verify:");
  if (context.tests.length > 0) {
    for (const test of context.tests.slice(0, LIMITS.tests)) {
      lines.push(`- ${test}`);
    }
  } else {
    lines.push("- No graph-linked tests were found.");
  }

  lines.push("", "Re-read affected code and run the relevant tests before finishing.");
  lines.push("Treat this as structural impact guidance, not proof of correctness.");
  return clamp(lines.join("\n"));
}

export function signatureForAffectedContext(context: Pick<AffectedContext, "changedFiles" | "changedSymbols" | "impactedSymbols" | "tests" | "routes">): string {
  const payload = {
    changedFiles: [...context.changedFiles].sort(),
    changedSymbols: context.changedSymbols.map((symbol) => symbol.qualifiedName).sort(),
    impactedSymbols: context.impactedSymbols.map((symbol) => symbol.qualifiedName).sort(),
    tests: [...context.tests].sort(),
    routes: context.routes.map((route) => `${route.method ?? ""} ${route.path}`).sort()
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

export function boundAffectedContext(context: AffectedContext): AffectedContext {
  const bounded = {
    ...context,
    changedSymbols: context.changedSymbols.slice(0, LIMITS.changedSymbols),
    impactedSymbols: context.impactedSymbols.slice(0, LIMITS.impactedSymbols),
    routes: context.routes.slice(0, LIMITS.routes),
    tests: context.tests.slice(0, LIMITS.tests),
    relationships: context.relationships.slice(0, LIMITS.relationships)
  };
  return { ...bounded, signature: signatureForAffectedContext(bounded) };
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

function symbolFromImpact(
  repoPath: string,
  item: NonNullable<DetectChangesResult["impacted"]>[number]
): AffectedSymbol | null {
  if (!item.qn) {
    return null;
  }
  return {
    name: shortName(item.qn),
    qualifiedName: item.qn,
    kind: item.label ?? "Symbol",
    filePath: normalizeRepoPath(repoPath, item.file),
    hop: item.hop
  };
}

function routeFromImpact(item: NonNullable<DetectChangesResult["impacted"]>[number]): AffectedRoute {
  const qn = item.qn ?? "";
  const match = qn.match(/^__route__(GET|POST|PUT|PATCH|DELETE)?__(.+)$/);
  return {
    method: match?.[1],
    path: match?.[2] ?? qn,
    filePath: item.file || undefined,
    hop: item.hop
  };
}

function rankAffectedSymbol(a: AffectedSymbol, b: AffectedSymbol): number {
  const hop = (a.hop ?? 99) - (b.hop ?? 99);
  if (hop !== 0) {
    return hop;
  }
  const testPenalty = Number(isTestPath(a.filePath)) - Number(isTestPath(b.filePath));
  if (testPenalty !== 0) {
    return testPenalty;
  }
  return a.qualifiedName.localeCompare(b.qualifiedName);
}

function unwrapStructured<T>(value: unknown): T | null {
  const envelope = value as CbmEnvelope<T> | T | null;
  if (envelope && typeof envelope === "object" && "structuredContent" in envelope) {
    return (envelope as CbmEnvelope<T>).structuredContent ?? null;
  }
  return (value as T) ?? null;
}

function shortName(qualifiedName: string): string {
  return qualifiedName.split(".").at(-1) ?? qualifiedName;
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

function clamp(guidance: string): string {
  if (guidance.length <= LIMITS.guidanceChars) {
    return guidance;
  }
  return `${guidance.slice(0, LIMITS.guidanceChars - 32).trimEnd()}\n...`;
}
