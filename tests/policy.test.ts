import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createBeforeAgentStartHandler,
  fingerprintRepositoryFile,
  handleToolMiddlewareToolResult,
  recordExplorationToolResult,
  shouldInjectForPrompt,
  SYDES_PATH_RECOVERY_HEADER,
  SYDES_STRUCTURAL_CONTEXT_HEADER,
  type SydesRuntimeState
} from "../src/extension.js";
import {
  buildExplorationGuidance,
  buildRelevantContext,
  boundContext,
  canonicalRepoRoot,
  ensureProjectForRepo,
  extractHttpRoutes,
  extractTaskIdentifiers,
  normalizeRepoPath,
  rankSymbols,
  resolveCbmProject
} from "../src/policy/exploration.js";
import type { PolicyCbmClient, RelevantContext, RelevantSymbol } from "../src/policy/types.js";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const repoPath = "/tmp/pokemon-api";
const projectName = "Users-test-pokemon-api";
const defaultReadFileText = "package handler\nfunc addPokemon() {}\n";

beforeEach(async () => {
  await mkdir(join(repoPath, "pkg/handler"), { recursive: true });
  await writeFile(join(repoPath, "pkg/handler/pokedex.go"), defaultReadFileText);
});

function envelope<T>(structuredContent: T): { parsed: { structuredContent: T } } {
  return { parsed: { structuredContent } };
}

function makeClient(overrides: Partial<PolicyCbmClient> = {}): PolicyCbmClient {
  return {
    listProjects: vi.fn(async () => envelope({ projects: [{ name: projectName, root_path: repoPath }] })),
    searchCode: vi.fn(async () => envelope({})),
    detectChanges: vi.fn(async () => envelope({})),
    searchGraphByArgs: vi.fn(async (args) => {
      if (args.label === "Route") {
        return envelope({ total: 0, cols: ["qn", "label", "file", "lines", "rank"], rows: [], has_more: false });
      }
      return envelope({
        total: 3,
        cols: ["qn", "label", "file", "lines", "rank"],
        rows: [
          [`${projectName}.pkg.handler.addPokemon`, "Method", "pkg/handler/pokedex.go", "19-41", -15],
          [`${projectName}.pkg.service.AddPokemon`, "Method", "pkg/service/pokemon.go", "16-18", -14],
          [`${projectName}.pkg.repository.AddPokemon`, "Method", "pkg/repository/pokedex_postgres.go", "19-36", -13]
        ],
        has_more: false
      });
    }),
    tracePath: vi.fn(async () =>
      envelope({
        function: `${projectName}.pkg.handler.addPokemon`,
        direction: "both",
        callees: {
          cols: ["name", "hop"],
          groups: [{ qn_prefix: `${projectName}.pkg.service.Pokedex`, rows: [["AddPokemon", 1]] }]
        },
        callers: { cols: ["name", "hop"], groups: [] }
      })
    ),
    ...overrides
  };
}

function makeStructuralReadClient(overrides: Partial<PolicyCbmClient> = {}): PolicyCbmClient {
  return makeClient({
    searchGraphByArgs: vi.fn(async (args) => {
      if (args.query === "pkg/handler/pokedex.go") {
        return envelope({
          total: 2,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [
            [`${projectName}.pkg.handler.addPokemon`, "Method", "pkg/handler/pokedex.go", "19-41", -15],
            [`${projectName}.pkg.handler.InitRoutes`, "Function", "pkg/handler/pokedex.go", "8-18", -14]
          ],
          has_more: false
        });
      }
      if (args.query === "Pokedex AddPokemon service") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.pkg.service.Pokedex.AddPokemon`, "Method", "pkg/service/pokemon.go", "16-18", -10]],
          has_more: false
        });
      }
      if (args.query === "Pokedex AddPokemon repository") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.pkg.repository.Pokedex.AddPokemon`, "Method", "pkg/repository/pokedex_postgres.go", "19-36", -10]],
          has_more: false
        });
      }
      if (args.query === "validator ValidatePokemon") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.pkg.validator.ValidatePokemon`, "Function", "pkg/validator/pokemon.go", "5-15", -10]],
          has_more: false
        });
      }
      if (args.query === "handler TestAddPokemon") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.pkg.handler.TestAddPokemon`, "Test", "pkg/handler/pokedex_test.go", "10-20", -10]],
          has_more: false
        });
      }
      if (args.query === "handler TestAddPokemonZeroHp") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.pkg.handler.TestAddPokemonZeroHp`, "Test", "pkg/handler/pokedex_zero_test.go", "22-35", -10]],
          has_more: false
        });
      }
      if (args.query === "handler TestAddPokemonValidation") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.pkg.handler.TestAddPokemonValidation`, "Test", "pkg/handler/pokedex_validation_test.go", "40-55", -10]],
          has_more: false
        });
      }
      if (args.query === "helpers RespondWithError") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.helpers.RespondWithError`, "Function", "helpers/helpers.go", "5-12", -10]],
          has_more: false
        });
      }
      if (args.query === "helpers DecodePokemonJSON") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.helpers.DecodePokemonJSON`, "Function", "helpers/helpers.go", "7-20", -10]],
          has_more: false
        });
      }
      if (args.query === "helpers WriteJSON") {
        return envelope({
          total: 1,
          cols: ["qn", "label", "file", "lines", "rank"],
          rows: [[`${projectName}.helpers.WriteJSON`, "Function", "helpers/helpers.go", "22-30", -10]],
          has_more: false
        });
      }
      return envelope({ total: 0, cols: ["qn", "label", "file", "lines", "rank"], rows: [], has_more: false });
    }),
    tracePath: vi.fn(async () =>
      envelope({
        function: `${projectName}.pkg.handler.addPokemon`,
        direction: "both",
        callers: {
          cols: ["name", "hop"],
          groups: [
            {
              qn_prefix: `${projectName}.pkg.handler`,
              rows: [
                ["TestAddPokemon", 1],
                ["TestAddPokemonZeroHp", 1],
                ["TestAddPokemonValidation", 1]
              ]
            }
          ]
        },
        callees: {
          cols: ["name", "hop"],
          groups: [
            { qn_prefix: `${projectName}.pkg.service.Pokedex`, rows: [["AddPokemon", 1]] },
            { qn_prefix: `${projectName}.pkg.repository.Pokedex`, rows: [["AddPokemon", 1]] },
            { qn_prefix: `${projectName}.pkg.validator`, rows: [["ValidatePokemon", 1]] },
            { qn_prefix: `${projectName}.helpers`, rows: [["RespondWithError", 1], ["DecodePokemonJSON", 1], ["WriteJSON", 1]] }
          ]
        }
      })
    ),
    ...overrides
  });
}

