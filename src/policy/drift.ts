import { createHash } from "node:crypto";
import type {
  AffectedContext,
  ChangeSurfaceDrift,
  ChangedSymbol,
  PolicyCbmClient,
  RelevantContext,
  SourceSymbolRange
} from "./types.js";
import { canonicalRepoRelativePath } from "./paths.js";

const LIMITS = {
  warningChars: 1200
};

interface ParsedFileDiff {
  oldPath: string;
  newPath: string;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  changes: HunkChange[];
}

interface CbmEnvelope<T> {
  structuredContent?: T;
}

interface SearchRows {
  cols?: string[];
  rows?: unknown[][];
}

interface HunkChange {
  kind: "add" | "delete";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export function analyzeChangeSurfaceDrift(input: {
  relevantContext: RelevantContext | null;
  affectedContext?: AffectedContext | null;
  diffText: string;
  sourceSymbols?: SourceSymbolRange[];
  preEditSymbols?: SourceSymbolRange[];
  postEditSymbols?: SourceSymbolRange[];
}): ChangeSurfaceDrift {
  const relevant = input.relevantContext;
  const files = parseUnifiedDiff(input.diffText);
  const changedFiles = unique(files.map((file) => file.newPath));
  const expectedFiles = expectedEditFiles(relevant);
  const expectedSymbolNames = expectedEditSymbolNames(relevant);
  const fallbackSymbols = input.sourceSymbols ?? symbolsFromRelevantContext(relevant);
  const preEditSymbols = input.preEditSymbols ?? fallbackSymbols;
  const postEditSymbols = input.postEditSymbols ?? fallbackSymbols;
  const symbolChanges = collectChangedSymbols(files, { preEditSymbols, postEditSymbols });
  const expectedChangedSymbols = symbolChanges.filter((symbol) =>
    isExpectedSymbol(symbol, expectedSymbolNames, expectedFiles)
  );
  const unexpectedChangedSymbols = symbolChanges.filter(
    (symbol) => !isExpectedSymbol(symbol, expectedSymbolNames, expectedFiles)
  );
  const unexpectedFiles = changedFiles.filter((file) => !expectedFiles.includes(file));
  const insertionCount = files.flatMap((file) => file.hunks).flatMap((hunk) => hunk.changes).filter((change) => change.kind === "add").length;
  const deletionCount = files.flatMap((file) => file.hunks).flatMap((hunk) => hunk.changes).filter((change) => change.kind === "delete").length;
  const unrelatedDeletions = unexpectedChangedSymbols.filter((symbol) => symbol.deletions > 0);
  const unrelatedModifiedRanges = unexpectedChangedSymbols.filter((symbol) => symbol.insertions > 0 || symbol.deletions > 0);
  const reasons = driftReasons({
    unexpectedFiles,
    unexpectedChangedSymbols,
    unrelatedDeletions,
    insertionCount,
    deletionCount
  });
  const severity = driftSeverity({
    unexpectedFiles,
    unexpectedChangedSymbols,
    unrelatedDeletions,
    deletionCount
  });
  const drift: ChangeSurfaceDrift = {
    changedFiles,
    expectedFiles,
    unexpectedFiles,
    expectedChangedSymbols,
    unexpectedChangedSymbols,
    unrelatedDeletions,
    unrelatedModifiedRanges,
    insertionCount,
    deletionCount,
    severity,
    reasons,
    signature: ""
  };
  drift.signature = signatureForDrift(drift);
  return drift;
}

export function buildChangeSurfaceGuidance(drift: ChangeSurfaceDrift): string {
  const lines = ["[Sydes change-surface warning]", "", "The current diff extends beyond the task-relevant change surface."];
  if (drift.expectedChangedSymbols.length > 0) {
    lines.push("", "Task-relevant edits:");
    for (const symbol of uniqueSymbols(drift.expectedChangedSymbols).slice(0, 6)) {
      lines.push(`- ${symbol.filePath} - ${symbol.name}`);
    }
  } else if (drift.expectedFiles.length > 0) {
    lines.push("", "Task-relevant files:");
    for (const file of drift.expectedFiles.slice(0, 6)) {
      lines.push(`- ${file}`);
    }
  }
  if (drift.unexpectedChangedSymbols.length > 0) {
    lines.push("", "Unexpected modified/removed symbols:");
    for (const symbol of uniqueSymbols(drift.unexpectedChangedSymbols).slice(0, 8)) {
      lines.push(`- ${symbol.filePath} - ${symbol.name}`);
    }
  }
  if (drift.unexpectedFiles.length > 0) {
    lines.push("", "Unexpected files:");
    for (const file of drift.unexpectedFiles.slice(0, 5)) {
      lines.push(`- ${file}`);
    }
  }
  lines.push("", "Review the diff and restore unrelated changes before finishing.");
  lines.push("This is structural drift detection, not proof that the changes are incorrect.");
  return clamp(lines.join("\n"));
}

export function shouldInjectDriftWarning(
  drift: ChangeSurfaceDrift,
  lastSignature: string | null
): boolean {
  return (drift.severity === "medium" || drift.severity === "high") && drift.signature !== lastSignature;
}

export function parseUnifiedDiff(diffText: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | null = null;
  let hunk: ParsedHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diffText.split("\n")) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      current = { oldPath: diffMatch[1], newPath: diffMatch[2], hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/);
    if (hunkMatch && current) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? 1),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? 1),
        header: hunkMatch[5] ?? "",
        changes: []
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk || line.startsWith("\\ No newline")) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunk.changes.push({ kind: "add", newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      hunk.changes.push({ kind: "delete", oldLine, text: line.slice(1) });
      oldLine += 1;
    } else {
      oldLine += 1;
      newLine += 1;
    }
  }
  return files;
}

