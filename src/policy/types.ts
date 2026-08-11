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
}

export interface BuildRelevantContextOptions {
  allowIndex?: boolean;
  now?: () => number;
}

export interface ProjectResolution {
  project: CbmProject | null;
  reason?: string;
}
