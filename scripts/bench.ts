import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CbmClient } from "../src/cbm/client.js";
import { buildRelevantContext, ensureProjectForRepo } from "../src/policy/exploration.js";
import { analyzeSession } from "../src/telemetry/session-analyzer.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_MODEL = "openai/gpt-5-nano";
export type BenchMode = "stock" | "sydes";

export interface BenchmarkManifest {
  id: string;
  repoUrl?: string;
  sourceRepo?: string;
  baseCommit: string;
  taskPrompt: string;
  setupCommand: string;
  preTestCommand: string;
  oracleCommand: string;
  focusedTestCommand?: string;
  language?: string;
  framework?: string;
  metadata?: Record<string, unknown>;
}

export interface BenchOptions {
  taskId: string;
  mode: BenchMode;
  dryRun: boolean;
  confirmPaidRun: boolean;
  runId?: string;
  model: string;
  manifestsDir: string;
  artifactsRoot: string;
  piBin: string;
  extensionPath: string;
  cbmBin: string;
  env: NodeJS.ProcessEnv;
}

export interface BenchDeps {
  execFile: typeof execFileAsync;
  spawnPi: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;
  makeCbmClient: () => CbmClient;
  analyze: typeof analyzeSession;
}

export function parseBenchArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): BenchOptions {
  const home = env.HOME ?? homedir();
  return {
    taskId: valueAfter(argv, "--task") ?? valueWithPrefix(argv, "--task=") ?? "",
    mode: parseMode(valueAfter(argv, "--mode") ?? valueWithPrefix(argv, "--mode=") ?? ""),
    dryRun: argv.includes("--dry-run"),
    confirmPaidRun: argv.includes("--confirm-paid-run"),
    runId: valueAfter(argv, "--run-id") ?? valueWithPrefix(argv, "--run-id="),
    model: valueAfter(argv, "--model") ?? valueWithPrefix(argv, "--model=") ?? DEFAULT_MODEL,
    manifestsDir: resolve("benchmarks/tasks"),
    artifactsRoot: resolve(home, ".sydes-pi/benchmarks"),
    piBin: resolve("node_modules/.bin/pi"),
    extensionPath: resolve("src/index.ts"),
    cbmBin: resolve("node_modules/.bin/codebase-memory-mcp"),
    env
  };
}

export function buildBenchPiCommand(options: BenchOptions, manifest: BenchmarkManifest, runDir: string): {
  command: string;
  args: string[];
  sessionDir: string;
} {
  const sessionDir = join(runDir, "pi-sessions");
  const args = [
    "--model",
    options.model,
    "--mode",
    "text",
    "--print",
    "--no-extensions"
  ];
  if (options.mode === "sydes") {
    args.push("--extension", options.extensionPath);
  }
  args.push(
    "--session-dir",
    sessionDir,
    "--name",
    `Sydes benchmark ${manifest.id} ${options.mode} ${basename(dirname(runDir))}`,
    "--approve",
    manifest.taskPrompt
  );
  return { command: options.piBin, args, sessionDir };
}

