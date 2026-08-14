import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CbmClient } from "../cbm/client.js";
import type { SydesIntegrationMode } from "../config.js";
import { MODEL_CALL_MIN_INTERVAL_ENV, MODEL_CALL_PACING_EVENTS_ENV } from "./pi-request-pacer.js";
import { buildRelevantContext, ensureProjectForRepo } from "../policy/exploration.js";
import { analyzeSession } from "../telemetry/session-analyzer.js";

const execFileAsync = promisify(execFile);
export const SWE_DATASET = "SWE-bench/SWE-bench_Multilingual";
export const DEFAULT_MODEL = "openai/gpt-5-nano";
export const SWE_THINKING_LEVEL = "medium";
export const SWE_MAX_OUTPUT_TOKENS = 16384;
export const SWE_PI_AGENT_DIR = resolve("benchmarks/pi-agent");
export const SWE_REQUEST_PACER_EXTENSION_PATH = resolve("src/benchmark/pi-request-pacer.ts");
export type SweMode = "stock" | "sydes";

export interface SweManifest {
  instance_id: string;
  dataset: string;
  datasetRevision?: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  image?: string;
  eval_type?: string;
  eval_script?: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface SweRunOptions {
  instanceId: string;
  mode: SweMode;
  dryRun: boolean;
  confirmPaidRun: boolean;
  runId?: string;
  model: string;
  manifestsDir: string;
  artifactsRoot: string;
  piBin: string;
  extensionPath: string;
  requestPacerExtensionPath: string;
  piAgentDir: string;
  cbmBin: string;
  sydesIntegrationMode?: SydesIntegrationMode;
  modelCallMinIntervalMs: number;
  env: NodeJS.ProcessEnv;
}

export interface SweDeps {
  execFile: typeof execFileAsync;
  spawnPi: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;
  makeCbmClient: () => CbmClient;
  analyze: typeof analyzeSession;
}

export function parseSweArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SweRunOptions {
  const home = env.HOME ?? homedir();
  return {
    instanceId: valueAfter(argv, "--instance") ?? valueWithPrefix(argv, "--instance=") ?? "",
    mode: parseMode(valueAfter(argv, "--mode") ?? valueWithPrefix(argv, "--mode=") ?? ""),
    dryRun: argv.includes("--dry-run"),
    confirmPaidRun: argv.includes("--confirm-paid-run"),
    runId: valueAfter(argv, "--run-id") ?? valueWithPrefix(argv, "--run-id="),
    model: valueAfter(argv, "--model") ?? valueWithPrefix(argv, "--model=") ?? DEFAULT_MODEL,
    manifestsDir: resolve("benchmarks/swebench"),
    artifactsRoot: resolve(home, ".sydes-pi/swebench"),
    piBin: resolve("node_modules/.bin/pi"),
    extensionPath: resolve("src/index.ts"),
    requestPacerExtensionPath: SWE_REQUEST_PACER_EXTENSION_PATH,
    piAgentDir: SWE_PI_AGENT_DIR,
    cbmBin: resolve("node_modules/.bin/codebase-memory-mcp"),
    sydesIntegrationMode: parseSydesIntegrationMode(valueAfter(argv, "--sydes-integration-mode") ?? valueWithPrefix(argv, "--sydes-integration-mode=")),
    modelCallMinIntervalMs: parseNonNegativeInt(
      valueAfter(argv, "--model-call-min-interval-ms")
        ?? valueWithPrefix(argv, "--model-call-min-interval-ms=")
        ?? env[MODEL_CALL_MIN_INTERVAL_ENV]
        ?? "0",
      "--model-call-min-interval-ms"
    ),
    env
  };
}

export async function importSweInstance(options: {
  instanceId: string;
  outputDir?: string;
  dataset?: string;
  datasetRevision?: string;
  fetchRow?: (dataset: string, instanceId: string) => Promise<Record<string, unknown>>;
}): Promise<SweManifest> {
  const dataset = options.dataset ?? SWE_DATASET;
  const row = options.fetchRow ? await options.fetchRow(dataset, options.instanceId) : await fetchInstanceRow(dataset, options.instanceId);
  const manifest = normalizeSweRow(row, dataset, options.datasetRevision ?? String(row.dataset_revision ?? row.revision ?? "unknown"));
  await mkdir(options.outputDir ?? resolve("benchmarks/swebench"), { recursive: true });
  await writeFile(join(options.outputDir ?? resolve("benchmarks/swebench"), `${manifest.instance_id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function normalizeSweRow(row: Record<string, unknown>, dataset: string, datasetRevision = "unknown"): SweManifest {
  const instanceId = stringField(row, "instance_id");
  const repo = stringField(row, "repo");
  const problem = stringField(row, "problem_statement");
  return {
    instance_id: instanceId,
    dataset,
    datasetRevision,
    repo,
    base_commit: stringField(row, "base_commit"),
    problem_statement: problem,
    FAIL_TO_PASS: arrayField(row, "FAIL_TO_PASS"),
    PASS_TO_PASS: arrayField(row, "PASS_TO_PASS"),
    image: optionalString(row.image),
    eval_type: optionalString(row.eval_type),
    eval_script: redactEvalScript(optionalString(row.eval_script)),
    language: optionalString(row.language),
    metadata: {
      problemStatementSha256: sha256(problem),
      evalScriptSha256: optionalString(row.eval_script) ? sha256(optionalString(row.eval_script)!) : undefined,
      evalScriptRedacted: !!optionalString(row.eval_script),
      importedAt: new Date().toISOString()
    }
  };
}

export function buildSweTaskPrompt(problemStatement: string): string {
  return [
    "Implement the requested change in the current repository.",
    "",
    "Inspect the relevant code, make the necessary file edits, and run relevant tests if feasible. Do not only explain the solution. Keep the change minimal and focused.",
    "",
    "Issue:",
    problemStatement
  ].join("\n");
}

export function buildSwePiCommand(options: SweRunOptions, manifest: SweManifest, runDir: string): {
  command: string;
  args: string[];
  sessionDir: string;
  prompt: string;
} {
  const sessionDir = join(runDir, "pi-sessions");
  const prompt = buildSweTaskPrompt(manifest.problem_statement);
  const args = ["--model", options.model, "--thinking", SWE_THINKING_LEVEL, "--mode", "text", "--print", "--no-extensions"];
  if (options.modelCallMinIntervalMs > 0) {
    args.push("--extension", options.requestPacerExtensionPath);
  }
  if (options.mode === "sydes") {
    args.push("--extension", options.extensionPath);
  }
  args.push("--session-dir", sessionDir, "--name", `SWE ${manifest.instance_id} ${options.mode}`, "--approve", prompt);
  return { command: options.piBin, args, sessionDir, prompt };
}

export function buildSwePiEnv(options: SweRunOptions, modeDir: string, sessionDir: string): NodeJS.ProcessEnv {
  const {
    SYDES_INTEGRATION_MODE: _discarded,
    [MODEL_CALL_MIN_INTERVAL_ENV]: _discardedMinInterval,
    [MODEL_CALL_PACING_EVENTS_ENV]: _discardedEvents,
    ...baseEnv
  } = options.env;
  const sydesIntegrationMode = options.sydesIntegrationMode ?? options.env.SYDES_INTEGRATION_MODE;
  return {
    ...baseEnv,
    PI_CODING_AGENT_DIR: options.piAgentDir,
    SYDES_RUN_DIR: options.mode === "sydes" ? modeDir : "",
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...(options.mode === "sydes" && sydesIntegrationMode ? { SYDES_INTEGRATION_MODE: sydesIntegrationMode } : {}),
    ...(options.modelCallMinIntervalMs > 0 ? {
      [MODEL_CALL_MIN_INTERVAL_ENV]: String(options.modelCallMinIntervalMs),
      [MODEL_CALL_PACING_EVENTS_ENV]: join(modeDir, "provider-pacing-events.jsonl")
    } : {})
  };
}

export async function runSweBench(options: SweRunOptions, deps: SweDeps = defaultDeps(options)): Promise<number> {
  if (!options.instanceId) {
    console.error("Missing --instance <id>.");
    return 1;
  }
  if (!options.dryRun && !options.confirmPaidRun) {
    console.error("Refusing to start paid Pi run.");
    console.error("Re-run with --confirm-paid-run.");
    return 1;
  }
  const manifest = await readSweManifest(options.manifestsDir, options.instanceId);
  const runId = options.runId ?? timestampRunId();
  const modeDir = join(options.artifactsRoot, manifest.instance_id, runId, options.mode);
  const tempRoot = await mkdtemp(join(tmpdir(), `sydes-swe-${manifest.instance_id}-${options.mode}-${runId}.`));
  const worktree = join(tempRoot, repoFolderName(manifest.repo));
  const cbm = deps.makeCbmClient();
  const startTime = new Date().toISOString();

  try {
    console.log(`SWE instance: ${manifest.instance_id}`);
    console.log(`Dataset: ${manifest.dataset}`);
    console.log(`Mode: ${options.mode}`);
    console.log(`Model: ${options.model}`);
    console.log(`Thinking: ${SWE_THINKING_LEVEL}`);
    console.log(`Max output tokens: ${SWE_MAX_OUTPUT_TOKENS}`);
    console.log(`Provider request pacing: ${options.modelCallMinIntervalMs > 0 ? `${options.modelCallMinIntervalMs}ms` : "disabled"}`);
    console.log(options.dryRun ? "Dry run: no model generation will be started." : "This will make one paid model run.");
    console.log(`OPENAI_API_KEY: ${options.env.OPENAI_API_KEY ? "SET" : "MISSING"}`);

    await mkdir(modeDir, { recursive: true });
    const repoUrl = githubRepoUrl(manifest.repo);
    await writeRunMetadata(modeDir, manifest, {
      runId,
      mode: options.mode,
      model: options.model,
      thinking: SWE_THINKING_LEVEL,
      maxTokens: SWE_MAX_OUTPUT_TOKENS,
      integrationMode: options.mode === "sydes" ? options.sydesIntegrationMode ?? null : null,
      requestPacing: requestPacingMetadata(options),
      piAgentDir: options.piAgentDir,
      worktree,
      repoUrl,
      dryRun: options.dryRun,
      startTime,
      piVersion: await commandVersion(deps, options.piBin, ["--version"]),
      cbmVersion: await commandVersion(deps, options.cbmBin, ["--version"]),
      sydesGitCommit: await commandVersion(deps, "git", ["rev-parse", "HEAD"], process.cwd()),
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      swebenchEvaluatorCommit: await evaluatorCommit(deps)
    });

    await deps.execFile("git", ["clone", "--quiet", "--filter=blob:none", repoUrl, worktree]);
    await deps.execFile("git", ["checkout", "--quiet", manifest.base_commit], { cwd: worktree });
    await assertHead(deps, worktree, manifest.base_commit);
    await ensureCleanWorktree(deps, worktree);

    if (options.mode === "sydes") {
      try {
        const resolution = await ensureProjectForRepo(worktree, cbm, { allowIndex: true, readinessProbeQuery: manifest.problem_statement });
        if (!resolution.project || resolution.readinessStrategy?.startsWith("timeout")) {
          throw new Error(`Sydes preflight was not ready: ${resolution.reason ?? resolution.readinessStrategy ?? "unknown"}`);
        }
        const context = await buildRelevantContext(manifest.problem_statement, worktree, cbm, {
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
          throw new Error("Sydes preflight context is empty.");
        }
        await writeFile(join(modeDir, "preflight-context.json"), `${JSON.stringify(context, null, 2)}\n`);
      } catch (error) {
        if (!options.dryRun) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; refusing to start benchmark.`);
        }
        const reason = error instanceof Error ? error.message : String(error);
        await writeFile(join(modeDir, "preflight-context.json"), `${JSON.stringify({ dryRunPreflightReady: false, reason }, null, 2)}\n`);
        console.warn(`Sydes dry-run preflight unavailable: ${reason}`);
      }
    }

    const pi = buildSwePiCommand(options, manifest, modeDir);
    await mkdir(pi.sessionDir, { recursive: true });
    const piEnv = buildSwePiEnv(options, modeDir, pi.sessionDir);
    console.log(`Pi command: ${shellQuote([pi.command, ...pi.args])}`);
    if (options.dryRun) {
      await writeFile(join(modeDir, "final.diff"), "");
      await writeRunMetadata(modeDir, manifest, {
        runId,
        mode: options.mode,
        model: options.model,
        thinking: SWE_THINKING_LEVEL,
        maxTokens: SWE_MAX_OUTPUT_TOKENS,
        integrationMode: options.mode === "sydes" ? options.sydesIntegrationMode ?? null : null,
        requestPacing: requestPacingMetadata(options),
        piAgentDir: options.piAgentDir,
        worktree,
        repoUrl,
        dryRun: true,
        startTime,
        finalDiffSha256: sha256("")
      });
      console.log("Dry run complete before Pi generation.");
      return 0;
    }

    if (!options.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is missing; refusing to start paid benchmark.");
    }
    await deps.execFile(options.piBin, ["--list-models", options.model], { env: piEnv });
    const piExit = await deps.spawnPi(pi.command, pi.args, {
      cwd: worktree,
      env: piEnv
    });
    if (piExit !== 0) throw new Error(`Pi exited with ${piExit}; not retrying.`);

    await assertHead(deps, worktree, manifest.base_commit);
    const diff = await deps.execFile("git", ["diff", "--binary", manifest.base_commit], { cwd: worktree });
    await writeFile(join(modeDir, "final.diff"), diff.stdout);
    const piSessionPath = await newestSessionJsonl(pi.sessionDir);
    const endTime = new Date().toISOString();
    await writeRunMetadata(modeDir, manifest, {
      runId,
      mode: options.mode,
      model: options.model,
      thinking: SWE_THINKING_LEVEL,
      maxTokens: SWE_MAX_OUTPUT_TOKENS,
      integrationMode: options.mode === "sydes" ? options.sydesIntegrationMode ?? null : null,
      requestPacing: requestPacingMetadata(options),
      piAgentDir: options.piAgentDir,
      worktree,
      repoUrl,
      dryRun: false,
      startTime,
      endTime,
      piSessionPath,
      finalDiffSha256: sha256(diff.stdout)
    });
    await writeFile(join(modeDir, "repo-tests.txt"), "REPO_TESTS=NOT_RUN\n");
    await writeFile(join(modeDir, "oracle.txt"), "OFFICIAL_SWEBENCH_GRADING=NOT_RUN\n");
    await deps.analyze({
      sessionPath: piSessionPath,
      repoRoot: worktree,
      sydesPath: options.mode === "sydes" ? join(modeDir, "sydes.json") : join(modeDir, "missing-sydes.json"),
      runJsonPath: join(modeDir, "run.json"),
      finalDiffPath: join(modeDir, "final.diff"),
      repoTestsPath: join(modeDir, "repo-tests.txt"),
      oraclePath: join(modeDir, "oracle.txt"),
      outputPath: join(modeDir, "summary.json")
    });
    console.log(`artifacts: ${modeDir}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await cbm.close();
    if (options.dryRun) await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function exportPredictions(options: {
  instanceIds: string[];
  mode: SweMode;
  artifactsRoot?: string;
  outputPath?: string;
  model?: string;
}): Promise<string> {
  const root = options.artifactsRoot ?? resolve(homedir(), ".sydes-pi/swebench");
  const output = options.outputPath ?? resolve(`predictions-${options.mode}.jsonl`);
  const lines: string[] = [];
  for (const id of options.instanceIds) {
    const run = await latestModeRun(root, id, options.mode);
    if (!run) throw new Error(`No ${options.mode} SWE run found for ${id}`);
    const patch = await readFile(join(run.dir, "final.diff"), "utf8");
    lines.push(JSON.stringify({
      instance_id: id,
      model_name_or_path: modelLabel(options.mode, options.model ?? DEFAULT_MODEL),
      model_patch: patch
    }));
  }
  await writeFile(output, `${lines.join("\n")}\n`);
  return output;
}

export function buildGradeCommand(options: {
  predictionsPath: string;
  runId: string;
  instanceId?: string;
  maxWorkers?: number;
  swebenchRoot?: string;
}): { cwd: string; command: string; args: string[] } {
  const cwd = expandHome(options.swebenchRoot ?? "~/bench/SWE-bench");
  const args = [
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    SWE_DATASET,
    "--predictions_path",
    options.predictionsPath,
    "--run_id",
    options.runId,
    "--max_workers",
    String(options.maxWorkers ?? 1)
  ];
  if (options.instanceId) args.push("--instance_ids", options.instanceId);
  return { cwd, command: "python", args };
}

export async function parseOfficialReport(path: string): Promise<Record<string, unknown>> {
  const report = JSON.parse(await readFile(path, "utf8")) as any;
  const instances = report.instance_results ?? report.results ?? report;
  const byId = Array.isArray(instances)
    ? Object.fromEntries(instances.map((item: any) => [item.instance_id, item]))
    : instances;
  const parsed: Record<string, unknown> = {};
  for (const [instanceId, result] of Object.entries(byId as Record<string, any>)) {
    parsed[instanceId] = {
      resolved: !!result.resolved,
      completed: result.completed !== false,
      error: result.error ?? result.eval_error ?? null,
      emptyPatch: result.empty_patch ?? result.patch_empty ?? false,
      reportPath: path,
      officialRunId: report.run_id ?? result.run_id ?? null
    };
  }
  return parsed;
}

export async function readSweManifest(dir: string, instanceId: string): Promise<SweManifest> {
  return JSON.parse(await readFile(join(dir, `${instanceId}.json`), "utf8")) as SweManifest;
}

async function fetchInstanceRow(dataset: string, instanceId: string): Promise<Record<string, unknown>> {
  const splits = await fetchJson(`https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(dataset)}`);
  const split = String(splits.splits?.[0]?.split ?? "test");
  const config = String(splits.splits?.[0]?.config ?? "default");
  for (let offset = 0; offset < 100000; offset += 100) {
    const page = await fetchJson(`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=100`);
    for (const item of page.rows ?? []) {
      if (item.row?.instance_id === instanceId) return item.row;
    }
    if (!page.rows || page.rows.length < 100) break;
  }
  throw new Error(`Instance not found in ${dataset}: ${instanceId}`);
}

async function fetchJson(url: string): Promise<any> {
  return new Promise((resolveJson, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}: ${body.slice(0, 500)}`));
          return;
        }
        try { resolveJson(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on("error", reject);
  });
}

