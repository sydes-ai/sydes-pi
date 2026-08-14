import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL,
  SWE_DATASET,
  SWE_MAX_OUTPUT_TOKENS,
  SWE_PI_AGENT_DIR,
  SWE_THINKING_LEVEL,
  buildGradeCommand,
  buildSwePiCommand,
  buildSwePiEnv,
  buildSweTaskPrompt,
  exportPredictions,
  importSweInstance,
  normalizeSweRow,
  parseOfficialReport,
  parseSweArgs,
  runSweBench,
  type SweDeps,
  type SweRunOptions
} from "../src/benchmark/swebench.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("SWE-bench importer", () => {
  it("reads official fields and drops gold/test patch leakage", async () => {
    const root = await tempRoot();
    const manifest = await importSweInstance({
      instanceId: "apache__druid-13704",
      outputDir: root,
      datasetRevision: "fixture-rev",
      fetchRow: async () => fixtureRow()
    });
    const text = await readFile(join(root, "apache__druid-13704.json"), "utf8");
    expect(manifest).toMatchObject({
      instance_id: "apache__druid-13704",
      dataset: SWE_DATASET,
      datasetRevision: "fixture-rev",
      repo: "apache/druid",
      base_commit: "abc123",
      FAIL_TO_PASS: ["org.apache.druid.SomeTest::testFailure"],
      PASS_TO_PASS: ["org.apache.druid.SomeTest::testPass"],
      image: "sweb.eval.x86_64.apache__druid-13704",
      eval_type: "maven"
    });
    expect(text).not.toContain("gold solution");
    expect(text).not.toContain("hidden test patch");
    expect(text).not.toContain("\"patch\"");
    expect(text).not.toContain("\"test_patch\"");
  });

  it("normalizes official dataset name", () => {
    expect(normalizeSweRow(fixtureRow(), SWE_DATASET).dataset).toBe("SWE-bench/SWE-bench_Multilingual");
  });

  it("preserves the raw official problem statement in the manifest", () => {
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    expect(manifest.problem_statement).toBe("Fix the Druid backend bug.");
    expect(manifest.problem_statement).not.toContain("Implement the requested change");
  });
});