export async function runBench(options: BenchOptions, deps: BenchDeps = defaultDeps(options)): Promise<number> {
  if (!options.taskId) {
    console.error("Missing --task <task-id>.");
    return 1;
  }
  if (!options.dryRun && !options.confirmPaidRun) {
    console.error("Refusing to start paid Pi run.");
    console.error("Re-run with --confirm-paid-run.");
    return 1;
  }

  const manifest = await loadManifest(options.manifestsDir, options.taskId);
  const runId = options.runId ?? timestampRunId();
  const modeDir = join(options.artifactsRoot, manifest.id, runId, options.mode);
  const tempRoot = await mkdtemp(join(tmpdir(), `sydes-pi-bench-${manifest.id}-${options.mode}-${runId}.`));
  const worktree = join(tempRoot, repoFolderName(manifest));
  const cbm = deps.makeCbmClient();
  const startTime = new Date().toISOString();
  let piSessionPath = "";

  try {
    console.log(`Benchmark task: ${manifest.id}`);
    console.log(`Mode: ${options.mode}`);
    console.log(`Model: ${options.model}`);
    console.log(options.dryRun ? "Dry run: no model generation will be started." : "This will make one paid model run.");
    console.log(`OPENAI_API_KEY: ${options.env.OPENAI_API_KEY ? "SET" : "MISSING"}`);

    await mkdir(modeDir, { recursive: true });
    await writeRunJson(modeDir, {
      taskId: manifest.id,
      runId,
      mode: options.mode,
      model: options.model,
      taskPrompt: manifest.taskPrompt,
      baseCommit: manifest.baseCommit,
      source: manifest.sourceRepo ?? manifest.repoUrl,
      worktree,
      dryRun: options.dryRun,
      startTime
    });

    const source = sourceForManifest(manifest);
    assertSourceAllowed(source);
    await cloneSource(deps, source, worktree);
    await deps.execFile("git", ["checkout", "--quiet", manifest.baseCommit], { cwd: worktree });
    await ensureCleanWorktree(deps, worktree);

    if (manifest.setupCommand.trim()) {
      await runCommand(deps, manifest.setupCommand, worktree, modeDir, "setup.txt");
    }

    const preTests = await runCommand(deps, manifest.preTestCommand, worktree, modeDir, "repo-tests-pre.txt");
    if (preTests.exitCode !== 0) {
      throw new Error("Pre-tests failed before model call; refusing to start benchmark.");
    }

    if (options.mode === "sydes") {
      const resolution = await ensureProjectForRepo(worktree, cbm, {
        allowIndex: true,
        readinessProbeQuery: manifest.taskPrompt
      });
      if (!resolution.project || resolution.readinessStrategy?.startsWith("timeout")) {
        throw new Error(`Sydes preflight was not ready: ${resolution.reason ?? resolution.readinessStrategy ?? "unknown"}`);
      }
      const context = await buildRelevantContext(manifest.taskPrompt, worktree, cbm, {
        allowIndex: true,
        projectCache: new Map([[resolution.repoRoot ?? worktree, {
          repoRoot: resolution.repoRoot ?? worktree,
          project: resolution.project,
          indexedThisSession: !!resolution.indexedThisSession,
          ensureElapsedMs: resolution.ensureElapsedMs ?? 0,
          indexElapsedMs: resolution.indexElapsedMs,
          readinessWaitMs: resolution.readinessWaitMs,
          readinessPollCount: resolution.readinessPollCount,
          readinessStrategy: resolution.readinessStrategy
        }]])
      });
      if (!context || context.entryPoints.length === 0 || context.files.length === 0) {
        throw new Error("Sydes preflight context is empty; refusing to start benchmark.");
      }
      await writeFile(join(modeDir, "preflight-context.json"), `${JSON.stringify(context, null, 2)}\n`);
    }

    if (options.dryRun) {
      const pi = buildBenchPiCommand(options, manifest, modeDir);
      await mkdir(pi.sessionDir, { recursive: true });
      console.log(`Pi command: ${shellQuote([pi.command, ...pi.args])}`);
      console.log("Dry run complete before Pi generation.");
      return 0;
    }

    if (!options.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is missing; refusing to start paid benchmark.");
    }
    await deps.execFile(options.piBin, ["--list-models", options.model], { env: options.env });

    const pi = buildBenchPiCommand(options, manifest, modeDir);
    await mkdir(pi.sessionDir, { recursive: true });
    console.log(`Pi command: ${shellQuote([pi.command, ...pi.args])}`);

    const piExit = await deps.spawnPi(pi.command, pi.args, {
      cwd: worktree,
      env: {
        ...options.env,
        SYDES_RUN_DIR: options.mode === "sydes" ? modeDir : "",
        PI_CODING_AGENT_SESSION_DIR: pi.sessionDir
      }
    });
    if (piExit !== 0) {
      throw new Error(`Pi exited with ${piExit}; not retrying.`);
    }

    const repoTests = await runCommand(deps, manifest.preTestCommand, worktree, modeDir, "repo-tests.txt");
    await writeFile(join(modeDir, "repo-tests.txt"), `REPO_TESTS=${repoTests.exitCode === 0 ? "PASS" : "FAIL"}\n${repoTests.output}`);
    const oracle = await runCommand(deps, manifest.oracleCommand, worktree, modeDir, "oracle.txt");
    await writeFile(join(modeDir, "oracle.txt"), `ORACLE=${oracle.exitCode === 0 ? "PASS" : "FAIL"}\n${oracle.output}`);

    const diff = await deps.execFile("git", ["diff", "--binary"], { cwd: worktree });
    await writeFile(join(modeDir, "final.diff"), diff.stdout);
    piSessionPath = await newestSessionJsonl(pi.sessionDir);
    const endTime = new Date().toISOString();
    await writeRunJson(modeDir, {
      taskId: manifest.id,
      runId,
      mode: options.mode,
      model: options.model,
      taskPrompt: manifest.taskPrompt,
      baseCommit: manifest.baseCommit,
      source: manifest.sourceRepo ?? manifest.repoUrl,
      worktree,
      dryRun: false,
      startTime,
      endTime,
      piSessionPath
    });
    const summary = await deps.analyze({
      sessionPath: piSessionPath,
      repoRoot: worktree,
      sydesPath: options.mode === "sydes" ? join(modeDir, "sydes.json") : join(modeDir, "missing-sydes.json"),
      runJsonPath: join(modeDir, "run.json"),
      finalDiffPath: join(modeDir, "final.diff"),
      repoTestsPath: join(modeDir, "repo-tests.txt"),
      oraclePath: join(modeDir, "oracle.txt"),
      outputPath: join(modeDir, "summary.json")
    });
    printBenchSummary(summary, modeDir);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await cbm.close();
    if (options.dryRun) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function loadManifest(manifestsDir: string, taskId: string): Promise<BenchmarkManifest> {
  const path = join(manifestsDir, `${taskId}.json`);
  const raw = JSON.parse(await readFile(path, "utf8")) as BenchmarkManifest;
  for (const key of ["id", "baseCommit", "taskPrompt", "setupCommand", "preTestCommand", "oracleCommand"] as const) {
    if (typeof raw[key] !== "string") {
      throw new Error(`Invalid benchmark manifest ${path}: missing ${key}`);
    }
  }
  if (!raw.sourceRepo && !raw.repoUrl) {
    throw new Error(`Invalid benchmark manifest ${path}: missing sourceRepo or repoUrl`);
  }
  return raw;
}

function defaultDeps(options: BenchOptions): BenchDeps {
  return {
    execFile: execFileAsync,
    spawnPi: (command, args, spawnOptions) =>
      new Promise<number>((resolveExit) => {
        const child = spawn(command, args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: "inherit"
        });
        child.on("close", (code) => resolveExit(code ?? 1));
      }),
    makeCbmClient: () => new CbmClient({ bin: options.cbmBin }),
    analyze: analyzeSession
  };
}

async function cloneSource(deps: BenchDeps, source: string, worktree: string): Promise<void> {
  await deps.execFile("git", ["clone", "--quiet", source, worktree]);
}

async function runCommand(
  deps: BenchDeps,
  command: string,
  repo: string,
  runDir: string,
  fileName: string
): Promise<{ exitCode: number; output: string }> {
  const expanded = expandCommand(command, repo, runDir);
  try {
    const result = await deps.execFile("/bin/bash", ["-lc", expanded], { cwd: repo });
    const output = combined(result);
    await writeFile(join(runDir, fileName), output);
    return { exitCode: 0, output };
  } catch (error: any) {
    const output = combined(error);
    await writeFile(join(runDir, fileName), output || String(error?.message ?? error));
    return { exitCode: typeof error?.code === "number" ? error.code : 1, output };
  }
}

function expandCommand(command: string, repo: string, runDir: string): string {
  return expandHome(command).replaceAll("{repo}", shellEscape(repo)).replaceAll("{runDir}", shellEscape(runDir));
}

function sourceForManifest(manifest: BenchmarkManifest): string {
  return expandHome(manifest.sourceRepo ?? manifest.repoUrl ?? "");
}

function assertSourceAllowed(source: string): void {
  if (!source) throw new Error("Benchmark source is empty.");
  if (source.startsWith("/") && !existsSync(source)) {
    throw new Error(`Benchmark source repo not found: ${source}`);
  }
}

async function ensureCleanWorktree(deps: BenchDeps, worktree: string): Promise<void> {
  const status = await deps.execFile("git", ["status", "--short"], { cwd: worktree });
  if (status.stdout.trim()) {
    throw new Error(`Fresh benchmark worktree is not clean:\n${status.stdout}`);
  }
}

async function newestSessionJsonl(sessionDir: string): Promise<string> {
  const files = await collectFiles(sessionDir);
  const jsonl = files.filter((file) => file.endsWith(".jsonl"));
  if (jsonl.length === 0) {
    throw new Error(`No Pi session JSONL found under ${sessionDir}`);
  }
  jsonl.sort();
  return jsonl.at(-1)!;
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? collectFiles(path) : [path];
    })
  );
  return nested.flat();
}

