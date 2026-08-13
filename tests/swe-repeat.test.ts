import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSweRepeatArgs, runSweRepeat, type SweRepeatDeps, type SweRepeatOptions } from "../src/benchmark/swe-repeat.js";
import { DEFAULT_MODEL, SWE_MAX_OUTPUT_TOKENS, SWE_THINKING_LEVEL, type SweRunOptions } from "../src/benchmark/swebench.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("SWE-bench repeat runner", () => {
  it("iterates pilot instances with the requested additional attempts in deterministic stock/sydes order", async () => {
    const options = await makeOptions({ attempts: 2, delaySeconds: 0 });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).resolves.toBe(0);
    expect(deps.runOne).toHaveBeenCalledTimes(8);
    expect(calls(deps)).toEqual([
      ["repo__one-1", "stock", "20260813T140422Z-swe-repeat-attempt-2-repo__one-1"],
      ["repo__one-1", "sydes", "20260813T140422Z-swe-repeat-attempt-2-repo__one-1"],
      ["repo__one-1", "stock", "20260813T140422Z-swe-repeat-attempt-3-repo__one-1"],
      ["repo__one-1", "sydes", "20260813T140422Z-swe-repeat-attempt-3-repo__one-1"],
      ["repo__two-2", "stock", "20260813T140422Z-swe-repeat-attempt-2-repo__two-2"],
      ["repo__two-2", "sydes", "20260813T140422Z-swe-repeat-attempt-2-repo__two-2"],
      ["repo__two-2", "stock", "20260813T140422Z-swe-repeat-attempt-3-repo__two-2"],
      ["repo__two-2", "sydes", "20260813T140422Z-swe-repeat-attempt-3-repo__two-2"]
    ]);
  });

  it("uses unique paired run IDs for each instance attempt", async () => {
    const options = await makeOptions({ attempts: 2, delaySeconds: 0 });
    const deps = makeDeps();
    await runSweRepeat(options, deps);
    const runIds = calls(deps).map((call) => call[2]);
    expect(new Set(runIds).size).toBe(4);
    expect(runIds[0]).toBe(runIds[1]);
    expect(runIds[2]).toBe(runIds[3]);
    expect(runIds[0]).not.toBe(runIds[2]);
  });

  it("sleeps between paid model calls but not after the final call", async () => {
    const options = await makeOptions({ attempts: 1, delaySeconds: 7 });
    const deps = makeDeps();
    await runSweRepeat(options, deps);
    expect(deps.runOne).toHaveBeenCalledTimes(4);
    expect(deps.sleep).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledWith(7000);
  });

  it("supports custom delay parsing", () => {
    const parsed = parseSweRepeatArgs(["--pilot", "benchmarks/swebench/pilot.json", "--attempts", "2", "--delay-seconds", "12", "--dry-run"], { HOME: "/tmp/home" });
    expect(parsed.attempts).toBe(2);
    expect(parsed.delaySeconds).toBe(12);
    expect(parsed.dryRun).toBe(true);
  });

  it("requires paid confirmation outside dry-run", async () => {
    const options = await makeOptions({ confirmPaidRuns: false, dryRun: false });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).resolves.toBe(1);
    expect(deps.runOne).not.toHaveBeenCalled();
  });

  it("dry-run prints the full plan and makes zero model calls", async () => {
    const options = await makeOptions({ attempts: 2, dryRun: true, confirmPaidRuns: false, delaySeconds: 90 });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).resolves.toBe(0);
    expect(deps.runOne).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(logs(deps)).toContain("Instances: 2");
    expect(logs(deps)).toContain("Additional paired attempts per instance: 2");
    expect(logs(deps)).toContain(`Model: ${DEFAULT_MODEL}`);
    expect(logs(deps)).toContain(`Thinking: ${SWE_THINKING_LEVEL}`);
    expect(logs(deps)).toContain(`Max output tokens: ${SWE_MAX_OUTPUT_TOKENS}`);
    expect(logs(deps)).toContain("Planned mode calls: 8");
    expect(logs(deps)).toContain("Paid model calls planned: 8");
    expect(logs(deps)).toContain("Paid model calls started: 0");
  });

  it("stops on infrastructure failure without retrying or consuming the next call", async () => {
    const options = await makeOptions({ attempts: 2, delaySeconds: 0 });
    const deps = makeDeps({ exitCodes: [0, 1, 0, 0] });
    await expect(runSweRepeat(options, deps)).resolves.toBe(1);
    expect(deps.runOne).toHaveBeenCalledTimes(2);
    expect(calls(deps).map((call) => call.slice(0, 2))).toEqual([
      ["repo__one-1", "stock"],
      ["repo__one-1", "sydes"]
    ]);
    expect(errors(deps)).toContain("Infrastructure failure at instance=repo__one-1 attempt=2 mode=sydes; stopping without retry.");
  });

  it("writes compact per-mode repeat status artifacts", async () => {
    const options = await makeOptions({ attempts: 1, delaySeconds: 0 });
    const deps = makeDeps();
    await runSweRepeat(options, deps);
    const statusPath = join(options.env.HOME!, ".sydes-pi/swebench/repo__one-1/20260813T140422Z-swe-repeat-attempt-2-repo__one-1/stock/repeat-status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    expect(status).toMatchObject({
      pilotName: "fixture-pilot",
      instanceId: "repo__one-1",
      attempt: 2,
      mode: "stock",
      status: "success",
      exitCode: 0
    });
  });

  it("resumes at a stock start position and omits earlier calls", async () => {
    const options = await makeOptions({
      attempts: 2,
      delaySeconds: 0,
      startInstance: "repo__one-1",
      startAttempt: 3,
      startMode: "stock"
    });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).resolves.toBe(0);
    expect(calls(deps)).toEqual([
      ["repo__one-1", "stock", "20260813T140422Z-swe-repeat-attempt-3-repo__one-1"],
      ["repo__one-1", "sydes", "20260813T140422Z-swe-repeat-attempt-3-repo__one-1"],
      ["repo__two-2", "stock", "20260813T140422Z-swe-repeat-attempt-2-repo__two-2"],
      ["repo__two-2", "sydes", "20260813T140422Z-swe-repeat-attempt-2-repo__two-2"],
      ["repo__two-2", "stock", "20260813T140422Z-swe-repeat-attempt-3-repo__two-2"],
      ["repo__two-2", "sydes", "20260813T140422Z-swe-repeat-attempt-3-repo__two-2"]
    ]);
  });

  it("resumes at a sydes start position and keeps later ordering unchanged", async () => {
    const options = await makeOptions({
      attempts: 2,
      delaySeconds: 0,
      startInstance: "repo__one-1",
      startAttempt: 2,
      startMode: "sydes"
    });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).resolves.toBe(0);
    expect(calls(deps).map((call) => call.slice(0, 2))).toEqual([
      ["repo__one-1", "sydes"],
      ["repo__one-1", "stock"],
      ["repo__one-1", "sydes"],
      ["repo__two-2", "stock"],
      ["repo__two-2", "sydes"],
      ["repo__two-2", "stock"],
      ["repo__two-2", "sydes"]
    ]);
  });

  it("gives a resumed infrastructure failure a fresh run ID from the new invocation", async () => {
    const first = await makeOptions({ attempts: 2, delaySeconds: 0 });
    const firstDeps = makeDeps();
    await runSweRepeat(first, firstDeps);
    const resumed = await makeOptions({
      attempts: 2,
      delaySeconds: 0,
      startInstance: "repo__one-1",
      startAttempt: 3,
      startMode: "stock"
    });
    const resumedDeps = makeDeps({ now: new Date("2026-08-13T15:00:00Z") });
    await runSweRepeat(resumed, resumedDeps);
    expect(calls(resumedDeps)[0]).toEqual(["repo__one-1", "stock", "20260813T150000Z-swe-repeat-attempt-3-repo__one-1"]);
    expect(calls(resumedDeps)[0][2]).not.toBe(calls(firstDeps)[2][2]);
  });

  it("fails invalid start instance before any model call", async () => {
    const options = await makeOptions({ attempts: 2, startInstance: "missing__repo-1", startAttempt: 3, startMode: "stock" });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).rejects.toThrow("Start instance is not in pilot: missing__repo-1");
    expect(deps.runOne).not.toHaveBeenCalled();
  });

  it("fails invalid start attempt before any model call", async () => {
    const options = await makeOptions({ attempts: 2, startInstance: "repo__one-1", startAttempt: 4, startMode: "stock" });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).rejects.toThrow("Start attempt must be one of: 2, 3");
    expect(deps.runOne).not.toHaveBeenCalled();
  });

  it("fails invalid start mode while parsing", () => {
    expect(() => parseSweRepeatArgs(["--start-instance", "repo__one-1", "--start-attempt", "3", "--start-mode", "both"])).toThrow("--start-mode must be stock or sydes");
  });

  it("requires all start position arguments together", async () => {
    const options = await makeOptions({ attempts: 2, startInstance: "repo__one-1", startAttempt: 3 });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).rejects.toThrow("Resume requires --start-instance, --start-attempt, and --start-mode together.");
    expect(deps.runOne).not.toHaveBeenCalled();
  });

  it("dry-run supports resume and makes zero model calls", async () => {
    const options = await makeOptions({
      attempts: 2,
      dryRun: true,
      confirmPaidRuns: false,
      startInstance: "repo__one-1",
      startAttempt: 3,
      startMode: "stock"
    });
    const deps = makeDeps();
    await expect(runSweRepeat(options, deps)).resolves.toBe(0);
    expect(deps.runOne).not.toHaveBeenCalled();
    expect(logs(deps)).toContain("Start position: repo__one-1 attempt 3 stock");
    expect(logs(deps)).toContain("Planned mode calls: 6");
    expect(logs(deps)).toContain("Paid model calls started: 0");
  });
});

