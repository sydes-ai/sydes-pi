import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../config.js";
import type { CbmArgs, CbmCommandResult, CbmTransport } from "./types.js";

export type SpawnCbmProcess = (
  bin: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv }
) => CbmChildProcess;

type CbmChildProcess = ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export interface CbmTransportOptions {
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: SpawnCbmProcess;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

export class CliCbmTransport implements CbmTransport {
  readonly kind = "cli";
  readonly bin: string;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestTimeoutMs: number;
  private readonly spawnProcess: SpawnCbmProcess;
  private starts = 0;

  constructor(options: CbmTransportOptions = {}) {
    const config = loadConfig(options.env);
    this.bin = options.bin ?? config.codebaseMemoryBin;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.spawnProcess =
      options.spawnProcess ??
      ((bin, args, opts) =>
        spawn(bin, [...args], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe"]
        }) as CbmChildProcess);
  }

  get processStartCount(): number {
    return this.starts;
  }

  callTool<T = unknown>(tool: string, args: CbmArgs = {}): Promise<CbmCommandResult<T>> {
    const startedAt = performance.now();
    const cliArgs = ["cli", "--json", tool, ...serializeArgs(args)];
    this.starts += 1;

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.bin, cliArgs, { cwd: this.cwd, env: this.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Codebase Memory CLI command timed out: ${tool}`));
      }, this.requestTimeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Codebase Memory command failed (${code}): ${stderr || stdout}`));
          return;
        }

        resolve({
          command: tool,
          args: cliArgs,
          stdout,
          stderr,
          parsed: parseJson<T>(stdout),
          elapsedMs: Math.round(performance.now() - startedAt),
          transport: this.kind
        });
      });
    });
  }

  close(): void {
    // One-shot CLI transport has no persistent resources.
  }
}

export class PersistentCbmTransport implements CbmTransport {
  readonly kind = "persistent";
  readonly bin: string;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestTimeoutMs: number;
  private readonly spawnProcess: SpawnCbmProcess;
  private child: CbmChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initializing: Promise<void> | null = null;
  private initialized = false;
  private starts = 0;
  private stderrTail = "";

  constructor(options: CbmTransportOptions = {}) {
    const config = loadConfig(options.env);
    this.bin = options.bin ?? config.codebaseMemoryBin;
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.spawnProcess =
      options.spawnProcess ??
      ((bin, args, opts) =>
        spawn(bin, [...args], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["pipe", "pipe", "pipe"]
        }) as CbmChildProcess);
  }

  get processStartCount(): number {
    return this.starts;
  }

  async callTool<T = unknown>(tool: string, args: CbmArgs = {}): Promise<CbmCommandResult<T>> {
    await this.ensureInitialized();
    const startedAt = performance.now();
    const response = await this.request("tools/call", { name: tool, arguments: toMcpArgs(args) });
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (response.error) {
      throw new Error(`Codebase Memory MCP error: ${response.error.message ?? "unknown error"}`);
    }

    return {
      command: tool,
      args: [tool, JSON.stringify(args)],
      stdout: JSON.stringify(response.result ?? {}),
      stderr: this.stderrTail,
      parsed: response.result as T,
      elapsedMs,
      transport: this.kind
    };
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codebase Memory process closed before response ${id}`));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = null;
    this.initialized = false;
    this.initializing = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initializing) {
      this.initializing = this.initialize();
    }
    await this.initializing;
  }

  private async initialize(): Promise<void> {
    this.startProcess();
    const response = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sydes-pi", version: "0.1.0" }
    });
    if (response.error) {
      throw new Error(`Codebase Memory initialize failed: ${response.error.message ?? "unknown error"}`);
    }
    this.sendNotification("notifications/initialized", {});
    this.initialized = true;
  }

  private startProcess(): void {
    if (this.child) {
      return;
    }
    this.starts += 1;
    this.child = this.spawnProcess(this.bin, [], { cwd: this.cwd, env: this.env });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`Codebase Memory process exited: ${code ?? signal ?? "unknown"}`));
      this.child = null;
      this.initialized = false;
      this.initializing = null;
    });
  }

  private request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const child = this.child;
    if (!child) {
      return Promise.reject(new Error("Codebase Memory process is not running"));
    }

    const id = this.nextId;
    this.nextId += 1;
    const startedAt = performance.now();
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codebase Memory MCP request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, startedAt });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessage(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class FallbackCbmTransport implements CbmTransport {
  readonly kind = "persistent";
  private readonly primary: CbmTransport;
  private readonly fallback: CbmTransport;
  private usingFallback = false;

  constructor(primary: CbmTransport, fallback: CbmTransport) {
    this.primary = primary;
    this.fallback = fallback;
  }

  get processStartCount(): number {
    return this.primary.processStartCount + this.fallback.processStartCount;
  }

  get activeKind(): string {
    return this.usingFallback ? "cli-fallback" : this.primary.kind;
  }

  async callTool<T = unknown>(tool: string, args: CbmArgs = {}): Promise<CbmCommandResult<T>> {
    if (this.usingFallback) {
      return this.fallback.callTool<T>(tool, args);
    }
    try {
      return await this.primary.callTool<T>(tool, args);
    } catch {
      this.usingFallback = true;
      await this.primary.close();
      const result = await this.fallback.callTool<T>(tool, args);
      return { ...result, transport: "cli-fallback" };
    }
  }

  close(): Promise<void> | void {
    const primaryClose = this.primary.close();
    const fallbackClose = this.fallback.close();
    if (primaryClose instanceof Promise || fallbackClose instanceof Promise) {
      return Promise.all([primaryClose, fallbackClose]).then(() => undefined);
    }
  }
}

export function createDefaultTransport(options: CbmTransportOptions = {}): CbmTransport {
  const persistent = new PersistentCbmTransport(options);
  const cli = new CliCbmTransport(options);
  return new FallbackCbmTransport(persistent, cli);
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

function toMcpArgs(args: CbmArgs): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) {
      continue;
    }
    result[key.replaceAll("-", "_")] = value;
  }
  return result;
}

function serializeArgs(args: CbmArgs): string[] {
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
