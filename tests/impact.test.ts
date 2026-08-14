import { describe, expect, it, vi } from "vitest";
import {
  maybeInjectImpactGuidanceIntoContext,
  maybeSendImpactGuidance,
  observeMutationResult,
  observeTestResult
} from "../src/extension.js";
import {
  buildAffectedContext,
  buildImpactGuidance,
  boundAffectedContext,
  normalizeRepoPath,
  signatureForAffectedContext
} from "../src/policy/impact.js";
import type { AffectedContext, GitDiffProvider, PolicyCbmClient } from "../src/policy/types.js";
import type { SydesRuntimeState } from "../src/extension.js";

const repoPath = "/tmp/pokemon-api";
const projectName = "Users-test-pokemon-api";

function envelope<T>(structuredContent: T): { parsed: { structuredContent: T }; elapsedMs?: number; transport?: string } {
  return { parsed: { structuredContent }, elapsedMs: 17, transport: "persistent" };
}

function makeClient(overrides: Partial<PolicyCbmClient> = {}): PolicyCbmClient {
  return {
    transportKind: "persistent",
    processStartCount: 1,
    listProjects: vi.fn(async () => envelope({ projects: [{ name: projectName, root_path: repoPath }] })),
    searchGraphByArgs: vi.fn(),
    searchCode: vi.fn(),
    tracePath: vi.fn(),
    detectChanges: vi.fn(async () =>
      envelope({
        changed_files: ["pkg/handler/pokedex.go", "pkg/handler/pokedex_test.go"],
        impacted: [
          {
            qn: `${projectName}.pkg.service.Pokedex.AddPokemon`,
            label: "Method",
            file: "pkg/service/service.go",
            hop: 1
          },
          {
            qn: "__route__POST__/api/v1/pokemon",
            label: "Route",
            file: "",
            hop: 1
          }
        ]
      })
    ),
    ...overrides
  };
}

function diffProvider(diffText = "diff --git a/pkg/handler/pokedex.go b/pkg/handler/pokedex.go"): GitDiffProvider {
  return {
    getCurrentDiff: vi.fn(async () =>
      diffText
        ? {
            changedFiles: ["pkg/handler/pokedex.go"],
            diffText
          }
        : null
    )
  };
}

function makeState(): SydesRuntimeState {
  return {
    lastContext: null,
    lastAffectedContext: null,
    lastReason: null,
    impactDirty: false,
    pendingMutations: [],
    testCommandsAfterLastMutation: [],
    projectCache: new Map(),
    impactInjectionBoundary: "context",
    lastImpactSignature: null,
    lastDrift: null,
    lastDriftSignature: null,
    explorationTelemetry: {
      sequence: 0,
      startedAt: 0,
      seenTargets: new Set()
    }
  };
}

