import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_MODEL, parseSweArgs, runSweBench, type SweMode, type SweRunOptions } from "./swebench.js";

export interface SweRepeatOptions {
  pilotPath: string;
  attempts: number;
  delaySeconds: number;
  dryRun: boolean;
  confirmPaidRuns: boolean;
  startInstance?: string;
  startAttempt?: number;
  startMode?: SweMode;
  env: NodeJS.ProcessEnv;
}

export interface SweRepeatDeps {
  runOne: typeof runSweBench;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
  error: (message: string) => void;
}

interface SwePilot {
  name: string;
  instances: string[];
}

interface PlannedCall {
  pilotName: string;
  instanceId: string;
  attempt: number;
  runId: string;
  mode: SweMode;
  artifactPath: string;
}

export function parseSweRepeatArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SweRepeatOptions {
  const pilotPath = valueAfter(argv, "--pilot") ?? valueWithPrefix(argv, "--pilot=") ?? "benchmarks/swebench/pilot.json";
  const attemptsText = valueAfter(argv, "--attempts") ?? valueWithPrefix(argv, "--attempts=") ?? "1";
  const delayText = valueAfter(argv, "--delay-seconds") ?? valueWithPrefix(argv, "--delay-seconds=") ?? "90";
  const startInstance = valueAfter(argv, "--start-instance") ?? valueWithPrefix(argv, "--start-instance=");
  const startAttemptText = valueAfter(argv, "--start-attempt") ?? valueWithPrefix(argv, "--start-attempt=");
  const startModeText = valueAfter(argv, "--start-mode") ?? valueWithPrefix(argv, "--start-mode=");
  return {
    pilotPath: resolve(pilotPath),
    attempts: parseNonNegativeInt(attemptsText, "--attempts"),
    delaySeconds: parseNonNegativeNumber(delayText, "--delay-seconds"),
    dryRun: argv.includes("--dry-run"),
    confirmPaidRuns: argv.includes("--confirm-paid-runs"),
    startInstance,
    startAttempt: startAttemptText === undefined ? undefined : parseNonNegativeInt(startAttemptText, "--start-attempt"),
    startMode: startModeText === undefined ? undefined : parseStartMode(startModeText),
    env
  };
}

export async function runSweRepeat(options: SweRepeatOptions, deps: SweRepeatDeps = defaultDeps()): Promise<number> {
  if (!options.dryRun && !options.confirmPaidRuns) {
    deps.error("Refusing to start repeated paid SWE-bench runs.");
    deps.error("swe:repeat will make paired paid model calls. Re-run with --confirm-paid-runs.");
    return 1;
  }

  const pilot = await readPilot(options.pilotPath);
  const allPlanned = planRepeatCalls(options, pilot, deps.now());
  const planned = applyStartPosition(allPlanned, options);
  deps.log(`SWE repeat pilot: ${pilot.name}`);
  deps.log(`Instances: ${pilot.instances.length}`);
  deps.log(`Additional paired attempts per instance: ${options.attempts}`);
  if (hasStartPosition(options)) {
    deps.log(`Start position: ${options.startInstance} attempt ${options.startAttempt} ${options.startMode}`);
  }
  deps.log(`Planned mode calls: ${planned.length}`);
  deps.log(`Paid model calls planned: ${planned.length}`);
  if (options.dryRun) deps.log("Paid model calls started: 0");
  deps.log(`Delay between paid model calls: ${options.delaySeconds}s`);

  if (planned.length === 0) {
    deps.log("No SWE repeat calls planned.");
    return 0;
  }

  deps.log("Execution order:");
  for (const [index, call] of planned.entries()) {
    deps.log(`${index + 1}. ${call.instanceId} attempt ${call.attempt} ${call.mode} run ${call.runId} artifacts ${call.artifactPath}`);
  }

  if (options.dryRun) {
    deps.log("Dry run complete before Pi generation.");
    return 0;
  }

  for (const [index, call] of planned.entries()) {
    deps.log(`Starting ${call.instanceId} attempt ${call.attempt} ${call.mode} run ${call.runId}`);
    const result = await deps.runOne(buildRunOptions(options, call));
    const status = result === 0 ? "success" : "infrastructure_failed";
    await writeAttemptStatus(call.artifactPath, call, status, result);
    deps.log(`Result ${call.instanceId} attempt ${call.attempt} ${call.mode}: ${status} artifacts ${call.artifactPath}`);
    if (result !== 0) {
      deps.error(`Infrastructure failure at instance=${call.instanceId} attempt=${call.attempt} mode=${call.mode}; stopping without retry.`);
      return result;
    }
    if (index < planned.length - 1 && options.delaySeconds > 0) {
      deps.log(`Sleeping ${options.delaySeconds}s before next paid model call.`);
      await deps.sleep(options.delaySeconds * 1000);
    }
  }
  return 0;
}

