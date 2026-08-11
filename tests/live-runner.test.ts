import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_COMMIT,
  buildPiCommand,
  parseArgs,
  runLiveSydes,
  type LiveRunnerDeps,
  type LiveRunnerOptions
} from "../scripts/run-live-sydes.js";
import type { RelevantContext } from "../src/policy/types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("live Sydes runner", () => {
  it("refuses without --confirm-paid-run", async () => {
    const options = await makeOptions({ confirmPaidRun: false, dryRun: false });
    const deps = makeDeps(options);
    await expect(runLiveSydes(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("dry-run never launches Pi generation", async () => {
    const options = await makeOptions({ confirmPaidRun: false, dryRun: true, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options);
    await expect(runLiveSydes(options, deps)).resolves.toBe(0);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("aborts paid launch when preflight context is empty", async () => {
    const options = await makeOptions({ confirmPaidRun: true, dryRun: false, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { context: fakeContext({ entryPoints: [], files: [] }) });
    await expect(runLiveSydes(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("aborts paid launch when OPENAI_API_KEY is missing", async () => {
    const options = await makeOptions({ confirmPaidRun: true, dryRun: false, env: {} });
    const deps = makeDeps(options);
    await expect(runLiveSydes(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("aborts paid launch when the model list check fails", async () => {
    const options = await makeOptions({ confirmPaidRun: true, dryRun: false, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { failModelList: true });
    await expect(runLiveSydes(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("aborts before paid launch when pre-run tests fail", async () => {
    const options = await makeOptions({ confirmPaidRun: true, dryRun: false, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { failPreTests: true });
    await expect(runLiveSydes(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("does not retry a failed paid invocation", async () => {
    const options = await makeOptions({ confirmPaidRun: true, dryRun: false, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { piExit: 1 });
    await expect(runLiveSydes(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).toHaveBeenCalledTimes(1);
  });

  it("uses text mode rather than giant Pi JSON capture", async () => {
    const options = await makeOptions({ confirmPaidRun: true, dryRun: false });
    const command = buildPiCommand(options, "/tmp/worktree", "/tmp/run");
    expect(command.args).toContain("--mode");
    expect(command.args).toContain("text");
    expect(command.args).not.toContain("json");
  });

  it("checks out the exact base commit and does not run commands inside the source repo", async () => {
    const options = await makeOptions({ confirmPaidRun: false, dryRun: true, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options);
    await runLiveSydes(options, deps);
    expect(deps.execFile).toHaveBeenCalledWith("git", ["checkout", "--quiet", BASE_COMMIT], expect.anything());
    for (const call of vi.mocked(deps.execFile).mock.calls) {
      expect(call[2]?.cwd).not.toBe(options.sourceRepo);
    }
  });

  it("parses the explicit manual guard flags", () => {
    expect(parseArgs(["--confirm-paid-run"], { HOME: "/tmp/home" }).confirmPaidRun).toBe(true);
    expect(parseArgs(["--dry-run"], { HOME: "/tmp/home" }).dryRun).toBe(true);
  });
});

async function makeOptions(overrides: Partial<LiveRunnerOptions> = {}): Promise<LiveRunnerOptions> {
  const root = await mkdtemp(join(tmpdir(), "sydes-live-runner-test-"));
  tempRoots.push(root);
  const sourceRepo = join(root, "source");
  const oraclePath = join(root, "oracle.py");
  await mkdir(sourceRepo, { recursive: true });
  await writeFile(oraclePath, "print('oracle')\n");
  return {
    confirmPaidRun: true,
    dryRun: false,
    sourceRepo,
    oraclePath,
    piBin: "/tmp/pi",
    extensionPath: resolve("src/index.ts"),
    cbmBin: "/tmp/cbm",
    runsRoot: join(root, "runs"),
    ...overrides,
    env: { HOME: root, ...(overrides.env ?? {}) }
  };
}

function makeDeps(
  options: LiveRunnerOptions,
  behavior: {
    context?: RelevantContext | null;
    failModelList?: boolean;
    failPreTests?: boolean;
    piExit?: number;
  } = {}
): LiveRunnerDeps {
  let indexedRoot = "";
  const cbm = {
    listProjects: vi.fn(async () => ({
      parsed: { structuredContent: { projects: indexedRoot ? [{ name: "fresh", root_path: indexedRoot }] : [] } }
    })),
    indexRepository: vi.fn(async (repoPath: string) => {
      indexedRoot = repoPath;
      return { parsed: { structuredContent: { project: "fresh" } } };
    }),
    indexStatus: vi.fn(async () => ({
      parsed: { structuredContent: { project: "fresh", status: "ready", nodes: 10, edges: 20, root_path: indexedRoot } }
    })),
    searchGraphByArgs: vi.fn(async () => ({
      parsed: { structuredContent: { cols: ["qn"], rows: [["fresh.pkg.handler.addPokemon"]], total: 1 } }
    })),
    close: vi.fn()
  };
  const execMock = vi.fn(async (command: string, args: string[], execOptions?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    if (command === "git" && args[0] === "clone") {
      await mkdir(args[3], { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (command === "go" && args[0] === "test" && behavior.failPreTests) {
      throw new Error("pre-test failure");
    }
    if (command === options.piBin && args[0] === "--list-models" && behavior.failModelList) {
      throw new Error("model unavailable");
    }
    if (command === "git" && args[0] === "status") {
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "", cwd: execOptions?.cwd };
  });
  return {
    execFile: execMock as never,
    spawnPi: vi.fn(async () => behavior.piExit ?? 0),
    makeCbmClient: () => cbm as never,
    buildContext: vi.fn(async () => behavior.context ?? fakeContext()),
    analyze: vi.fn(async () => ({})),
    now: () => 0
  };
}

function fakeContext(overrides: Partial<RelevantContext> = {}): RelevantContext {
  return {
    project: "fresh",
    task: "POST /api/v1/pokemon hp=0",
    projectReadinessWaitMs: 0,
    projectReadinessPollCount: 1,
    projectReadinessStrategy: "index_status+probe",
    entryPoints: [{ name: "addPokemon", qualifiedName: "fresh.pkg.handler.addPokemon", kind: "Method", filePath: "pkg/handler/pokedex.go" }],
    relatedSymbols: [],
    files: ["pkg/handler/pokedex.go"],
    tests: ["pkg/handler/pokedex_test.go"],
    relationships: [],
    querySummary: { queryCount: 1, elapsedMs: 1 },
    ...overrides
  };
}