export async function loadSourceSymbolsForDiff(
  project: string,
  repoRoot: string,
  cbmClient: Pick<PolicyCbmClient, "searchGraphByArgs">,
  diffText: string,
  relevantContext: RelevantContext | null = null
): Promise<SourceSymbolRange[]> {
  const names = unique([
    ...parseUnifiedDiff(diffText).flatMap((file) =>
      file.hunks.flatMap((hunk) => [
        symbolNameFromHunk(hunk),
        ...hunk.changes.map((change) => symbolNameFromLine(change.text))
      ])
    ),
    ...(relevantContext?.entryPoints ?? []).map((symbol) => symbol.name)
  ].filter(isString)).slice(0, 24);
  if (names.length === 0) {
    return [];
  }
  try {
    const response = await cbmClient.searchGraphByArgs({
      project,
      query: names.join(" "),
      limit: 80
    });
    const rows = rowsFromSearch(unwrapStructured<SearchRows>(response.parsed));
    const symbols: Array<SourceSymbolRange | null> = rows.map((row) => {
        const qn = String(row.qn ?? "");
        const filePath = canonicalRepoRelativePath(repoRoot, typeof row.file === "string" ? row.file : undefined);
        if (!qn || !filePath) {
          return null;
        }
        const [startLine, endLine] = parseLines(row.lines);
        return {
          name: shortName(qn),
          qualifiedName: qn,
          kind: String(row.label ?? "Symbol"),
          filePath,
          startLine,
          endLine
        };
      });
    return symbols.filter((symbol): symbol is SourceSymbolRange => !!symbol);
  } catch {
    return [];
  }
}

function collectChangedSymbols(
  files: ParsedFileDiff[],
  symbols: { preEditSymbols: SourceSymbolRange[]; postEditSymbols: SourceSymbolRange[] }
): ChangedSymbol[] {
  const byKey = new Map<string, ChangedSymbol>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        const line = change.kind === "delete" ? change.oldLine : change.newLine;
        const lookup = change.kind === "delete" ? symbols.preEditSymbols : symbols.postEditSymbols;
        const symbol = line ? findContainingSymbol(file.newPath, line, lookup) : null;
        const name = symbol?.name ?? symbolNameFromLine(change.text) ?? "(file scope)";
        const qualifiedName = symbol?.qualifiedName;
        const key = `${file.newPath}:${qualifiedName ?? name}`;
        const current = byKey.get(key) ?? {
          name,
          qualifiedName,
          kind: symbol?.kind,
          filePath: file.newPath,
          changeKinds: [],
          insertions: 0,
          deletions: 0
        };
        current.changeKinds = unique([...current.changeKinds, change.kind]);
        if (change.kind === "add") current.insertions += 1;
        if (change.kind === "delete") current.deletions += 1;
        byKey.set(key, current);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name));
}

function rowsFromSearch(search: SearchRows | null): Array<Record<string, unknown>> {
  if (!search?.rows || !search.cols) {
    return [];
  }
  return search.rows.map((row) => Object.fromEntries(search.cols!.map((col, index) => [col, row[index]])));
}

function unwrapStructured<T>(value: unknown): T | null {
  const envelope = value as CbmEnvelope<T> | T | null;
  if (envelope && typeof envelope === "object" && "structuredContent" in envelope) {
    return (envelope as CbmEnvelope<T>).structuredContent ?? null;
  }
  return (value as T) ?? null;
}

function parseLines(value: unknown): [number | undefined, number | undefined] {
  const match = String(value ?? "").match(/(\d+)(?:-(\d+))?/);
  if (!match) {
    return [undefined, undefined];
  }
  return [Number(match[1]), match[2] ? Number(match[2]) : Number(match[1])];
}

function expectedEditFiles(context: RelevantContext | null): string[] {
  if (!context) {
    return [];
  }
  const entryFiles = context.entryPoints.map((symbol) => symbol.filePath).filter(isString);
  const testEntryFiles = context.entryPoints
    .filter((symbol) => isTestPath(symbol.filePath))
    .map((symbol) => symbol.filePath)
    .filter(isString);
  return unique([...entryFiles, ...testEntryFiles]);
}

