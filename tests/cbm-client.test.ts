import { describe, expect, it, vi } from "vitest";
import { CbmClient, DEFAULT_INDEX_TIMEOUT_MS, serializeArgs } from "../src/cbm/client.js";
import type { CbmArgs, CbmCallOptions, CbmTransport } from "../src/cbm/types.js";

describe("serializeArgs", () => {
  it("serializes primitive, array, and true boolean flags", () => {
    expect(
      serializeArgs({
        project: "pokemon-api",
        query: "routes",
        verbose: true,
        ignored: false,
        missing: undefined,
        tag: ["one", "two"]
      })
    ).toEqual([
      "--project",
      "pokemon-api",
      "--query",
      "routes",
      "--verbose",
      "--tag",
      "[\"one\",\"two\"]"
    ]);
  });
});

describe("CbmClient", () => {
  it("uses the local CLI one-shot shape", () => {
    const client = new CbmClient({ bin: "/tmp/codebase-memory-mcp" });

    expect(client.bin).toBe("/tmp/codebase-memory-mcp");
  });

  it("invalidates list_projects cache after indexing a fresh repo", async () => {
    const calls: string[] = [];
    const transport: CbmTransport = {
      kind: "mock",
      processStartCount: 1,
      callTool: async <T,>(tool: string) => {
        calls.push(tool);
        return {
          command: tool,
          args: [],
          stdout: "{}",
          stderr: "",
          parsed: { structuredContent: { projects: [] } } as T
        };
      },
      close: vi.fn()
    };
    const client = new CbmClient({ transport });

    await client.listProjects();
    await client.listProjects();
    await client.indexRepository("/tmp/fresh");
    await client.listProjects();

    expect(calls).toEqual(["list_projects", "index_repository", "list_projects"]);
  });

  it("uses the dedicated default timeout for index_repository", async () => {
    const calls: Array<{ tool: string; timeoutMs?: number }> = [];
    const transport: CbmTransport = {
      kind: "mock",
      processStartCount: 1,
      callTool: async <T,>(tool: string, _args?: CbmArgs, options?: CbmCallOptions) => {
        calls.push({ tool, timeoutMs: options?.timeoutMs });
        return { command: tool, args: [], stdout: "{}", stderr: "", parsed: {} as T };
      },
      close: vi.fn()
    };
    const client = new CbmClient({ transport });
    await client.indexRepository("/tmp/fresh");
    expect(calls).toEqual([{ tool: "index_repository", timeoutMs: DEFAULT_INDEX_TIMEOUT_MS }]);
  });

  it("allows a custom indexing timeout", async () => {
    const calls: Array<{ tool: string; timeoutMs?: number }> = [];
    const transport: CbmTransport = {
      kind: "mock",
      processStartCount: 1,
      callTool: async <T,>(tool: string, _args?: CbmArgs, options?: CbmCallOptions) => {
        calls.push({ tool, timeoutMs: options?.timeoutMs });
        return { command: tool, args: [], stdout: "{}", stderr: "", parsed: {} as T };
      },
      close: vi.fn()
    };
    const client = new CbmClient({ transport });
    await client.indexRepository("/tmp/fresh", undefined, { timeoutMs: 45_000 });
    expect(calls).toEqual([{ tool: "index_repository", timeoutMs: 45_000 }]);
  });

  it("does not let indexing timeout alter subsequent ordinary queries", async () => {
    const calls: Array<{ tool: string; timeoutMs?: number }> = [];
    const transport: CbmTransport = {
      kind: "mock",
      processStartCount: 1,
      callTool: async <T,>(tool: string, _args?: CbmArgs, options?: CbmCallOptions) => {
        calls.push({ tool, timeoutMs: options?.timeoutMs });
        return { command: tool, args: [], stdout: "{}", stderr: "", parsed: {} as T };
      },
      close: vi.fn()
    };
    const client = new CbmClient({ transport });
    await client.indexRepository("/tmp/fresh", undefined, { timeoutMs: 60_000 });
    await client.searchGraph("project", "query");
    expect(calls).toEqual([
      { tool: "index_repository", timeoutMs: 60_000 },
      { tool: "search_graph", timeoutMs: undefined }
    ]);
  });
});