function buildRunOptions(options: SweRepeatOptions, call: PlannedCall): SweRunOptions {
  const base = parseSweArgs(["--instance", call.instanceId, "--mode", call.mode, "--run-id", call.runId], options.env);
  return {
    ...base,
    model: DEFAULT_MODEL,
    mode: call.mode,
    dryRun: false,
    confirmPaidRun: true,
    runId: call.runId,
    manifestsDir: dirname(options.pilotPath)
  };
}

function planRepeatCalls(options: SweRepeatOptions, pilot: SwePilot, start: Date): PlannedCall[] {
  const calls: PlannedCall[] = [];
  const baseRunId = start.toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z-swe-repeat");
  const artifactsRoot = resolve(options.env.HOME ?? homedir(), ".sydes-pi/swebench");
  for (const instanceId of pilot.instances) {
    for (let offset = 0; offset < options.attempts; offset += 1) {
      const attempt = offset + 2;
      const runId = `${baseRunId}-attempt-${attempt}-${safeId(instanceId)}`;
      for (const mode of ["stock", "sydes"] as const) {
        calls.push({
          pilotName: pilot.name,
          instanceId,
          attempt,
          runId,
          mode,
          artifactPath: join(artifactsRoot, instanceId, runId, mode)
        });
      }
    }
  }
  return calls;
}

function applyStartPosition(calls: PlannedCall[], options: SweRepeatOptions): PlannedCall[] {
  if (!hasStartPosition(options)) return calls;
  if (!options.startInstance || options.startAttempt === undefined || !options.startMode) {
    throw new Error("Resume requires --start-instance, --start-attempt, and --start-mode together.");
  }
  const index = calls.findIndex((call) => (
    call.instanceId === options.startInstance
    && call.attempt === options.startAttempt
    && call.mode === options.startMode
  ));
  if (index < 0) {
    const instances = new Set(calls.map((call) => call.instanceId));
    if (!instances.has(options.startInstance)) throw new Error(`Start instance is not in pilot: ${options.startInstance}`);
    const attempts = [...new Set(calls.map((call) => call.attempt))].sort((a, b) => a - b).join(", ");
    if (!calls.some((call) => call.attempt === options.startAttempt)) throw new Error(`Start attempt must be one of: ${attempts || "(none)"}`);
    throw new Error(`Start position is not planned: ${options.startInstance} attempt ${options.startAttempt} ${options.startMode}`);
  }
  return calls.slice(index);
}

function hasStartPosition(options: SweRepeatOptions): boolean {
  return options.startInstance !== undefined || options.startAttempt !== undefined || options.startMode !== undefined;
}

async function writeAttemptStatus(path: string, call: PlannedCall, status: string, exitCode: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "repeat-status.json"), `${JSON.stringify({ ...call, status, exitCode }, null, 2)}\n`);
}

async function readPilot(path: string): Promise<SwePilot> {
  const raw = JSON.parse(await readFile(path, "utf8")) as { name?: unknown; instances?: unknown[] };
  if (typeof raw.name !== "string" || !raw.name) throw new Error(`Pilot manifest missing name: ${path}`);
  const instances = raw.instances ?? [];
  if (!Array.isArray(instances)) throw new Error(`Pilot manifest instances must be an array: ${path}`);
  return {
    name: raw.name,
    instances: instances.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { instance_id?: unknown }).instance_id === "string") {
        return (item as { instance_id: string }).instance_id;
      }
      throw new Error(`Pilot manifest contains an invalid instance entry: ${path}`);
    })
  };
}

function defaultDeps(): SweRepeatDeps {
  return {
    runOne: runSweBench,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: () => new Date(),
    log: (message) => console.log(message),
    error: (message) => console.error(message)
  };
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function parseStartMode(value: string): SweMode {
  if (value === "stock" || value === "sydes") return value;
  throw new Error("--start-mode must be stock or sydes");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function valueWithPrefix(argv: string[], prefix: string): string | undefined {
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
