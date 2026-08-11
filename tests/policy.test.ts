import { describe, expect, it, vi } from "vitest";
import { createBeforeAgentStartHandler, shouldInjectForPrompt } from "../src/extension.js";
import {
  buildExplorationGuidance,
  buildRelevantContext,
  boundContext,
  extractHttpRoutes,
  extractTaskIdentifiers,
  normalizeRepoPath,
  rankSymbols,
  resolveCbmProject
} from "../src/policy/exploration.js";
import type { PolicyCbmClient, RelevantContext, RelevantSymbol } from "../src/policy/types.js";

const repoPath = "/tmp/pokemon-api";
const projectName = "Users-test-pokemon-api";

function envelope<T>(structuredContent: T): { parsed: { structuredContent: T } } {
  return { parsed: { structuredContent } };
}

function makeClient(overrides: Partial<PolicyCbmClient> = {}): PolicyCbmClient {
  return {
    listProjects: vi.fn(async () => envelope({ projects: [{ name: projectName, root_path: repoPath }] })),
    searchCode: vi.fn(async () => envelope({})),
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
      project: { name: projectName, root_path: repoPath }
    });
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
    expect(guidance).toContain("verify against source");
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

  it("does not call list_projects redundantly within one context build", async () => {
    const client = makeClient();
    await buildRelevantContext("POST /api/v1/pokemon hp AddPokemon tests", repoPath, client);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it("injects before_agent_start guidance for normal coding tasks", async () => {
    const state = { lastContext: null, lastReason: null };
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
    const state = { lastContext: null, lastReason: null };
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