function defaultDeps(options: SweRunOptions): SweDeps {
  return {
    execFile: execFileAsync,
    spawnPi: (command, args, spawnOptions) => new Promise((resolveExit) => {
      const child = spawn(command, args, { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: "inherit" });
      child.on("close", (code) => resolveExit(code ?? 1));
    }),
    makeCbmClient: () => new CbmClient({ bin: options.cbmBin }),
    analyze: analyzeSession
  };
}

async function writeRunMetadata(runDir: string, manifest: SweManifest, data: Record<string, unknown>): Promise<void> {
  const merged = {
    instance_id: manifest.instance_id,
    dataset: manifest.dataset,
    datasetRevision: manifest.datasetRevision,
    repo: manifest.repo,
    base_commit: manifest.base_commit,
    problemStatementSha256: sha256(manifest.problem_statement),
    ...data
  };
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(merged, null, 2)}\n`);
}

async function commandVersion(deps: SweDeps, command: string, args: string[], cwd = process.cwd()): Promise<string | null> {
  try {
    const result = await deps.execFile(command, args, { cwd });
    return (result.stdout || result.stderr).trim() || null;
  } catch {
    return null;
  }
}

async function evaluatorCommit(deps: SweDeps): Promise<string | null> {
  const root = expandHome("~/bench/SWE-bench");
  if (!existsSync(root)) return null;
  return commandVersion(deps, "git", ["rev-parse", "HEAD"], root);
}

async function assertHead(deps: SweDeps, repo: string, commit: string): Promise<void> {
  const head = (await deps.execFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  if (head !== commit) throw new Error(`Repo checkout mismatch: expected ${commit}, got ${head}`);
}

async function ensureCleanWorktree(deps: SweDeps, worktree: string): Promise<void> {
  const status = await deps.execFile("git", ["status", "--short"], { cwd: worktree });
  if (status.stdout.trim()) throw new Error(`Fresh SWE worktree is not clean:\n${status.stdout}`);
}

async function newestSessionJsonl(sessionDir: string): Promise<string> {
  const files = await collectFiles(sessionDir);
  const jsonl = files.filter((file) => file.endsWith(".jsonl")).sort();
  if (jsonl.length === 0) throw new Error(`No Pi session JSONL found under ${sessionDir}`);
  return jsonl.at(-1)!;
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  }));
  return nested.flat();
}

async function latestModeRun(root: string, instanceId: string, mode: SweMode): Promise<{ runId: string; dir: string } | null> {
  const instanceRoot = join(root, instanceId);
  const runIds = (await readdir(instanceRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const runId of runIds) {
    const dir = join(instanceRoot, runId, mode);
    if (existsSync(join(dir, "final.diff"))) return { runId, dir };
  }
  return null;
}

function githubRepoUrl(repo: string): string {
  if (/^https?:\/\//.test(repo)) return repo;
  return `https://github.com/${repo}.git`;
}

