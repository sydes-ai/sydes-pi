import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { CbmClient } from "../src/cbm/client.js";
import { buildExplorationGuidance, buildRelevantContext, ensureProjectForRepo } from "../src/policy/exploration.js";
import { analyzeSession } from "../src/telemetry/session-analyzer.js";
import type { RelevantContext } from "../src/policy/types.js";

const execFileAsync = promisify(execFile);

export const MODEL = "openai/gpt-5-nano";
export const TASK =
  "POST /api/v1/pokemon with hp=0 must return HTTP 400; preserve existing valid POST behavior. Update or add the relevant tests, run the affected tests, and make only the minimal necessary changes.";
export const BASE_COMMIT = "5d6a96f373b67afddbafaa0ab7d26e61fb3bf3f0";

export interface LiveRunnerOptions {
  confirmPaidRun: boolean;
  dryRun: boolean;
  sourceRepo: string;
  oraclePath: string;
  piBin: string;
  extensionPath: string;
  cbmBin: string;
  runsRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface LiveRunnerDeps {
  execFile: typeof execFileAsync;
  spawnPi: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;
  makeCbmClient: () => CbmClient;
  buildContext: typeof buildRelevantContext;
  analyze: typeof analyzeSession;
  now: () => number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): LiveRunnerOptions {
  const home = env.HOME ?? homedir();
  return {
    confirmPaidRun: argv.includes("--confirm-paid-run"),
    dryRun: argv.includes("--dry-run"),
    sourceRepo: resolve(home, "sample_repos/pokemon-api"),
    oraclePath: resolve(home, "Projects/sydes-agent/benchmarks/oracles/pokemon_hp_zero_oracle.py"),
    piBin: resolve("node_modules/.bin/pi"),
    extensionPath: resolve("src/index.ts"),
    cbmBin: resolve("node_modules/.bin/codebase-memory-mcp"),
    runsRoot: resolve(home, ".sydes-pi/runs/pokemon-api"),
    env
  };
}

export function buildPiCommand(options: LiveRunnerOptions, worktree: string, runDir: string): {
  command: string;
  args: string[];
  sessionDir: string;
} {
  const sessionDir = join(runDir, "pi-sessions");
  return {
    command: options.piBin,
    sessionDir,
    args: [
      "--model",
      MODEL,
      "--mode",
      "text",
      "--print",
      "--no-extensions",
      "--extension",
      options.extensionPath,
      "--session-dir",
      sessionDir,
      "--name",
      `Sydes Pokemon hp=0 ${basename(runDir)}`,
      "--approve",
      TASK
    ]
  };
}

export async function runLiveSydes(
  options: LiveRunnerOptions,
  deps: LiveRunnerDeps = defaultDeps(options)
): Promise<number> {
  if (!options.dryRun && !options.confirmPaidRun) {
    console.error("Refusing to start paid Pi run.");
    console.error("Re-run with --confirm-paid-run.");
    return 1;
  }

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z-pokemon-sydes");
  const runDir = join(options.runsRoot, runId);
  const tempRoot = await mkdtemp(join(tmpdir(), `sydes-pi-benchmark-${runId}.`));
  const worktree = join(tempRoot, "pokemon-api");
  const cbm = deps.makeCbmClient();
  const startTime = new Date().toISOString();
  let context: RelevantContext | null = null;
  let piSessionPath = "";

  try {
    console.log("Sydes live run");
    console.log(`Model: ${MODEL}`);
    console.log("Task: Pokemon hp=0");
    console.log("Mode: Sydes");
    console.log(options.dryRun ? "Dry run: no paid model run will be started." : "This will make one paid model run.");

    await mkdir(runDir, { recursive: true });
    await writeRunJson(runDir, { runId, startTime, sourceRepo: options.sourceRepo, worktree, model: MODEL, task: TASK, baseCommit: BASE_COMMIT, dryRun: options.dryRun });

    console.log("[1/8] Preparing worktree");
    assertExists(options.sourceRepo, "Pokemon source repo");
    assertExists(options.oraclePath, "hidden oracle");
    await deps.execFile("git", ["clone", "--quiet", options.sourceRepo, worktree]);
    await deps.execFile("git", ["checkout", "--quiet", BASE_COMMIT], { cwd: worktree });
    await ensureCleanWorktree(deps, worktree);

    console.log("[2/8] Running pre-tests");
    const preTests = await deps.execFile("go", ["test", "./..."], { cwd: worktree });
    await writeFile(join(runDir, "repo-tests-pre.txt"), combined(preTests));

    console.log("[3/8] Ensuring CBM index");
    const resolution = await ensureProjectForRepo(worktree, cbm, {
      allowIndex: true,
      readinessProbeQuery: "InitRoutes AddPokemon addPokemon"
    });
    if (!resolution.project || resolution.readinessStrategy?.startsWith("timeout")) {
      throw new Error(`CBM preflight was not ready: ${resolution.reason ?? resolution.readinessStrategy ?? "unknown"}`);
    }

    console.log("[4/8] Verifying Sydes context");
    context = await deps.buildContext(TASK, worktree, cbm, {
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
      throw new Error("Sydes preflight context is empty; refusing to start paid Pi run.");
    }
    await writeFile(join(runDir, "preflight-context.json"), `${JSON.stringify(context, null, 2)}\n`);
    await writeFile(join(runDir, "preflight-guidance.txt"), `${buildExplorationGuidance(context)}\n`);

    const apiKeyState = options.env.OPENAI_API_KEY ? "SET" : "MISSING";
    console.log(`OPENAI_API_KEY: ${apiKeyState}`);
    if (!options.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is missing; refusing to start paid Pi run.");
    }
    await deps.execFile(options.piBin, ["--list-models", MODEL], { env: options.env });

    const pi = buildPiCommand(options, worktree, runDir);
    await mkdir(pi.sessionDir, { recursive: true });
    console.log(`Pi command: ${shellQuote([pi.command, ...pi.args])}`);
    if (options.dryRun) {
      console.log("Dry run complete before Pi generation.");
      return 0;
    }

    console.log("[5/8] Launching Pi");
    const piExit = await deps.spawnPi(pi.command, pi.args, {
      cwd: worktree,
      env: {
        ...options.env,
        SYDES_RUN_DIR: runDir,
        PI_CODING_AGENT_SESSION_DIR: pi.sessionDir
      }
    });
    if (piExit !== 0) {
      throw new Error(`Pi exited with ${piExit}; not retrying.`);
    }

    console.log("[6/8] Running repo tests");
    const repoTests = await deps.execFile("go", ["test", "./...", "-count=1"], { cwd: worktree });
    await writeFile(join(runDir, "repo-tests.txt"), `REPO_TESTS=PASS\n${combined(repoTests)}`);

    console.log("[7/8] Running hidden oracle");
    const oracle = await deps.execFile("python3", [options.oraclePath, "--repo", worktree], { cwd: worktree });
    await writeFile(join(runDir, "hidden-oracle.txt"), combined(oracle));

    await deps.execFile("git", ["diff", "--binary"], { cwd: worktree }).then((diff) =>
      writeFile(join(runDir, "final.diff"), diff.stdout)
    );
    piSessionPath = await newestSessionJsonl(pi.sessionDir);

    console.log("[8/8] Analyzing session");
    const summary = await deps.analyze({
      sessionPath: piSessionPath,
      repoRoot: worktree,
      sydesPath: join(runDir, "sydes.json"),
      runJsonPath: join(runDir, "run.json"),
      finalDiffPath: join(runDir, "final.diff"),
      repoTestsPath: join(runDir, "repo-tests.txt"),
      oraclePath: join(runDir, "hidden-oracle.txt"),
      outputPath: join(runDir, "summary.json")
    });
    await writeRunJson(runDir, { runId, startTime, endTime: new Date().toISOString(), sourceRepo: options.sourceRepo, worktree, model: MODEL, task: TASK, baseCommit: BASE_COMMIT, dryRun: false, piSessionPath });
    printSummary(summary, context, runDir);
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

function defaultDeps(options: LiveRunnerOptions): LiveRunnerDeps {
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
    buildContext: buildRelevantContext,
    analyze: analyzeSession,
    now: () => performance.now()
  };
}

async function ensureCleanWorktree(deps: LiveRunnerDeps, worktree: string): Promise<void> {
  const status = await deps.execFile("git", ["status", "--short"], { cwd: worktree });
  if (status.stdout.trim()) {
    throw new Error(`Fresh worktree is not clean:\n${status.stdout}`);
  }
}

function assertExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
}

function combined(result: { stdout?: string; stderr?: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function writeRunJson(runDir: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(data, null, 2)}\n`);
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

function shellQuote(parts: string[]): string {
  return parts.map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}

function printSummary(summary: Record<string, unknown>, context: RelevantContext, runDir: string): void {
  const anySummary = summary as any;
  console.log("Summary:");
  console.log(`correctness: ${anySummary.correctness?.taskCorrectness ?? "unknown"}`);
  console.log(`api calls: ${anySummary.usage?.apiCalls ?? "unknown"}`);
  console.log(`tokens: input=${anySummary.usage?.inputTokens ?? "n/a"} cached=${anySummary.usage?.cachedTokens ?? "n/a"} output=${anySummary.usage?.outputTokens ?? "n/a"}`);
  console.log(`cost: ${anySummary.usage?.totalCost ?? "n/a"}`);
  console.log(`tool calls: ${anySummary.tools?.total ?? "unknown"}`);
  console.log(`first reads: ${(anySummary.exploration?.first3Reads ?? []).join(", ") || "none"}`);
  console.log(`priority hits: ${(anySummary.exploration?.first3PriorityHits ?? []).join(", ") || "none"}`);
  console.log(`first edit: ${anySummary.editing?.firstEditFile ?? "none"}`);
  console.log(`impact guidance count: ${anySummary.sydes?.impactGuidanceCount ?? 0}`);
  console.log(`CBM readiness wait: ${context.projectReadinessWaitMs ?? "n/a"}ms`);
  console.log(`repo tests: ${anySummary.correctness?.repoTests ?? "unknown"}`);
  console.log(`hidden oracle: ${anySummary.correctness?.hiddenOracle ?? "unknown"}`);
  console.log(`artifact directory: ${runDir}`);
}

if (!process.env.VITEST && !process.env.VITEST_WORKER_ID) {
  runLiveSydes(parseArgs(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}