describe("Phase 1 exploration policy", () => {
  it("extracts HTTP routes", () => {
    expect(extractHttpRoutes("Fix POST /api/v1/pokemon and GET /health.")).toEqual([
      "/api/v1/pokemon",
      "/health"
    ]);
  });

  it("extracts deterministic task identifiers", () => {
    expect(extractTaskIdentifiers("Fix `AddPokemon` for hp_value and Pokemon handler tests")).toEqual(
      expect.arrayContaining(["AddPokemon", "hp_value", "pokemon", "handler"])
    );
  });

  it("derives route action identifiers without treating prose Update as a symbol", () => {
    const identifiers = extractTaskIdentifiers(
      "POST /api/v1/pokemon with hp=0 must return HTTP 400. Update or add tests."
    );
    expect(identifiers).toEqual(expect.arrayContaining(["AddPokemon", "addPokemon"]));
    expect(identifiers).not.toContain("Update");
  });

  it("resolves projects by canonical root path", async () => {
    const canonicalRepoPath = await realpath(repoPath);
    await expect(resolveCbmProject(repoPath, makeClient())).resolves.toEqual({
      project: { name: projectName, root_path: repoPath },
      repoRoot: canonicalRepoPath
    });
  });

  it("reuses an exact indexed repo without indexing", async () => {
    const client = makeClient({ indexRepository: vi.fn() });
    const resolution = await ensureProjectForRepo(repoPath, client, { allowIndex: true });
    expect(resolution.project?.name).toBe(projectName);
    expect(resolution.indexedThisSession).toBe(false);
    expect(client.indexRepository).not.toHaveBeenCalled();
  });

  it("indexes an unseen worktree once and caches it", async () => {
    const unseen = "/tmp/pokemon-api-worktree";
    const client = makeClient({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce(envelope({ projects: [{ name: projectName, root_path: repoPath }] }))
        .mockResolvedValue(envelope({ projects: [{ name: "worktree-project", root_path: unseen }] })),
      indexRepository: vi.fn(async () => envelope({ project: "worktree-project" }))
    });
    const cache = new Map();
    const first = await ensureProjectForRepo(unseen, client, { allowIndex: true, cache });
    const second = await ensureProjectForRepo(unseen, client, { allowIndex: true, cache });
    expect(first.project?.name).toBe("worktree-project");
    expect(first.indexedThisSession).toBe(true);
    expect(second.project?.name).toBe("worktree-project");
    expect(client.indexRepository).toHaveBeenCalledTimes(1);
  });

  it("passes indexing timeout separately from readiness timeout", async () => {
    const unseen = "/tmp/pokemon-api-index-timeout";
    let time = 0;
    const client = makeClient({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce(envelope({ projects: [] }))
        .mockResolvedValue(envelope({ projects: [{ name: "index-timeout-project", root_path: unseen }] })),
      indexRepository: vi.fn(async () => envelope({ project: "index-timeout-project" })),
      indexStatus: vi.fn(async () => envelope({ project: "index-timeout-project", status: "indexing", nodes: 0, edges: 0, root_path: unseen })),
      searchGraphByArgs: vi.fn(async () => envelope({ cols: ["qn"], rows: [], total: 0 }))
    });
    const resolution = await ensureProjectForRepo(unseen, client, {
      allowIndex: true,
      indexTimeoutMs: 180_000,
      readinessProbeQuery: "AddPokemon",
      readinessTimeoutMs: 75,
      now: () => (time += 25),
      sleep: async () => undefined
    });
    expect(client.indexRepository).toHaveBeenCalledWith(unseen, undefined, { timeoutMs: 180_000 });
    expect(resolution.readinessStrategy).toContain("timeout");
    expect(resolution.readinessWaitMs).toBeLessThan(180_000);
  });

  it("fresh index polls until the exact project is query-visible", async () => {
    const unseen = "/tmp/pokemon-api-fresh";
    let time = 0;
    const client = makeClient({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce(envelope({ projects: [] }))
        .mockResolvedValue(envelope({ projects: [{ name: "fresh-project", root_path: unseen }] })),
      indexRepository: vi.fn(async () => envelope({ project: "fresh-project" })),
      indexStatus: vi.fn(async () => envelope({ project: "fresh-project", status: "ready", nodes: 42, edges: 84, root_path: unseen })),
      searchGraphByArgs: vi
        .fn()
        .mockResolvedValueOnce(envelope({ cols: ["qn"], rows: [], total: 0 }))
        .mockResolvedValue(envelope({ cols: ["qn"], rows: [["fresh-project.pkg.handler.addPokemon"]], total: 1 }))
    });
    const resolution = await ensureProjectForRepo(unseen, client, {
      allowIndex: true,
      readinessProbeQuery: "AddPokemon",
      now: () => (time += 25),
      sleep: async () => undefined
    });
    expect(resolution.project?.name).toBe("fresh-project");
    expect(resolution.readinessStrategy).toBe("index_status+probe");
    expect(resolution.readinessPollCount).toBe(2);
  });

  it("times out readiness within the bounded retry window", async () => {
    const unseen = "/tmp/pokemon-api-timeout";
    let time = 0;
    const client = makeClient({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce(envelope({ projects: [] }))
        .mockResolvedValue(envelope({ projects: [{ name: "timeout-project", root_path: unseen }] })),
      indexRepository: vi.fn(async () => envelope({ project: "timeout-project" })),
      indexStatus: vi.fn(async () => envelope({ project: "timeout-project", status: "indexing", nodes: 0, edges: 0, root_path: unseen })),
      searchGraphByArgs: vi.fn(async () => envelope({ cols: ["qn"], rows: [], total: 0 }))
    });
    const resolution = await ensureProjectForRepo(unseen, client, {
      allowIndex: true,
      readinessProbeQuery: "AddPokemon",
      readinessTimeoutMs: 75,
      now: () => (time += 25),
      sleep: async () => undefined
    });
    expect(resolution.readinessStrategy).toContain("timeout");
    expect(resolution.readinessPollCount).toBeGreaterThan(0);
  });

  it("uses index_status for an existing ready repo without indexing", async () => {
    const client = makeClient({
      indexRepository: vi.fn(),
      indexStatus: vi.fn(async () => envelope({ project: projectName, status: "ready", nodes: 12, edges: 34, root_path: repoPath }))
    });
    const resolution = await ensureProjectForRepo(repoPath, client, { allowIndex: true });
    expect(resolution.indexedThisSession).toBe(false);
    expect(resolution.readinessStrategy).toBe("index_status");
    expect(resolution.readinessPollCount).toBe(1);
    expect(client.indexRepository).not.toHaveBeenCalled();
  });

  it("reuses the ready project cache without re-polling readiness", async () => {
    const client = makeClient({
      indexStatus: vi.fn(async () => envelope({ project: projectName, status: "ready", nodes: 12, edges: 34, root_path: repoPath }))
    });
    const cache = new Map();
    await ensureProjectForRepo(repoPath, client, { allowIndex: true, cache });
    const second = await ensureProjectForRepo(repoPath, client, { allowIndex: true, cache });
    expect(second.readinessStrategy).toBe("index_status");
    expect(client.indexStatus).toHaveBeenCalledTimes(1);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it("does not choose an ambiguous basename project for a different worktree", async () => {
    const client = makeClient({
      listProjects: vi.fn(async () =>
        envelope({
          projects: [
            { name: "sample", root_path: "/Users/me/sample_repos/pokemon-api" },
            { name: "other", root_path: "/Users/me/other/pokemon-api" }
          ]
        })
      )
    });
    const resolution = await resolveCbmProject("/tmp/pokemon-api", client);
    expect(resolution.project).toBeNull();
    expect(resolution.reason).toContain("no exact CBM project");
  });

  it("resolves git worktree .git file layouts through git rev-parse", async () => {
    const root = await mkdtemp(join(tmpdir(), "sydes-policy-"));
    try {
      const repo = join(root, "repo");
      const worktree = join(root, "worktree");
      await execFileAsync("git", ["init", repo]);
      await execFileAsync("git", ["config", "user.email", "sydes@example.com"], { cwd: repo });
      await execFileAsync("git", ["config", "user.name", "Sydes"], { cwd: repo });
      await writeFile(join(repo, "file.txt"), "one\n");
      await execFileAsync("git", ["add", "file.txt"], { cwd: repo });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
      await execFileAsync("git", ["worktree", "add", worktree], { cwd: repo });
      await mkdir(join(worktree, "subdir"));
      await expect(canonicalRepoRoot(join(worktree, "subdir"), undefined)).resolves.toBe(await realpath(worktree));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes repo-local POSIX paths and rejects outside paths", () => {
    expect(normalizeRepoPath(repoPath, "/tmp/pokemon-api/pkg/handler/pokedex.go")).toBe(
      "pkg/handler/pokedex.go"
    );
    expect(normalizeRepoPath(repoPath, "/tmp/elsewhere/file.go")).toBeUndefined();
  });

  it("ranks handler/source symbols above unrelated test symbols", () => {
    const ranked = rankSymbols(
      [
        symbol("pkg/handler/pokedex_test.go", "OtherTest"),
        symbol("pkg/handler/pokedex.go", "addPokemon")
      ],
      "Fix POST /api/v1/pokemon AddPokemon"
    );
    expect(ranked[0].name).toBe("addPokemon");
  });

  it("bounds RelevantContext collections", () => {
    const context = fakeContext({
      entryPoints: Array.from({ length: 8 }, (_, index) => symbol(`pkg/${index}.go`, `S${index}`)),
      relatedSymbols: Array.from({ length: 20 }, (_, index) => symbol(`pkg/r${index}.go`, `R${index}`)),
      files: Array.from({ length: 20 }, (_, index) => `pkg/${index}.go`),
      tests: Array.from({ length: 10 }, (_, index) => `pkg/${index}_test.go`),
      relationships: Array.from({ length: 25 }, (_, index) => ({ from: `a${index}`, to: `b${index}`, type: "calls" }))
    });
    const bounded = boundContext(context);
    expect(bounded.entryPoints).toHaveLength(5);
    expect(bounded.relatedSymbols).toHaveLength(12);
    expect(bounded.files).toHaveLength(10);
    expect(bounded.tests).toHaveLength(5);
    expect(bounded.relationships).toHaveLength(20);
  });

  it("fails open when graph queries fail", async () => {
    const client = makeClient({ searchGraphByArgs: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await expect(buildRelevantContext("Fix /api/v1/pokemon", repoPath, client)).resolves.toBeNull();
  });

  it("renders concise guidance with source verification wording", () => {
    const guidance = buildExplorationGuidance(fakeContext());
    expect(guidance).toContain("[Sydes graph guidance]");
    expect(guidance).toContain("Start exploration with:");
    expect(guidance).toContain("before broad repository search");
    expect(guidance).toContain("Verify all graph claims against source");
    expect(guidance.length).toBeLessThanOrEqual(1500);
  });

  it("does not invent structural paths when relationships are absent", () => {
    const guidance = buildExplorationGuidance(fakeContext({ relationships: [] }));
    expect(guidance).not.toContain("Structural path:");
  });

  it("builds bounded context from deterministic graph calls", async () => {
    const client = makeClient();
    const context = await buildRelevantContext("POST /api/v1/pokemon hp AddPokemon tests", repoPath, client);
    expect(context?.project).toBe(projectName);
    expect(context?.entryPoints[0].filePath).toBe("pkg/handler/pokedex.go");
    expect(context?.querySummary.queryCount).toBeGreaterThanOrEqual(3);
  });

  it("returns non-empty worktree context from fake CBM results after indexing", async () => {
    const worktree = "/tmp/live/pokemon-api";
    const client = makeClient({
      listProjects: vi
        .fn()
        .mockResolvedValueOnce(envelope({ projects: [] }))
        .mockResolvedValue(envelope({ projects: [{ name: projectName, root_path: worktree }] })),
      indexRepository: vi.fn(async () => envelope({ project: projectName }))
    });
    const context = await buildRelevantContext("POST /api/v1/pokemon hp AddPokemon tests", worktree, client, {
      allowIndex: true
    });
    expect(context?.entryPoints.length).toBeGreaterThan(0);
    expect(context?.files.length).toBeGreaterThan(0);
    expect(context?.projectIndexedThisSession).toBe(true);
  });

  it("does not call list_projects redundantly within one context build", async () => {
    const client = makeClient();
    await buildRelevantContext("POST /api/v1/pokemon hp AddPokemon tests", repoPath, client);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it("injects before_agent_start guidance for normal coding tasks", async () => {
    const state = makeState();
    const result = await createBeforeAgentStartHandler(makeClient() as never, state)(
      {
        type: "before_agent_start",
        prompt: "Fix POST /api/v1/pokemon hp AddPokemon tests",
        systemPrompt: "",
        systemPromptOptions: {} as never
      },
      { cwd: repoPath } as never
    );
    expect(result?.message?.customType).toBe("sydes-graph-guidance");
    expect(result?.message?.content).toContain("[Sydes graph guidance]");
  });

  it("does not inject when CBM fails", async () => {
    const state = makeState();
    const result = await createBeforeAgentStartHandler(makeClient({ listProjects: vi.fn(async () => Promise.reject(new Error("nope"))) }) as never, state)(
      {
        type: "before_agent_start",
        prompt: "Fix POST /api/v1/pokemon",
        systemPrompt: "",
        systemPromptOptions: {} as never
      },
      { cwd: repoPath } as never
    );
    expect(result).toBeUndefined();
  });

  it("skips slash commands and obvious non-coding chat", () => {
    expect(shouldInjectForPrompt("/help")).toBe(false);
    expect(shouldInjectForPrompt("hello there")).toBe(false);
    expect(shouldInjectForPrompt("fix the pokemon handler")).toBe(true);
  });

  it("registers commands and hook but no model-facing CBM tool", async () => {
    const mod = await import("../src/index.js");
    const pi = {
      registerCommand: vi.fn(),
      on: vi.fn(),
      registerTool: vi.fn()
    };
    mod.default(pi as never);
    expect(pi.registerCommand).toHaveBeenCalledWith("sydes-context", expect.anything());
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("tool-middleware mode disables startup exploration guidance and context injection hooks", async () => {
    const mod = await import("../src/index.js");
    const previous = process.env.SYDES_INTEGRATION_MODE;
    process.env.SYDES_INTEGRATION_MODE = "tool-middleware";
    try {
      const pi = {
        registerCommand: vi.fn(),
        on: vi.fn(),
        registerTool: vi.fn()
      };
      mod.default(pi as never);
      expect(pi.on).not.toHaveBeenCalledWith("before_agent_start", expect.any(Function));
      expect(pi.on).not.toHaveBeenCalledWith("context", expect.any(Function));
      expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
      expect(pi.on).toHaveBeenCalledWith("tool_result", expect.any(Function));
      expect(pi.registerTool).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.SYDES_INTEGRATION_MODE;
      } else {
        process.env.SYDES_INTEGRATION_MODE = previous;
      }
    }
  });

  it("tool-middleware leaves the original task prompt path unchanged", async () => {
    const mod = await import("../src/index.js");
    const previous = process.env.SYDES_INTEGRATION_MODE;
    process.env.SYDES_INTEGRATION_MODE = "tool-middleware";
    try {
      const pi = {
        registerCommand: vi.fn(),
        on: vi.fn(),
        registerTool: vi.fn()
      };
      mod.default(pi as never);
      const beforeAgentStart = vi.mocked(pi.on).mock.calls.find((call) => call[0] === "before_agent_start");
      expect(beforeAgentStart).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.SYDES_INTEGRATION_MODE;
      } else {
        process.env.SYDES_INTEGRATION_MODE = previous;
      }
    }
  });

  it("records read exploration events and repeated reads without changing tool output", async () => {
    const state = makeState();
    const originalContent = [{ type: "text", text: "package main" }];
    const event = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: originalContent,
      details: undefined,
      isError: false
    } as ToolResultEvent;

    const first = await recordExplorationToolResult(event, repoPath, state, () => 1100);
    const second = await recordExplorationToolResult({ ...event, toolCallId: "read-2" } as ToolResultEvent, repoPath, state, () => 1200);

    expect(first).toMatchObject({
      sequence: 1,
      toolName: "read",
      normalizedTarget: "pkg/handler/pokedex.go",
      repeated: false,
      resultSizeBytes: JSON.stringify(originalContent).length,
      isError: false
    });
    expect(second?.repeated).toBe(true);
    expect(event.content).toBe(originalContent);
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenCalledTimes(2);
  });

  it("records grep and find exploration events", async () => {
    const state = makeState();
    const grep = await recordExplorationToolResult({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "grep-1",
      input: { pattern: "AddPokemon", path: "/tmp/pokemon-api/pkg" },
      content: [{ type: "text", text: "pkg/handler/pokedex.go" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, () => 1100);
    const find = await recordExplorationToolResult({
      type: "tool_result",
      toolName: "find",
      toolCallId: "find-1",
      input: { pattern: "*.go", path: "/tmp/pokemon-api" },
      content: [{ type: "text", text: "pkg/handler/pokedex.go" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, () => 1200);

    expect(grep).toMatchObject({ toolName: "grep", normalizedTarget: "pkg", normalizedQuery: "AddPokemon" });
    expect(find).toMatchObject({ toolName: "find", normalizedQuery: "*.go" });
    expect(find?.normalizedTarget).toBeUndefined();
  });

  it("fingerprints the complete actual repository file", async () => {
    const first = await fingerprintRepositoryFile(repoPath, "pkg/handler/pokedex.go");
    await writeFile(join(repoPath, "pkg/handler/pokedex.go"), `${defaultReadFileText}func extra() {}\n`);
    const second = await fingerprintRepositoryFile(repoPath, "pkg/handler/pokedex.go");

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("appends structural context to the first successful read result", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    const originalContent = [{ type: "text", text: "package handler" }];
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: originalContent,
      details: { bytes: 15 },
      usage: { inputTokens: 1, outputTokens: 0 },
      isError: false
    } as never, repoPath, state, client, () => 1100);

    expect(result?.content?.[0]).toBe(originalContent[0]);
    expect(result?.content?.[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining(SYDES_STRUCTURAL_CONTEXT_HEADER)
    });
    expect(JSON.stringify(result?.content)).toContain("Anchor: pkg/handler/pokedex.go");
    expect(JSON.stringify(result?.content)).toContain("AddPokemon");
    expect(JSON.stringify(result?.content)).toContain("helpers/helpers.go");
    expect(JSON.stringify(result?.content)).toContain("pkg/handler/pokedex_test.go");
    expect(result?.details).toEqual({ bytes: 15 });
    expect(result?.isError).toBe(false);
    expect(client.searchGraphByArgs).toHaveBeenCalledWith({
      project: projectName,
      query: "pkg/handler/pokedex.go",
      limit: 12
    });
    expect(client.tracePath).toHaveBeenCalledWith(projectName, `${projectName}.pkg.handler.addPokemon`);
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          anchorPath: "pkg/handler/pokedex.go",
          cbmQueryCount: 12,
          generated: true,
          relationshipsReturned: 18,
          filesSuggested: ["helpers/helpers.go", "pkg/repository/pokedex_postgres.go", "pkg/service/pokemon.go"],
          testsSuggested: ["pkg/handler/pokedex_test.go", "pkg/handler/pokedex_validation_test.go"],
          relatedCodeFilesSuggested: ["helpers/helpers.go", "pkg/repository/pokedex_postgres.go", "pkg/service/pokemon.go"],
          relatedTestFilesSuggested: ["pkg/handler/pokedex_test.go", "pkg/handler/pokedex_validation_test.go"]
        })
      })
    );
  });

  it("resolves related symbols to exact file paths and omits unresolved paths", async () => {
    const state = makeState();
    const client = makeStructuralReadClient({
      tracePath: vi.fn(async () =>
        envelope({
          callers: {
            cols: ["name", "hop"],
            groups: [{ qn_prefix: `${projectName}.pkg.handler`, rows: [["UnknownCaller", 1]] }]
          },
          callees: {
            cols: ["name", "hop"],
            groups: [{ qn_prefix: `${projectName}.helpers`, rows: [["RespondWithError", 1]] }]
          }
        })
      ),
      searchGraphByArgs: vi.fn(async (args) => {
        if (args.query === "pkg/handler/pokedex.go") {
          return envelope({
            total: 1,
            cols: ["qn", "label", "file", "lines", "rank"],
            rows: [[`${projectName}.pkg.handler.addPokemon`, "Method", "pkg/handler/pokedex.go", "19-41", -15]],
            has_more: false
          });
        }
        if (args.query === "helpers RespondWithError") {
          return envelope({
            total: 1,
            cols: ["qn", "label", "file", "lines", "rank"],
            rows: [[`${projectName}.helpers.RespondWithError`, "Function", "helpers/helpers.go", "5-12", -10]],
            has_more: false
          });
        }
        return envelope({ total: 0, cols: ["qn", "label", "file", "lines", "rank"], rows: [], has_more: false });
      })
    });
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    const text = JSON.stringify(result?.content);
    expect(text).toContain("RespondWithError - helpers/helpers.go");
    expect(text).not.toContain("UnknownCaller");
  });

  it("caps related code suggestions at 3 and test suggestions at 2", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          relatedCodeFilesSuggested: expect.arrayContaining(["helpers/helpers.go", "pkg/repository/pokedex_postgres.go", "pkg/service/pokemon.go"]),
          relatedTestFilesSuggested: ["pkg/handler/pokedex_test.go", "pkg/handler/pokedex_validation_test.go"]
        })
      })
    );
    const event = vi.mocked(state.telemetry!.recordExplorationToolEvent!).mock.calls[0][0];
    expect(event.enrichment?.relatedCodeFilesSuggested).toHaveLength(3);
    expect(event.enrichment?.relatedTestFilesSuggested).toHaveLength(2);
  });

  it("omits the anchor and already-read files from next-file suggestions", async () => {
    const state = makeState();
    state.explorationTelemetry.readFileFingerprints.set("helpers/helpers.go", "seen");
    const client = makeStructuralReadClient();
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    const event = vi.mocked(state.telemetry!.recordExplorationToolEvent!).mock.calls[0][0];
    expect(event.enrichment?.relatedCodeFilesSuggested).not.toContain("pkg/handler/pokedex.go");
    expect(event.enrichment?.relatedCodeFilesSuggested).not.toContain("helpers/helpers.go");
  });

  it("uses the concrete read file as the graph anchor, not task prose", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    const graphArgs = vi.mocked(client.searchGraphByArgs).mock.calls.map(([args]) => JSON.stringify(args)).join("\n");
    expect(graphArgs).toContain("pkg/handler/pokedex.go");
    expect(graphArgs).not.toContain("POST /api/v1/pokemon");
    expect(graphArgs).not.toContain("hp=0");
  });

  it("does not repeat CBM enrichment for repeated reads of the same normalized file", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    const event = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as ToolResultEvent;

    const first = await handleToolMiddlewareToolResult(event, repoPath, state, client, () => 1100);
    const graphCallsAfterFirstRead = vi.mocked(client.searchGraphByArgs).mock.calls.length;
    const traceCallsAfterFirstRead = vi.mocked(client.tracePath).mock.calls.length;
    const second = await handleToolMiddlewareToolResult({ ...event, toolCallId: "read-2" } as ToolResultEvent, repoPath, state, client, () => 1200);

    expect(first?.content?.length).toBe(2);
    expect(second?.content?.[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("unchanged file was previously inspected")
    });
    expect(client.searchGraphByArgs).toHaveBeenCalledTimes(graphCallsAfterFirstRead);
    expect(client.tracePath).toHaveBeenCalledTimes(traceCallsAfterFirstRead);
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        repeated: true,
        enrichment: expect.objectContaining({
          generated: false,
          skippedReason: "already_enriched",
          repeatedReadUnchanged: true,
          repeatedEnrichmentAvoided: true
        })
      })
    );
  });

  it("treats different read offset and limit windows as unchanged when the file is unchanged", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-window-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go", offset: 0, limit: 0 },
      content: [{ type: "text", text: "" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);
    const graphCallsAfterFirstRead = vi.mocked(client.searchGraphByArgs).mock.calls.length;
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-window-2",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go", offset: 1, limit: 4000 },
      content: [{ type: "text", text: defaultReadFileText }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    expect(client.searchGraphByArgs).toHaveBeenCalledTimes(graphCallsAfterFirstRead);
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          repeatedReadUnchanged: true,
          repeatedReadAfterModification: false,
          repeatedEnrichmentAvoided: true
        })
      })
    );
  });

  it("treats identical underlying file with different returned text as unchanged", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    const baseInput = { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" };
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-text-1",
      input: baseInput,
      content: [{ type: "text", text: "window one" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-text-2",
      input: baseInput,
      content: [{ type: "text", text: "completely different returned window" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          repeatedReadUnchanged: true,
          repeatedReadAfterModification: false
        })
      })
    );
  });

  it("treats a modified repeated read as fresh structural context", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    const baseEvent = {
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as ToolResultEvent;

    await handleToolMiddlewareToolResult(baseEvent, repoPath, state, client);
    const graphCallsAfterFirstRead = vi.mocked(client.searchGraphByArgs).mock.calls.length;
    await writeFile(join(repoPath, "pkg/handler/pokedex.go"), `${defaultReadFileText}func changed() {}\n`);
    const modified = await handleToolMiddlewareToolResult({
      ...baseEvent,
      toolCallId: "read-2",
      content: [{ type: "text", text: "package handler\nfunc changed() {}" }]
    } as ToolResultEvent, repoPath, state, client);

    expect(modified?.content?.[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("structural context refreshed")
    });
    expect(client.searchGraphByArgs).toHaveBeenCalledTimes(graphCallsAfterFirstRead * 2);
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          generated: true,
          repeatedReadAfterModification: true
        })
      })
    );
  });

  it("leaves read output unchanged when CBM enrichment fails", async () => {
    const state = makeState();
    const client = makeStructuralReadClient({ searchGraphByArgs: vi.fn(async () => Promise.reject(new Error("cbm unavailable"))) });
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client, () => 1100);

    expect(result).toBeUndefined();
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          generated: false,
          failureReason: "cbm unavailable"
        })
      })
    );
  });

  it("appends failed-read recovery when a strong existing candidate exists", async () => {
    const state = makeState();
    const originalContent = [{ type: "text", text: "read: no such file or directory" }];
    const client = makeStructuralReadClient({
      searchGraphByArgs: vi.fn(async (args) => {
        if (args.query === "pokemon") {
          return envelope({
            cols: ["qn", "label", "file"],
            rows: [
              [`${projectName}.pkg.handler.addPokemon`, "Method", "pkg/handler/pokemon.go"],
              [`${projectName}.pkg.handler.InitRoutes`, "Function", "pkg/handler/handler.go"],
              [`${projectName}.pkg.repository.AddPokemon`, "Method", "pkg/repository/pokemon.go"],
              [`${projectName}.cmd.main`, "Function", "cmd/main.go"]
            ]
          });
        }
        return envelope({ cols: ["qn", "label", "file"], rows: [] });
      })
    });
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-missing",
      input: { path: "server/handler/pokemon.go" },
      content: originalContent,
      details: undefined,
      isError: true
    } as never, repoPath, state, client);

    expect(result?.content?.[0]).toBe(originalContent[0]);
    expect(result?.content?.[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining(SYDES_PATH_RECOVERY_HEADER)
    });
    expect(JSON.stringify(result?.content)).toContain("pkg/handler/pokemon.go");
    expect(JSON.stringify(result?.content)).not.toContain("cmd/main.go");
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          failedReadRecoveryGenerated: true,
          failedReadRecoveryCandidates: ["pkg/handler/pokemon.go", "pkg/repository/pokemon.go"]
        })
      })
    );
  });

  it("leaves failed read unchanged when recovery confidence is weak", async () => {
    const state = makeState();
    const client = makeStructuralReadClient({
      searchGraphByArgs: vi.fn(async () =>
        envelope({
          cols: ["qn", "label", "file"],
          rows: [[`${projectName}.pkg.health.Health`, "Function", "pkg/health/check.go"]]
        })
      )
    });
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-missing",
      input: { path: "server/handler/pokemon.go" },
      content: [{ type: "text", text: "read: no such file or directory" }],
      details: undefined,
      isError: true
    } as never, repoPath, state, client);

    expect(result).toBeUndefined();
    expect(state.telemetry?.recordExplorationToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        enrichment: expect.objectContaining({
          failedReadRecoveryGenerated: false,
          skippedReason: "no_recovery_candidates"
        })
      })
    );
  });

  it("uses graph-known files as failed-read recovery candidates", async () => {
    const state = makeState();
    state.explorationTelemetry.surfacedGraphFiles.add("pkg/handler/pokedex.go");
    const client = makeStructuralReadClient({
      searchGraphByArgs: vi.fn(async () => envelope({ cols: ["qn", "label", "file"], rows: [] }))
    });
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-missing",
      input: { path: "server/handler/pokemon.go" },
      content: [{ type: "text", text: "read: no such file or directory" }],
      details: undefined,
      isError: true
    } as never, repoPath, state, client);

    expect(JSON.stringify(result?.content)).toContain("pkg/handler/pokedex.go");
  });

  it("keeps grep and find passive without querying CBM", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "grep-1",
      input: { pattern: "AddPokemon" },
      content: [{ type: "text", text: "ok" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(client.searchGraphByArgs).not.toHaveBeenCalled();
    expect(client.tracePath).not.toHaveBeenCalled();
  });

  it("leaves non-read repository tools unchanged in tool-middleware handling", async () => {
    const state = makeState();
    const client = makeStructuralReadClient();
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "edit",
      toolCallId: "edit-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "edited" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    expect(result).toBeUndefined();
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(state.telemetry?.recordExplorationToolEvent).not.toHaveBeenCalled();
  });

  it("bounds structural read enrichment to a small footer", async () => {
    const state = makeState();
    const rows = Array.from({ length: 80 }, (_, index) => [
      `${projectName}.pkg.handler.Symbol${index}`,
      "Method",
      "pkg/handler/pokedex.go",
      `${index + 1}-${index + 2}`,
      -index
    ]);
    const client = makeStructuralReadClient({
      searchGraphByArgs: vi.fn(async () =>
        envelope({ total: rows.length, cols: ["qn", "label", "file", "lines", "rank"], rows, has_more: false })
      )
    });
    const result = await handleToolMiddlewareToolResult({
      type: "tool_result",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "/tmp/pokemon-api/pkg/handler/pokedex.go" },
      content: [{ type: "text", text: "package handler" }],
      details: undefined,
      isError: false
    } as never, repoPath, state, client);

    const footer = result?.content?.[1];
    expect(footer).toMatchObject({ type: "text" });
    expect(JSON.stringify(footer).length).toBeLessThan(2600);
  });
});