function modelLabel(mode: SweMode, model: string): string {
  const clean = model.replace(/^openai\//, "").replace(/[^A-Za-z0-9_.-]+/g, "-");
  return mode === "stock" ? `pi-stock-${clean}` : `pi-sydes-${clean}`;
}

function repoFolderName(repo: string): string {
  return basename(repo.replace(/\.git$/, "")) || "repo";
}

function parseMode(mode: string): SweMode {
  if (mode === "stock" || mode === "sydes") return mode;
  return "" as SweMode;
}

function parseSydesIntegrationMode(value: string | undefined): SydesIntegrationMode | undefined {
  if (value === undefined) return undefined;
  if (value === "graph-guidance" || value === "tool-middleware") return value;
  throw new Error("--sydes-integration-mode must be graph-guidance or tool-middleware");
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function requestPacingMetadata(options: SweRunOptions): Record<string, unknown> {
  return {
    enabled: options.modelCallMinIntervalMs > 0,
    minIntervalMs: options.modelCallMinIntervalMs
  };
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error(`SWE row missing ${key}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function redactEvalScript(value: string | undefined): string | undefined {
  return value ? "[redacted: official eval script is retained upstream]" : undefined;
}

function arrayField(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuote(values: string[]): string {
  return values.map(shellEscape).join(" ");
}
