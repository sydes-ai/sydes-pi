export interface RelevantSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath?: string;
  startLine?: number;
  score?: number;
}

export interface RelevantRelationship {
  from: string;
  to: string;
  type: string;
}

export interface RelevantContext {
  project: string;
  task: string;
  projectIndexedThisSession?: boolean;
  projectEnsureElapsedMs?: number;
  entryPoints: RelevantSymbol[];
  relatedSymbols: RelevantSymbol[];
  files: string[];
  tests: string[];
  relationships: RelevantRelationship[];
  querySummary: {
    queryCount: number;
    elapsedMs: number;
    transport?: string;
    processStartCount?: number;
    calls?: RelevantQueryTiming[];
  };
}

export interface RelevantQueryTiming {
  name: string;
  elapsedMs: number;
  transport?: string;
}

export interface CbmProject {
  name: string;
  root_path?: string;
  rootPath?: string;
}

export interface PolicyCbmClient {
  readonly transportKind?: string;
  readonly processStartCount?: number;
  listProjects(): Promise<{ parsed: unknown }>;
  indexRepository?(repoPath: string, name?: string): Promise<{ parsed: unknown }>;
  searchGraphByArgs(args: Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>): Promise<{ parsed: unknown }>;
  searchCode(project: string, pattern: string): Promise<{ parsed: unknown }>;
  tracePath(project: string, functionName: string): Promise<{ parsed: unknown }>;
  detectChanges(project: string): Promise<{ parsed: unknown; elapsedMs?: number; transport?: string }>;
}

export interface ProjectEnsureCacheEntry {
  repoRoot: string;
  project: CbmProject | null;
  indexedThisSession: boolean;
  ensureElapsedMs: number;
  reason?: string;
}

export interface ProjectEnsureOptions {
  allowIndex?: boolean;
  cache?: Map<string, ProjectEnsureCacheEntry>;
  now?: () => number;
  resolveRepoRoot?: (repoPath: string) => Promise<string>;
}

export interface BuildRelevantContextOptions {
  allowIndex?: boolean;
  projectCache?: Map<string, ProjectEnsureCacheEntry>;
  now?: () => number;
  resolveRepoRoot?: (repoPath: string) => Promise<string>;
}

export interface ProjectResolution {
  project: CbmProject | null;
  reason?: string;
  repoRoot?: string;
  indexedThisSession?: boolean;
  ensureElapsedMs?: number;
}

export interface AffectedSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath?: string;
  hop?: number;
}

export interface AffectedRoute {
  method?: string;
  path: string;
  filePath?: string;
  hop?: number;
}

export interface AffectedRelationship {
  from: string;
  to: string;
  type: string;
}

export interface AffectedContext {
  project: string;
  projectIndexedThisSession?: boolean;
  projectEnsureElapsedMs?: number;
  changedFiles: string[];
  changedSymbols: AffectedSymbol[];
  impactedSymbols: AffectedSymbol[];
  routes: AffectedRoute[];
  tests: string[];
  relationships: AffectedRelationship[];
  risk?: string | number;
  signature: string;
  querySummary: {
    queryCount: number;
    elapsedMs: number;
    detectChangesElapsedMs?: number;
    transport?: string;
    processStartCount?: number;
  };
}

export interface GitDiffResult {
  changedFiles: string[];
  diffText: string;
}

export interface GitDiffProvider {
  getCurrentDiff(repoPath: string): Promise<GitDiffResult | null>;
}