function writeRunJson(runDir: string, data: Record<string, unknown>): Promise<void> {
  return writeFile(join(runDir, "run.json"), `${JSON.stringify(data, null, 2)}\n`);
}

function repoFolderName(manifest: BenchmarkManifest): string {
  return basename(expandHome(manifest.sourceRepo ?? manifest.repoUrl ?? "repo").replace(/\.git$/, "")) || "repo";
}

function parseMode(mode: string): BenchMode {
  if (mode === "stock" || mode === "sydes") return mode;
  return "" as BenchMode;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function valueWithPrefix(argv: string[], prefix: string): string | undefined {
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function timestampRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function expandHome(value: string): string {
  return value.replace(/^~(?=$|\/)/, homedir());
}

function combined(result: { stdout?: string; stderr?: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuote(values: string[]): string {
  return values.map(shellEscape).join(" ");
}

function printBenchSummary(summary: Record<string, unknown>, modeDir: string): void {
  const s = summary as any;
  console.log(`artifacts: ${modeDir}`);
  console.log(`correctness: ${s.correctness?.taskCorrectness ?? "unknown"}`);
  console.log(`repo tests: ${s.correctness?.repoTests ?? "unknown"}`);
  console.log(`api calls: ${s.usage?.apiCalls ?? "n/a"}`);
  console.log(`tool calls: ${s.tools?.total ?? "n/a"}`);
  console.log(`elapsed seconds: ${s.agent?.elapsedSeconds ?? "n/a"}`);
}

async function main(args: string[]): Promise<void> {
  const options = parseBenchArgs(args);
  if (options.mode !== "stock" && options.mode !== "sydes") {
    console.error("Missing or invalid --mode <stock|sydes>.");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runBench(options);
}

if (process.env.SYDES_BENCH_ENTRY === "1") {
  void main(process.argv.slice(2));
}
