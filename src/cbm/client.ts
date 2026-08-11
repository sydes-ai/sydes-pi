import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import type { CbmArgs, CbmClientOptions, CbmCommandResult } from "./types.js";

export class CbmClient {
  readonly bin: string;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(options: CbmClientOptions = {}) {
    const config = loadConfig(options.env);
    this.bin = options.bin ?? config.codebaseMemoryBin;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
  }

  run<T = unknown>(tool: string, args: CbmArgs = {}): Promise<CbmCommandResult<T>> {
    const cliArgs = ["cli", "--json", tool, ...serializeArgs(args)];

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, cliArgs, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Codebase Memory command failed (${code}): ${stderr || stdout}`));
          return;
        }

        resolve({
          command: tool,
          args: cliArgs,
          stdout,
          stderr,
          parsed: parseJson<T>(stdout)
        });
      });
    });
  }

  listProjects(): Promise<CbmCommandResult> {
    return this.run("list_projects");
  }

  indexRepository(repoPath: string, name?: string): Promise<CbmCommandResult> {
    return this.run("index_repository", {
      "repo-path": repoPath,
      name
    });
  }

  searchGraph(project: string, query: string): Promise<CbmCommandResult> {
    return this.run("search_graph", {
      project,
      query,
      format: "json"
    });
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

function parseJson<T>(value: string): T | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed[index] !== "{") {
      continue;
    }

    try {
      return JSON.parse(trimmed.slice(index)) as T;
    } catch {
      continue;
    }
  }

  return null;
}