function makeState(): SydesRuntimeState {
  return {
    lastContext: null,
    lastAffectedContext: null,
    lastReason: null,
    impactDirty: false,
    pendingMutations: [],
    testCommandsAfterLastMutation: [],
    projectCache: new Map(),
    impactInjectionBoundary: "context" as const,
    lastImpactSignature: null,
    lastDrift: null,
    lastDriftSignature: null,
    explorationTelemetry: {
      sequence: 0,
      startedAt: 1000,
      seenTargets: new Set<string>(),
      enrichedReadTargets: new Set<string>(),
      readFileFingerprints: new Map<string, string>(),
      surfacedGraphFiles: new Set<string>()
    },
    telemetry: {
      recordExplorationToolEvent: vi.fn(async () => undefined)
    }
  };
}

function symbol(filePath: string, name: string): RelevantSymbol {
  return {
    name,
    qualifiedName: `${projectName}.${name}`,
    kind: "Method",
    filePath
  };
}

function fakeContext(overrides: Partial<RelevantContext> = {}): RelevantContext {
  return {
    project: projectName,
    task: "Fix POST /api/v1/pokemon",
    entryPoints: [symbol("pkg/handler/pokedex.go", "addPokemon")],
    relatedSymbols: [symbol("pkg/service/pokemon.go", "AddPokemon")],
    files: ["pkg/handler/pokedex.go", "pkg/service/pokemon.go"],
    tests: ["pkg/handler/pokedex_test.go"],
    relationships: [{ from: `${projectName}.pkg.handler.addPokemon`, to: `${projectName}.pkg.service.AddPokemon`, type: "calls" }],
    querySummary: { queryCount: 3, elapsedMs: 12 },
    ...overrides
  };
}