describe("Phase 2 impact policy", () => {
  it("successful edit marks session dirty", () => {
    const state = makeState();
    observeMutationResult(
      { type: "tool_result", toolName: "edit", toolCallId: "1", input: { path: "pkg/handler/pokedex.go" }, content: [], isError: false, details: undefined } as never,
      repoPath,
      state
    );
    expect(state.impactDirty).toBe(true);
    expect(state.pendingMutations[0].filePath).toBe("pkg/handler/pokedex.go");
  });

  it("failed edit does not mark dirty", () => {
    const state = makeState();
    observeMutationResult(
      { type: "tool_result", toolName: "edit", toolCallId: "1", input: { path: "pkg/handler/pokedex.go" }, content: [], isError: true, details: undefined } as never,
      repoPath,
      state
    );
    expect(state.impactDirty).toBe(false);
  });

  it("successful write marks dirty", () => {
    const state = makeState();
    observeMutationResult(
      { type: "tool_result", toolName: "write", toolCallId: "2", input: { path: "pkg/new.go" }, content: [], isError: false, details: undefined } as never,
      repoPath,
      state
    );
    expect(state.pendingMutations[0].toolName).toBe("write");
  });

  it("multiple edits coalesce into one impact analysis", async () => {
    const state = makeState();
    state.impactDirty = true;
    state.pendingMutations = [
      { filePath: "a.go", toolName: "edit", timestamp: 1, toolCallId: "1" },
      { filePath: "b.go", toolName: "write", timestamp: 2, toolCallId: "2" }
    ];
    const sendMessage = vi.fn();
    const builder = vi.fn(async () => fakeAffectedContext("one"));
    await maybeSendImpactGuidance({} as never, state, repoPath, { sendMessage }, builder);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(state.impactDirty).toBe(false);
  });

  it("context hook injects impact before the next model reasoning boundary", async () => {
    const state = makeState();
    state.impactDirty = true;
    state.pendingMutations = [{ filePath: "pkg/handler/pokedex.go", toolName: "edit", timestamp: 1, toolCallId: "1" }];
    const result = await maybeInjectImpactGuidanceIntoContext(
      {} as never,
      state,
      repoPath,
      { type: "context", messages: [{ role: "user", content: "fix", timestamp: 1 }] } as never,
      vi.fn(async () => fakeAffectedContext("context"))
    );
    expect(result?.messages?.at(-1)).toMatchObject({
      role: "custom",
      customType: "sydes-impact-guidance"
    });
    expect(state.impactDirty).toBe(false);
  });

  it("natural context injection does not call sendMessage or triggerTurn", async () => {
    const state = makeState();
    state.impactDirty = true;
    state.pendingMutations = [{ filePath: "pkg/handler/pokedex.go", toolName: "edit", timestamp: 1, toolCallId: "1" }];
    const sendMessage = vi.fn();
    await maybeInjectImpactGuidanceIntoContext(
      {} as never,
      state,
      repoPath,
      { type: "context", messages: [] } as never,
      vi.fn(async () => fakeAffectedContext("natural"))
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("identical impact signature does not resend through context", async () => {
    const state = makeState();
    const context = fakeAffectedContext("same-context");
    state.impactDirty = true;
    state.pendingMutations = [{ filePath: "a.go", toolName: "edit", timestamp: 1, toolCallId: "1" }];
    const first = await maybeInjectImpactGuidanceIntoContext({} as never, state, repoPath, { type: "context", messages: [] } as never, vi.fn(async () => context));
    state.impactDirty = true;
    state.pendingMutations = [{ filePath: "a.go", toolName: "edit", timestamp: 2, toolCallId: "2" }];
    const second = await maybeInjectImpactGuidanceIntoContext({} as never, state, repoPath, { type: "context", messages: [] } as never, vi.fn(async () => context));
    expect(first?.messages).toHaveLength(1);
    expect(second).toBeUndefined();
  });

  it("guidance custom messages do not recursively trigger impact", () => {
    const state = makeState();
    observeMutationResult(
      { type: "tool_result", toolName: "sydes-impact-guidance", toolCallId: "custom", input: {}, content: [], isError: false, details: undefined } as never,
      repoPath,
      state
    );
    expect(state.impactDirty).toBe(false);
  });

  it("already-tested-after-last-edit suppresses redundant impact guidance", async () => {
    const state = makeState();
    observeMutationResult(
      { type: "tool_result", toolName: "edit", toolCallId: "edit-1", input: { path: "pkg/handler/pokedex.go" }, content: [], isError: false, details: undefined } as never,
      repoPath,
      state
    );
    observeTestResult(
      { type: "tool_result", toolName: "bash", toolCallId: "test-1", input: { command: "go test ./..." }, content: [], isError: false, details: undefined } as never,
      state
    );
    const result = await maybeInjectImpactGuidanceIntoContext(
      {} as never,
      state,
      repoPath,
      { type: "context", messages: [] } as never,
      vi.fn(async () => fakeAffectedContext("tested"))
    );
    expect(result).toBeUndefined();
  });

  it("empty git diff returns no context", async () => {
    await expect(buildAffectedContext(repoPath, makeClient(), diffProvider(""))).resolves.toBeNull();
  });

  it("non-git repo fails open through null diff provider", async () => {
    await expect(buildAffectedContext(repoPath, makeClient(), { getCurrentDiff: vi.fn(async () => null) })).resolves.toBeNull();
  });

  it("detect_changes failure fails open", async () => {
    const client = makeClient({ detectChanges: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await expect(buildAffectedContext(repoPath, client, diffProvider())).resolves.toBeNull();
  });

  it("normalizes impact paths", () => {
    expect(normalizeRepoPath(repoPath, "/tmp/pokemon-api/pkg/handler/pokedex.go")).toBe("pkg/handler/pokedex.go");
    expect(normalizeRepoPath(repoPath, "/tmp/elsewhere/file.go")).toBeUndefined();
  });

  it("bounds AffectedContext collections", () => {
    const context = fakeAffectedContext("many", {
      impactedSymbols: Array.from({ length: 30 }, (_, index) => symbol(`S${index}`)),
      tests: Array.from({ length: 20 }, (_, index) => `pkg/${index}_test.go`),
      routes: Array.from({ length: 20 }, (_, index) => ({ method: "GET", path: `/x/${index}` })),
      relationships: Array.from({ length: 40 }, (_, index) => ({ from: `a${index}`, to: `b${index}`, type: "calls" }))
    });
    const bounded = boundAffectedContext(context);
    expect(bounded.impactedSymbols).toHaveLength(20);
    expect(bounded.tests).toHaveLength(10);
    expect(bounded.routes).toHaveLength(10);
    expect(bounded.relationships).toHaveLength(30);
  });

  it("renders concise structural guidance", () => {
    const guidance = buildImpactGuidance(fakeAffectedContext("guidance"));
    expect(guidance).toContain("[Sydes impact guidance]");
    expect(guidance).toContain("not proof of correctness");
    expect(guidance.length).toBeLessThanOrEqual(1500);
  });

  it("dedup prevents repeated identical guidance", async () => {
    const state = makeState();
    const sendMessage = vi.fn();
    const context = fakeAffectedContext("same");
    state.impactDirty = true;
    await maybeSendImpactGuidance({} as never, state, repoPath, { sendMessage }, vi.fn(async () => context));
    state.impactDirty = true;
    await maybeSendImpactGuidance({} as never, state, repoPath, { sendMessage }, vi.fn(async () => context));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("materially changed diff allows new guidance", async () => {
    const state = makeState();
    const sendMessage = vi.fn();
    state.impactDirty = true;
    await maybeSendImpactGuidance({} as never, state, repoPath, { sendMessage }, vi.fn(async () => fakeAffectedContext("one")));
    state.impactDirty = true;
    await maybeSendImpactGuidance({} as never, state, repoPath, { sendMessage }, vi.fn(async () => fakeAffectedContext("two")));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("builds AffectedContext from fake CBM detect_changes", async () => {
    const context = await buildAffectedContext(repoPath, makeClient(), diffProvider());
    expect(context?.changedFiles).toContain("pkg/handler/pokedex.go");
    expect(context?.impactedSymbols[0].qualifiedName).toContain("AddPokemon");
    expect(context?.routes[0].path).toBe("/api/v1/pokemon");
    expect(context?.tests).toContain("pkg/handler/pokedex_test.go");
  });

  it("failed impact builder does not break Pi", async () => {
    const state = makeState();
    state.impactDirty = true;
    const sendMessage = vi.fn();
    await maybeSendImpactGuidance({} as never, state, repoPath, { sendMessage }, vi.fn(async () => null));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.impactDirty).toBe(false);
  });

  it("signature is stable for identical impact context", () => {
    expect(signatureForAffectedContext(fakeAffectedContext("stable"))).toBe(
      signatureForAffectedContext(fakeAffectedContext("stable"))
    );
  });
});

function symbol(name: string) {
  return {
    name,
    qualifiedName: `${projectName}.${name}`,
    kind: "Method",
    filePath: `pkg/${name}.go`
  };
}

function fakeAffectedContext(seed: string, overrides: Partial<AffectedContext> = {}): AffectedContext {
  const context: AffectedContext = {
    project: projectName,
    changedFiles: [`pkg/handler/${seed}.go`],
    changedSymbols: [],
    impactedSymbols: [symbol(`AddPokemon${seed}`)],
    routes: [{ method: "POST", path: "/api/v1/pokemon" }],
    tests: ["pkg/handler/pokedex_test.go"],
    relationships: [],
    signature: "",
    querySummary: { queryCount: 1, elapsedMs: 12, detectChangesElapsedMs: 5, transport: "persistent", processStartCount: 1 },
    ...overrides
  };
  context.signature = signatureForAffectedContext(context);
  return context;
}