describe("SWE-bench runner", () => {
  it("checks out exact base commit and isolates the source checkout", async () => {
    const options = await makeOptions({ mode: "stock", dryRun: true });
    const deps = makeDeps(options);
    await expect(runSweBench(options, deps)).resolves.toBe(0);
    expect(deps.execFile).toHaveBeenCalledWith("git", ["clone", "--quiet", "--filter=blob:none", "https://github.com/apache/druid.git", expect.any(String)]);
    expect(deps.execFile).toHaveBeenCalledWith("git", ["checkout", "--quiet", "abc123"], expect.anything());
  });

  it("loads no Sydes extension in stock and loads it only in sydes", async () => {
    const options = await makeOptions();
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    const stock = buildSwePiCommand({ ...options, mode: "stock" }, manifest, "/tmp/run/stock");
    const sydes = buildSwePiCommand({ ...options, mode: "sydes" }, manifest, "/tmp/run/sydes");
    expect(stock.args).toContain("--no-extensions");
    expect(stock.args).not.toContain("--extension");
    expect(sydes.args).toContain("--extension");
    expect(sydes.args).toContain(options.extensionPath);
  });

  it("pins the same thinking level for stock and sydes", async () => {
    const options = await makeOptions();
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    const stock = buildSwePiCommand({ ...options, mode: "stock" }, manifest, "/tmp/run/stock");
    const sydes = buildSwePiCommand({ ...options, mode: "sydes" }, manifest, "/tmp/run/sydes");
    expect(stock.args.slice(0, 4)).toEqual(["--model", DEFAULT_MODEL, "--thinking", SWE_THINKING_LEVEL]);
    expect(sydes.args.slice(0, 4)).toEqual(["--model", DEFAULT_MODEL, "--thinking", SWE_THINKING_LEVEL]);
    expect(stock.args[stock.args.indexOf("--thinking") + 1]).toBe("medium");
    expect(sydes.args[sydes.args.indexOf("--thinking") + 1]).toBe("medium");
  });

  it("uses the benchmark-local Pi agent config for both stock and sydes", async () => {
    const options = await makeOptions({ sydesIntegrationMode: "tool-middleware", env: { SYDES_INTEGRATION_MODE: "graph-guidance" } });
    const stockEnv = buildSwePiEnv({ ...options, mode: "stock" }, "/tmp/run/stock", "/tmp/run/stock/pi-sessions");
    const sydesEnv = buildSwePiEnv({ ...options, mode: "sydes" }, "/tmp/run/sydes", "/tmp/run/sydes/pi-sessions");
    expect(stockEnv.PI_CODING_AGENT_DIR).toBe(SWE_PI_AGENT_DIR);
    expect(sydesEnv.PI_CODING_AGENT_DIR).toBe(SWE_PI_AGENT_DIR);
    expect(stockEnv.PI_CODING_AGENT_DIR).toBe(sydesEnv.PI_CODING_AGENT_DIR);
    expect(stockEnv.SYDES_RUN_DIR).toBe("");
    expect(sydesEnv.SYDES_RUN_DIR).toBe("/tmp/run/sydes");
    expect(stockEnv.SYDES_INTEGRATION_MODE).toBeUndefined();
    expect(sydesEnv.SYDES_INTEGRATION_MODE).toBe("tool-middleware");
  });

  it("can select Sydes tool-middleware mode explicitly for benchmark runs", () => {
    const options = parseSweArgs([
      "--instance",
      "apache__druid-13704",
      "--mode",
      "sydes",
      "--sydes-integration-mode",
      "tool-middleware",
      "--confirm-paid-run"
    ], { HOME: "/tmp/home" });
    expect(options.sydesIntegrationMode).toBe("tool-middleware");
  });

  it("configures gpt-5-nano maxTokens in the benchmark-owned Pi models file", async () => {
    const config = JSON.parse(await readFile(join(SWE_PI_AGENT_DIR, "models.json"), "utf8"));
    expect(config).toEqual({
      providers: {
        openai: {
          modelOverrides: {
            "gpt-5-nano": {
              maxTokens: SWE_MAX_OUTPUT_TOKENS
            }
          }
        }
      }
    });
  });

  it("keeps the mode-specific command difference to Sydes extension loading", async () => {
    const options = await makeOptions();
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    const stock = buildSwePiCommand({ ...options, mode: "stock" }, manifest, "/tmp/run/stock");
    const sydes = buildSwePiCommand({ ...options, mode: "sydes" }, manifest, "/tmp/run/sydes");
    const stockBeforeSession = stock.args.slice(0, stock.args.indexOf("--session-dir"));
    const sydesBeforeSession = sydes.args.slice(0, sydes.args.indexOf("--extension"));
    expect(stockBeforeSession).toEqual(sydesBeforeSession);
    expect(sydes.args.slice(sydes.args.indexOf("--extension"), sydes.args.indexOf("--session-dir"))).toEqual(["--extension", options.extensionPath]);
  });

  it("keeps stock and sydes prompts identical with the same model", async () => {
    const options = await makeOptions();
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    const stock = buildSwePiCommand({ ...options, mode: "stock" }, manifest, "/tmp/run/stock");
    const sydes = buildSwePiCommand({ ...options, mode: "sydes" }, manifest, "/tmp/run/sydes");
    expect(stock.prompt).toBe(sydes.prompt);
    expect(stock.args.at(-1)).toBe(stock.prompt);
    expect(sydes.args.at(-1)).toBe(sydes.prompt);
    expect(stock.args.slice(0, 4)).toEqual(["--model", DEFAULT_MODEL, "--thinking", SWE_THINKING_LEVEL]);
    expect(sydes.args.slice(0, 4)).toEqual(["--model", DEFAULT_MODEL, "--thinking", SWE_THINKING_LEVEL]);
  });

  it("wraps the runtime prompt with neutral implementation instructions", async () => {
    const options = await makeOptions();
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    const command = buildSwePiCommand({ ...options, mode: "stock" }, manifest, "/tmp/run/stock");
    expect(command.prompt).toContain("Implement the requested change in the current repository.");
    expect(command.prompt).toContain("Inspect the relevant code, make the necessary file edits, and run relevant tests if feasible.");
    expect(command.prompt).toContain("Do not only explain the solution.");
    expect(command.prompt).toContain("Issue:\nFix the Druid backend bug.");
    expect(command.prompt.endsWith(manifest.problem_statement)).toBe(true);
  });

  it("does not leak gold or test patch content into the wrapped prompt", async () => {
    const options = await makeOptions();
    const manifest = normalizeSweRow(fixtureRow(), SWE_DATASET);
    const command = buildSwePiCommand({ ...options, mode: "sydes" }, manifest, "/tmp/run/sydes");
    expect(command.prompt).not.toContain("gold solution");
    expect(command.prompt).not.toContain("hidden test patch");
  });

  it("builds the exact SWE task prompt template", () => {
    expect(buildSweTaskPrompt("Original issue text.")).toBe(
      [
        "Implement the requested change in the current repository.",
        "",
        "Inspect the relevant code, make the necessary file edits, and run relevant tests if feasible. Do not only explain the solution. Keep the change minimal and focused.",
        "",
        "Issue:",
        "Original issue text."
      ].join("\n")
    );
  });

  it("refuses paid runs without confirmation and never retries", async () => {
    const unconfirmed = await makeOptions({ dryRun: false, confirmPaidRun: false });
    const deps = makeDeps(unconfirmed);
    await expect(runSweBench(unconfirmed, deps)).resolves.toBe(1);
    expect(deps.spawnPi).not.toHaveBeenCalled();

    const failing = await makeOptions({ dryRun: false, confirmPaidRun: true });
    const failingDeps = makeDeps(failing, { piExit: 1 });
    await expect(runSweBench(failing, failingDeps)).resolves.toBe(1);
    expect(failingDeps.spawnPi).toHaveBeenCalledTimes(1);
  });

  it("accepts and records an empty patch", async () => {
    const options = await makeOptions({ dryRun: false, confirmPaidRun: true, runId: "empty" });
    const deps = makeDeps(options, { diff: "" });
    await expect(runSweBench(options, deps)).resolves.toBe(0);
    const diff = await readFile(join(options.artifactsRoot, options.instanceId, "empty", "stock", "final.diff"), "utf8");
    expect(diff).toBe("");
    const spawnEnv = vi.mocked(deps.spawnPi).mock.calls[0][2].env;
    expect(spawnEnv.PI_CODING_AGENT_DIR).toBe(SWE_PI_AGENT_DIR);
    const listModelsCall = vi.mocked(deps.execFile).mock.calls.find((call) => call[0] === options.piBin && Array.isArray(call[1]) && call[1][0] === "--list-models");
    expect(listModelsCall?.[2]).toMatchObject({ env: expect.objectContaining({ PI_CODING_AGENT_DIR: SWE_PI_AGENT_DIR }) });
  });

  it("populates reproducibility metadata", async () => {
    const options = await makeOptions({ dryRun: true, runId: "meta" });
    const deps = makeDeps(options);
    await runSweBench(options, deps);
    const run = JSON.parse(await readFile(join(options.artifactsRoot, options.instanceId, "meta", "stock", "run.json"), "utf8"));
    expect(run).toMatchObject({
      instance_id: "apache__druid-13704",
      dataset: SWE_DATASET,
      repo: "apache/druid",
      base_commit: "abc123",
      model: DEFAULT_MODEL,
      thinking: SWE_THINKING_LEVEL,
      maxTokens: SWE_MAX_OUTPUT_TOKENS,
      piAgentDir: SWE_PI_AGENT_DIR,
      finalDiffSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    });
    expect(run.problemStatementSha256).toHaveLength(64);
  });

  it("records Sydes integration mode in benchmark metadata", async () => {
    const options = await makeOptions({ mode: "sydes", dryRun: true, runId: "middleware-meta", sydesIntegrationMode: "tool-middleware" });
    const deps = makeDeps(options);
    await runSweBench(options, deps);
    const run = JSON.parse(await readFile(join(options.artifactsRoot, options.instanceId, "middleware-meta", "sydes", "run.json"), "utf8"));
    expect(run).toMatchObject({
      mode: "sydes",
      integrationMode: "tool-middleware",
      model: DEFAULT_MODEL,
      thinking: SWE_THINKING_LEVEL,
      maxTokens: SWE_MAX_OUTPUT_TOKENS
    });
  });

  it("prints model, thinking, and max output tokens in dry-run output", async () => {
    const options = await makeOptions({ dryRun: true, runId: "dry-output" });
    const deps = makeDeps(options);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let lines: string[] = [];
    try {
      await expect(runSweBench(options, deps)).resolves.toBe(0);
      lines = log.mock.calls.map((call) => call.join(" "));
    } finally {
      log.mockRestore();
    }
    expect(lines).toContain(`Model: ${DEFAULT_MODEL}`);
    expect(lines).toContain(`Thinking: ${SWE_THINKING_LEVEL}`);
    expect(lines).toContain(`Max output tokens: ${SWE_MAX_OUTPUT_TOKENS}`);
  });
});