function expectedEditSymbolNames(context: RelevantContext | null): Set<string> {
  const names = new Set<string>();
  for (const symbol of context?.entryPoints ?? []) {
    names.add(symbol.name);
    names.add(shortName(symbol.qualifiedName));
  }
  return names;
}

function symbolsFromRelevantContext(context: RelevantContext | null): SourceSymbolRange[] {
  return [
    ...(context?.entryPoints ?? []),
    ...(context?.relatedSymbols ?? [])
  ]
    .filter((symbol) => symbol.filePath)
    .map((symbol) => ({
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: symbol.kind,
      filePath: symbol.filePath!,
      startLine: symbol.startLine
    }));
}

function isExpectedSymbol(symbol: ChangedSymbol, expectedNames: Set<string>, expectedFiles: string[]): boolean {
  if (!expectedFiles.includes(symbol.filePath)) {
    return false;
  }
  if (expectedNames.has(symbol.name) || (symbol.qualifiedName && expectedNames.has(shortName(symbol.qualifiedName)))) {
    return true;
  }
  for (const expected of expectedNames) {
    if (expected && symbol.name.includes(expected)) {
      return true;
    }
    if (expected && expected.includes(symbol.name)) {
      return true;
    }
  }
  return symbol.name === "(file scope)";
}

function findContainingSymbol(filePath: string, line: number, symbols: SourceSymbolRange[]): SourceSymbolRange | null {
  return (
    symbols
      .filter((symbol) => symbol.filePath === filePath && typeof symbol.startLine === "number")
      .filter((symbol) => line >= (symbol.startLine ?? 0) && (!symbol.endLine || line <= symbol.endLine))
      .sort((a, b) => (b.startLine ?? 0) - (a.startLine ?? 0))[0] ?? null
  );
}

function symbolNameFromHunk(hunk: ParsedHunk): string | undefined {
  return symbolNameFromLine(hunk.header);
}

function symbolNameFromLine(line: string): string | undefined {
  const goFunc = line.match(/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (goFunc) {
    return goFunc[1];
  }
  const jsFunc = line.match(/\b(?:function|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  return jsFunc?.[1];
}

function driftSeverity(input: {
  unexpectedFiles: string[];
  unexpectedChangedSymbols: ChangedSymbol[];
  unrelatedDeletions: ChangedSymbol[];
  deletionCount: number;
}): ChangeSurfaceDrift["severity"] {
  if (input.unexpectedFiles.length === 0 && input.unexpectedChangedSymbols.length === 0) {
    return "none";
  }
  if (input.unrelatedDeletions.length >= 3 || (input.unrelatedDeletions.length > 0 && input.deletionCount >= 20)) {
    return "high";
  }
  if (input.unrelatedDeletions.length > 0 || input.unexpectedChangedSymbols.length > 0 || input.unexpectedFiles.length > 0) {
    return "medium";
  }
  return "low";
}

function driftReasons(input: {
  unexpectedFiles: string[];
  unexpectedChangedSymbols: ChangedSymbol[];
  unrelatedDeletions: ChangedSymbol[];
  insertionCount: number;
  deletionCount: number;
}): string[] {
  const reasons: string[] = [];
  if (input.unexpectedFiles.length > 0) {
    reasons.push(`changed ${input.unexpectedFiles.length} file(s) outside expected edit surface`);
  }
  if (input.unexpectedChangedSymbols.length > 0) {
    reasons.push(`modified ${input.unexpectedChangedSymbols.length} unexpected symbol(s)`);
  }
  if (input.unrelatedDeletions.length > 0) {
    reasons.push(`deleted lines inside ${input.unrelatedDeletions.length} unexpected symbol(s)`);
  }
  if (input.deletionCount >= 20 && input.unrelatedDeletions.length > 0) {
    reasons.push(`large deletion count with unrelated symbol changes (${input.deletionCount} deletions)`);
  }
  return reasons;
}

function signatureForDrift(drift: Omit<ChangeSurfaceDrift, "signature">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        severity: drift.severity,
        changedFiles: drift.changedFiles,
        unexpectedFiles: drift.unexpectedFiles,
        unexpectedChangedSymbols: drift.unexpectedChangedSymbols.map((symbol) => [
          symbol.filePath,
          symbol.name,
          symbol.insertions,
          symbol.deletions
        ])
      })
    )
    .digest("hex")
    .slice(0, 16);
}

function clamp(text: string): string {
  if (text.length <= LIMITS.warningChars) {
    return text;
  }
  return `${text.slice(0, LIMITS.warningChars - 32).trimEnd()}\n...`;
}

function isTestPath(path: string | undefined): boolean {
  return !!path && /(^|\/)(test|tests|__tests__|.*_test\.)/.test(path);
}

function shortName(qualifiedName: string): string {
  return qualifiedName.split(".").at(-1) ?? qualifiedName;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueSymbols(symbols: ChangedSymbol[]): ChangedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath}:${symbol.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