async function makeOptions(overrides: Partial<SweRepeatOptions> = {}): Promise<SweRepeatOptions> {
  const root = await tempRoot();
  const pilotPath = join(root, "pilot.json");
  await mkdir(root, { recursive: true });
  await writeFile(pilotPath, `${JSON.stringify({ name: "fixture-pilot", instances: ["repo__one-1", { instance_id: "repo__two-2" }] })}\n`);
  return {
    pilotPath,
    attempts: 1,
    delaySeconds: 0,
    dryRun: false,
    confirmPaidRuns: true,
    env: { HOME: root, OPENAI_API_KEY: "set" },
    ...overrides
  };
}

function makeDeps(behavior: { exitCodes?: number[]; now?: Date } = {}): SweRepeatDeps {
  const exitCodes = [...(behavior.exitCodes ?? [])];
  return {
    runOne: vi.fn(async () => exitCodes.shift() ?? 0),
    sleep: vi.fn(async () => undefined),
    now: () => behavior.now ?? new Date("2026-08-13T14:04:22Z"),
    log: vi.fn(),
    error: vi.fn()
  };
}

function calls(deps: SweRepeatDeps): Array<[string, string, string]> {
  return vi.mocked(deps.runOne).mock.calls.map(([options]) => {
    const run = options as SweRunOptions;
    return [run.instanceId, run.mode, run.runId!];
  });
}

function logs(deps: SweRepeatDeps): string {
  return vi.mocked(deps.log).mock.calls.map(([message]) => message).join("\n");
}

function errors(deps: SweRepeatDeps): string {
  return vi.mocked(deps.error).mock.calls.map(([message]) => message).join("\n");
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sydes-swe-repeat-test-"));
  tempRoots.push(root);
  return root;
}