describe("SWE-bench predictions and official integration", () => {
  it("emits valid prediction JSONL with model_patch equal to final.diff", async () => {
    const root = await tempRoot();
    const runDir = join(root, "apache__druid-13704", "run1", "stock");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "final.diff"), "diff --git a/A.java b/A.java\n+fix\n");
    const output = join(root, "predictions-stock.jsonl");
    await exportPredictions({
      instanceIds: ["apache__druid-13704"],
      mode: "stock",
      artifactsRoot: root,
      outputPath: output
    });
    const row = JSON.parse((await readFile(output, "utf8")).trim());
    expect(Object.keys(row).sort()).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
    expect(row.instance_id).toBe("apache__druid-13704");
    expect(row.model_name_or_path).toBe("pi-stock-gpt-5-nano");
    expect(row.model_patch).toBe("diff --git a/A.java b/A.java\n+fix\n");
  });

  it("builds the official grading command without modifying upstream SWE-bench", () => {
    const command = buildGradeCommand({
      predictionsPath: "/tmp/predictions.jsonl",
      runId: "sydes-pilot",
      instanceId: "apache__druid-13704",
      maxWorkers: 1,
      swebenchRoot: "/Users/ksnaik/bench/SWE-bench"
    });
    expect(command.cwd).toBe("/Users/ksnaik/bench/SWE-bench");
    expect(command.args).toContain("swebench.harness.run_evaluation");
    expect(command.args).toContain("--dataset_name");
    expect(command.args).toContain(SWE_DATASET);
    expect(command.args).toContain("--predictions_path");
    expect(command.args).toContain("/tmp/predictions.jsonl");
    expect(command.args).not.toContain("git");
  });

  it("parses official resolved/unresolved/errors", async () => {
    const root = await tempRoot();
    const report = join(root, "report.json");
    await writeFile(report, JSON.stringify({
      run_id: "official-1",
      instance_results: {
        "apache__druid-13704": { resolved: true, completed: true },
        "repo__bad-1": { resolved: false, completed: false, error: "boom", empty_patch: true }
      }
    }));
    const parsed = await parseOfficialReport(report);
    expect(parsed["apache__druid-13704"]).toMatchObject({ resolved: true, completed: true, officialRunId: "official-1" });
    expect(parsed["repo__bad-1"]).toMatchObject({ resolved: false, completed: false, error: "boom", emptyPatch: true });
  });

  it("parses SWE args", () => {
    const options = parseSweArgs(["--instance", "apache__druid-13704", "--mode", "sydes", "--confirm-paid-run"], { HOME: "/tmp/home" });
    expect(options.instanceId).toBe("apache__druid-13704");
    expect(options.mode).toBe("sydes");
    expect(options.confirmPaidRun).toBe(true);
  });
});

