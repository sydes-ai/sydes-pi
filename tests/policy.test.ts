import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createBeforeAgentStartHandler, shouldInjectForPrompt } from "../src/extension.js";
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

const execFileAsync = promisify(execFile);
const repoPath = "/tmp/pokemon-api";
const projectName = "Users-test-pokemon-api";

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
    await expect(resolveCbmProject(repoPath, makeClient())).resolves.toEqual({
      project: { name: projectName, root_path: repoPath },
      repoRoot: repoPath
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
});

function makeState() {
  return {
    lastContext: null,
    lastAffectedContext: null,
    lastReason: null,
    impactDirty: false,
    pendingMutations: [],
    testCommandsAfterLastMutation: [],
    projectCache: new Map(),
    impactInjectionBoundary: "context" as const,
    lastImpactSignature: null
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
