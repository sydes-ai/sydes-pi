import { loadConfig } from "../config.js";
import { CliCbmTransport, createDefaultTransport } from "./transport.js";
import type { CbmArgs, CbmClientOptions, CbmCommandResult, CbmTransport } from "./types.js";

export class CbmClient {
  readonly bin: string;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly transport: CbmTransport;
  private listProjectsCache: Promise<CbmCommandResult> | null = null;

  constructor(options: CbmClientOptions = {}) {
    const config = loadConfig(options.env);
    this.bin = options.bin ?? config.codebaseMemoryBin;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.transport =
      options.transport ??
      (options.preferPersistent === false
        ? new CliCbmTransport(options)
        : createDefaultTransport(options));
  }

  run<T = unknown>(tool: string, args: CbmArgs = {}): Promise<CbmCommandResult<T>> {
    return this.transport.callTool<T>(tool, args);
  }

  listProjects(): Promise<CbmCommandResult> {
    if (!this.listProjectsCache) {
      this.listProjectsCache = this.run("list_projects");
    }
    return this.listProjectsCache;
  }

  indexRepository(repoPath: string, name?: string): Promise<CbmCommandResult> {
    this.listProjectsCache = null;
    return this.run("index_repository", {
      "repo-path": repoPath,
      name,
      mode: "fast"
    });
  }

  indexStatus(project: string, verbose = true): Promise<CbmCommandResult> {
    return this.run("index_status", {
      project,
      verbose
    });
  }

  searchGraph(project: string, query: string): Promise<CbmCommandResult> {
    return this.run("search_graph", {
      project,
      query,
      format: "json"
    });
  }

  searchGraphByArgs(args: CbmArgs): Promise<CbmCommandResult> {
    return this.run("search_graph", {
      ...args,
      format: args.format ?? "json"
    });
  }

  searchCode(project: string, pattern: string): Promise<CbmCommandResult> {
    return this.run("search_code", {
      project,
      pattern,
      mode: "compact",
      limit: 10
    });
  }

  tracePath(project: string, functionName: string): Promise<CbmCommandResult> {
    return this.run("trace_path", {
      project,
      "function-name": functionName,
      direction: "both",
      depth: 2,
      "include-tests": true,
      format: "json",
      limit: 20
    });
  }

  detectChanges(project: string): Promise<CbmCommandResult> {
    return this.run("detect_changes", {
      project,
      scope: "impact",
      direction: "both",
      depth: 2,
      limit: 30,
      format: "json"
    });
  }

  close(): Promise<void> | void {
    this.listProjectsCache = null;
    return this.transport.close();
  }

  async warmup(): Promise<void> {
    await this.listProjects();
  }

  get transportKind(): string {
    if ("activeKind" in this.transport && typeof this.transport.activeKind === "string") {
      return this.transport.activeKind;
    }
    return this.transport.kind;
  }

  get processStartCount(): number {
    return this.transport.processStartCount;
  }
}

export function serializeArgs(args: CbmArgs): string[] {
  const serialized: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) {
      continue;
    }

    const flag = `--${key}`;
    if (Array.isArray(value)) {
      serialized.push(flag, JSON.stringify(value));
      continue;
    }

    if (typeof value === "boolean") {
      if (value) {
        serialized.push(flag);
      }
      continue;
    }

    serialized.push(flag, String(value));
  }

  return serialized;
}