async function makeOptions(overrides: Partial<SweRunOptions> = {}): Promise<SweRunOptions> {
  const root = await tempRoot();
  const manifestsDir = join(root, "manifests");
  await mkdir(manifestsDir, { recursive: true });
  await writeFile(join(manifestsDir, "apache__druid-13704.json"), `${JSON.stringify(normalizeSweRow(fixtureRow(), SWE_DATASET))}\n`);
  return {
    instanceId: "apache__druid-13704",
    mode: "stock",
    dryRun: true,
    confirmPaidRun: false,
    model: DEFAULT_MODEL,
    manifestsDir,
    artifactsRoot: join(root, "artifacts"),
    piBin: "/tmp/pi",
    extensionPath: resolve("src/index.ts"),
    piAgentDir: SWE_PI_AGENT_DIR,
    cbmBin: "/tmp/cbm",
    sydesIntegrationMode: undefined,
    ...overrides,
    env: { HOME: root, OPENAI_API_KEY: "set", ...(overrides.env ?? {}) }
  };
}

function makeDeps(
  options: SweRunOptions,
  behavior: { piExit?: number; diff?: string } = {}
): SweDeps {
  let worktree = "";
  const cbm = {
    listProjects: vi.fn(async () => ({ parsed: { structuredContent: { projects: [{ name: "fresh", root_path: worktree, nodes: 1, edges: 1 }] } } })),
    indexRepository: vi.fn(async () => ({ parsed: { structuredContent: { project: "fresh" } } })),
    indexStatus: vi.fn(async () => ({ parsed: { structuredContent: { status: "ready", nodes: 1, edges: 1, root_path: worktree } } })),
    searchGraphByArgs: vi.fn(async () => ({ parsed: { structuredContent: { cols: ["qn", "label", "file", "lines"], rows: [["fresh.Fix", "Function", "server/Fix.java", "1:2"]], total: 1 } } })),
    searchCode: vi.fn(async () => ({ parsed: { structuredContent: { results: [] } } })),
    tracePath: vi.fn(async () => ({ parsed: { structuredContent: { paths: [] } } })),
    close: vi.fn(),
    processStartCount: 0,
    transportKind: "test"
  };
  const execMock = vi.fn(async (command: string, args: string[], execOptions?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    if (command === "git" && args[0] === "clone") {
      worktree = args[4];
      await mkdir(worktree, { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { stdout: execOptions?.cwd === process.cwd() ? "sydescommit\n" : "abc123\n", stderr: "" };
    }
    if (command === "git" && args[0] === "status") return { stdout: "", stderr: "" };
    if (command === "git" && args[0] === "diff") return { stdout: behavior.diff ?? "diff --git a/A.java b/A.java\n+fix\n", stderr: "" };
    if (command === options.piBin && args[0] === "--version") return { stdout: "0.84.1\n", stderr: "" };
    if (command === options.cbmBin && args[0] === "--version") return { stdout: "codebase-memory-mcp 0.10.0\n", stderr: "" };
    if (command === options.piBin && args[0] === "--list-models") return { stdout: "model\n", stderr: "" };
    return { stdout: "", stderr: "" };
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sydes-swe-test-"));
  tempRoots.push(root);
  return root;
}

function fixtureRow(): Record<string, unknown> {
  return {
    instance_id: "apache__druid-13704",
    repo: "apache/druid",
    base_commit: "abc123",
    problem_statement: "Fix the Druid backend bug.",
    FAIL_TO_PASS: ["org.apache.druid.SomeTest::testFailure"],
    PASS_TO_PASS: ["org.apache.druid.SomeTest::testPass"],
    image: "sweb.eval.x86_64.apache__druid-13704",
    eval_type: "maven",
    eval_script: "./gradlew test",
    patch: "gold solution",
    test_patch: "hidden test patch"
  };
}
