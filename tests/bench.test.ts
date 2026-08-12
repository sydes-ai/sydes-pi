import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL,
  buildBenchPiCommand,
  parseBenchArgs,
  runBench,
  type BenchDeps,
  type BenchOptions
} from "../scripts/bench.js";
import { analyzeSession } from "../src/telemetry/session-analyzer.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("benchmark runner", () => {
  it("refuses paid runs without --confirm-paid-run", async () => {
    const options = await makeOptions({ dryRun: false, confirmPaidRun: false });
    const deps = makeDeps(options);
    await expect(runBench(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("dry-run checks through preflight but never launches Pi generation", async () => {
    const options = await makeOptions({ mode: "stock", dryRun: true, confirmPaidRun: false, env: {} });
    const deps = makeDeps(options);
    await expect(runBench(options, deps)).resolves.toBe(0);
    expect(deps.spawnPi).not.toHaveBeenCalled();
    expect(deps.execFile).not.toHaveBeenCalledWith(options.piBin, ["--list-models", DEFAULT_MODEL], expect.anything());
  });

  it("builds stock mode without Sydes and sydes mode with the extension", async () => {
    const options = await makeOptions();
    const manifest = manifestFor(options);
    const stock = buildBenchPiCommand({ ...options, mode: "stock" }, manifest, "/tmp/run/stock");
    const sydes = buildBenchPiCommand({ ...options, mode: "sydes" }, manifest, "/tmp/run/sydes");
    expect(stock.args).toContain("--no-extensions");
    expect(stock.args).not.toContain("--extension");
    expect(sydes.args).toContain("--no-extensions");
    expect(sydes.args).toContain("--extension");
    expect(sydes.args).toContain(options.extensionPath);
    expect(stock.args).toContain(manifest.taskPrompt);
    expect(sydes.args).toContain(manifest.taskPrompt);
    expect(stock.args.slice(0, 2)).toEqual(["--model", DEFAULT_MODEL]);
    expect(sydes.args.slice(0, 2)).toEqual(["--model", DEFAULT_MODEL]);
  });

  it("uses a fresh clone and never runs commands in the source repo", async () => {
    const options = await makeOptions({ mode: "stock", dryRun: true, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options);
    await runBench(options, deps);
    expect(deps.execFile).toHaveBeenCalledWith("git", ["clone", "--quiet", optionsSource(options), expect.any(String)]);
    expect(deps.execFile).toHaveBeenCalledWith("git", ["checkout", "--quiet", manifestFor(options).baseCommit], expect.anything());
    for (const call of vi.mocked(deps.execFile).mock.calls) {
      expect(call[2]?.cwd).not.toBe(optionsSource(options));
    }
  });

  it("aborts before paid launch when pre-tests fail", async () => {
    const options = await makeOptions({ dryRun: false, confirmPaidRun: true, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { failPreTests: true });
    await expect(runBench(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("requires non-empty Sydes preflight before paid launch", async () => {
    const options = await makeOptions({ mode: "sydes", dryRun: false, confirmPaidRun: true, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { emptyContext: true });
    await expect(runBench(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();
  });

  it("does not retry failed Pi runs", async () => {
    const options = await makeOptions({ mode: "stock", dryRun: false, confirmPaidRun: true, env: { OPENAI_API_KEY: "set" } });
    const deps = makeDeps(options, { piExit: 1 });
    await expect(runBench(options, deps)).resolves.toBe(1);
    expect(deps.spawnPi).toHaveBeenCalledTimes(1);
  });

  it("records same prompt model and base commit across modes", async () => {
    const stock = await makeOptions({ mode: "stock", dryRun: false, confirmPaidRun: true, runId: "same", env: { OPENAI_API_KEY: "set" } });
    const sydes = { ...stock, mode: "sydes" as const };
    const stockDeps = makeDeps(stock);
    const sydesDeps = makeDeps(sydes);
    await expect(runBench(stock, stockDeps)).resolves.toBe(0);
    await expect(runBench(sydes, sydesDeps)).resolves.toBe(0);
    const stockRun = JSON.parse(await readArtifact(stock, "run.json", "stock"));
    const sydesRun = JSON.parse(await readArtifact(sydes, "run.json", "sydes"));
    expect(stockRun.taskPrompt).toBe(sydesRun.taskPrompt);
    expect(stockRun.model).toBe(sydesRun.model);
    expect(stockRun.baseCommit).toBe(sydesRun.baseCommit);
    expect(stockRun.worktree).not.toBe(sydesRun.worktree);
  });

  it("parses benchmark guard flags", () => {
    const options = parseBenchArgs(["--task", "pokemon-hp-zero", "--mode", "sydes", "--confirm-paid-run"], { HOME: "/tmp/home" });
    expect(options.taskId).toBe("pokemon-hp-zero");
    expect(options.mode).toBe("sydes");
    expect(options.confirmPaidRun).toBe(true);
  });
});

describe("stock session analyzer compatibility", () => {
  it("analyzes a session without Sydes telemetry", async () => {
    const root = await mkdtemp(join(tmpdir(), "sydes-stock-analyzer-"));
    tempRoots.push(root);
    const sessionPath = join(root, "session.jsonl");
    const runJsonPath = join(root, "run.json");
    const diffPath = join(root, "final.diff");
    const repoTestsPath = join(root, "repo-tests.txt");
    const oraclePath = join(root, "oracle.txt");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ message: { role: "assistant", content: [{ toolCallId: "1", name: "read", args: { path: join(root, "pkg/handler/pokedex.go") } }] }, timestamp: "2026-08-11T00:00:01Z" }),
        JSON.stringify({ message: { toolCallId: "1", toolName: "read", isError: false, content: "ok" }, timestamp: "2026-08-11T00:00:02Z" }),
        JSON.stringify({ message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 5, totalCost: 0.01 }, content: [{ toolCallId: "2", name: "edit", args: { path: join(root, "pkg/handler/pokedex.go") } }] }, timestamp: "2026-08-11T00:00:03Z" }),
        JSON.stringify({ message: { toolCallId: "2", toolName: "edit", isError: false, content: "ok" }, timestamp: "2026-08-11T00:00:04Z" })
      ].join("\n") + "\n"
    );
    await writeFile(runJsonPath, JSON.stringify({ startTime: "2026-08-11T00:00:00Z", endTime: "2026-08-11T00:00:10Z" }));
    await writeFile(diffPath, "diff --git a/pkg/handler/pokedex.go b/pkg/handler/pokedex.go\n+added\n");
    await writeFile(repoTestsPath, "REPO_TESTS=PASS\n");
    await writeFile(oraclePath, "TASK_CORRECTNESS=PASS\n");
    const summary = await analyzeSession({
      sessionPath,
      repoRoot: root,
      sydesPath: join(root, "missing-sydes.json"),
      runJsonPath,
      finalDiffPath: diffPath,
      repoTestsPath,
      oraclePath,
      outputPath: join(root, "summary.json")
    });
    expect((summary as any).correctness.taskCorrectness).toBe("PASS");
    expect((summary as any).sydes.impactGuidanceCount).toBe(0);
    expect((summary as any).tools.total).toBe(2);
  });
});

async function makeOptions(overrides: Partial<BenchOptions> = {}): Promise<BenchOptions> {
  const root = await mkdtemp(join(tmpdir(), "sydes-bench-test-"));
  tempRoots.push(root);
  const manifestsDir = join(root, "manifests");
  const sourceRepo = join(root, "source");
  await mkdir(manifestsDir, { recursive: true });
  await mkdir(sourceRepo, { recursive: true });
  await writeFile(join(manifestsDir, "pokemon-hp-zero.json"), `${JSON.stringify({
    id: "pokemon-hp-zero",
    sourceRepo,
    baseCommit: "abc123",
    taskPrompt: "Fix Pokemon hp zero",
    setupCommand: "",
    preTestCommand: "go test ./...",
    oracleCommand: "python3 /tmp/oracle.py --repo {repo}",
    language: "go",
    framework: "gin"
  })}\n`);
  return {
    taskId: "pokemon-hp-zero",
    mode: "sydes",
    dryRun: false,
    confirmPaidRun: true,
    model: DEFAULT_MODEL,
    manifestsDir,
    artifactsRoot: join(root, "artifacts"),
    piBin: "/tmp/pi",
    extensionPath: resolve("src/index.ts"),
    cbmBin: "/tmp/cbm",
    ...overrides,
    env: { HOME: root, OPENAI_API_KEY: "set", ...(overrides.env ?? {}) }
  };
}

function makeDeps(
  options: BenchOptions,
  behavior: { failPreTests?: boolean; emptyContext?: boolean; piExit?: number } = {}
): BenchDeps {
  let indexedRoot = "";
  let searchCalls = 0;
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
    searchGraphByArgs: vi.fn(async () => {
      searchCalls += 1;
      const rows = behavior.emptyContext && searchCalls > 1
        ? []
        : [["fresh.pkg.handler.addPokemon", "Function", "pkg/handler/pokedex.go", "10:20"]];
      return {
        parsed: {
          structuredContent: { cols: ["qn", "label", "file", "lines"], rows, total: rows.length }
        }
      };
    }),
    searchCode: vi.fn(async () => ({ parsed: { structuredContent: { results: [] } } })),
    tracePath: vi.fn(async () => ({ parsed: { structuredContent: { paths: [] } } })),
    close: vi.fn(),
    processStartCount: 0,
    transportKind: "test"
  };
  const execMock = vi.fn(async (command: string, args: string[], execOptions?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    if (command === "git" && args[0] === "clone") {
      await mkdir(args[3], { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "status") return { stdout: "", stderr: "" };
    if (command === "git" && args[0] === "diff") return { stdout: "diff --git a/a.go b/a.go\n+ok\n", stderr: "" };
    if (command === "/bin/bash" && args[1]?.includes("go test") && behavior.failPreTests) {
      const error: any = new Error("tests failed");
      error.code = 1;
      error.stdout = "fail";
      error.stderr = "";
      throw error;
    }
    if (command === options.piBin && args[0] === "--list-models") return { stdout: "model\n", stderr: "" };
    return { stdout: "", stderr: "", cwd: execOptions?.cwd };
  });
  return {
    execFile: execMock as never,
    spawnPi: vi.fn(async (_command: string, args: string[]) => {
      const sessionDir = args[args.indexOf("--session-dir") + 1];
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "session.jsonl"), `${JSON.stringify({ message: { role: "assistant" } })}\n`);
      return behavior.piExit ?? 0;
    }),
    makeCbmClient: () => cbm as never,
    analyze: vi.fn(async (input) => {
      await writeFile(input.outputPath, "{}\n");
      return {};
    })
  };
}

function manifestFor(options: BenchOptions) {
  return {
    id: options.taskId,
    sourceRepo: optionsSource(options),
    baseCommit: "abc123",
    taskPrompt: "Fix Pokemon hp zero",
    setupCommand: "",
    preTestCommand: "go test ./...",
    oracleCommand: "python3 /tmp/oracle.py --repo {repo}"
  };
}

function optionsSource(options: BenchOptions): string {
  return join(options.env.HOME ?? "", "source");
}

async function readArtifact(options: BenchOptions, file: string, mode: "stock" | "sydes"): Promise<string> {
  return await import("node:fs/promises").then((fs) => fs.readFile(join(options.artifactsRoot, options.taskId, options.runId ?? "", mode, file), "utf8"));
}
