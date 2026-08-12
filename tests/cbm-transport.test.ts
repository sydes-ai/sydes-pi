import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CbmClient } from "../src/cbm/client.js";
import { CliCbmTransport, FallbackCbmTransport, PersistentCbmTransport } from "../src/cbm/transport.js";
import type { CbmArgs, CbmCallOptions, CbmTransport } from "../src/cbm/types.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  writes: unknown[] = [];
  onWrite?: (message: Record<string, unknown>) => void;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        if (line) {
          const message = JSON.parse(line) as Record<string, unknown>;
          this.writes.push(message);
          this.onWrite?.(message);
        }
      }
    });
  }

  respond(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

describe("PersistentCbmTransport", () => {
  it("ordinary CBM calls still default to the 15 second timeout", () => {
    const transport = new PersistentCbmTransport({ bin: "/tmp/cbm" });
    expect(transport.requestTimeoutMs).toBe(15_000);
  });

  it("starts one process across multiple tool calls and correlates IDs", async () => {
    const children: FakeChild[] = [];
    const transport = new PersistentCbmTransport({
      bin: "/tmp/cbm",
      spawnProcess: () => {
        const child = new FakeChild();
        child.onWrite = (message) => {
          if (message.method === "initialize") {
            child.respond(Number(message.id), { ok: "init" });
          }
          if (message.method === "tools/call") {
            const params = message.params as { arguments?: { query?: string } };
            child.respond(Number(message.id), { structuredContent: { query: params.arguments?.query } });
          }
        };
        children.push(child);
        return child as never;
      }
    });

    const first = transport.callTool("search_graph", { query: "one" });
    await expect(first).resolves.toMatchObject({ parsed: { structuredContent: { query: "one" } } });

    const second = transport.callTool("search_graph", { query: "two" });
    await expect(second).resolves.toMatchObject({ parsed: { structuredContent: { query: "two" } } });

    expect(transport.processStartCount).toBe(1);
    expect(children).toHaveLength(1);
    expect(children[0].writes.filter((write): write is { id: number } => typeof (write as { id?: unknown }).id === "number").map((write) => write.id)).toEqual([
      1,
      2,
      3
    ]);
    await transport.close();
  });

  it("propagates protocol errors", async () => {
    const child = new FakeChild();
    const transport = new PersistentCbmTransport({
      bin: "/tmp/cbm",
      spawnProcess: () => {
        child.onWrite = (message) => {
          if (message.method === "initialize") {
            child.respond(Number(message.id), { ok: "init" });
          }
          if (message.method === "tools/call") {
            child.respondError(Number(message.id), "bad query");
          }
        };
        return child as never;
      }
    });
    const call = transport.callTool("search_graph", {});
    await expect(call).rejects.toThrow("bad query");
    await transport.close();
  });

  it("rejects pending requests when the child exits", async () => {
    const child = new FakeChild();
    const transport = new PersistentCbmTransport({
      bin: "/tmp/cbm",
      spawnProcess: () => {
        child.onWrite = (message) => {
          if (message.method === "initialize") {
            child.respond(Number(message.id), { ok: "init" });
          }
        };
        return child as never;
      }
    });
    const call = transport.callTool("search_graph", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    child.emit("exit", 1, null);
    await expect(call).rejects.toThrow("exited");
  });

  it("times out pending requests", async () => {
    const child = new FakeChild();
    const transport = new PersistentCbmTransport({
      bin: "/tmp/cbm",
      requestTimeoutMs: 5,
      spawnProcess: () => child as never
    });
    const call = transport.callTool("search_graph", {});
    await expect(call).rejects.toThrow("timed out");
    await transport.close();
  });

  it("uses per-call timeout overrides and keeps the command name in timeout errors", async () => {
    const child = new FakeChild();
    const transport = new PersistentCbmTransport({
      bin: "/tmp/cbm",
      requestTimeoutMs: 15_000,
      spawnProcess: () => {
        child.onWrite = (message) => {
          if (message.method === "initialize") {
            child.respond(Number(message.id), { ok: "init" });
          }
        };
        return child as never;
      }
    });
    const call = transport.callTool("index_repository", {}, { timeoutMs: 5 });
    await expect(call).rejects.toThrow("index_repository");
    await transport.close();
  });

  it("closes the child process", async () => {
    const child = new FakeChild();
    const transport = new PersistentCbmTransport({
      bin: "/tmp/cbm",
      spawnProcess: () => {
        child.onWrite = (message) => {
          if (message.method === "initialize") {
            child.respond(Number(message.id), { ok: "init" });
          }
          if (message.method === "tools/call") {
            child.respond(Number(message.id), {});
          }
        };
        return child as never;
      }
    });
    const call = transport.callTool("search_graph", {});
    await call;
    await transport.close();
    expect(child.killed).toBe(true);
  });
});

describe("FallbackCbmTransport", () => {
  it("falls back to CLI when persistent transport fails", async () => {
    const primary: CbmTransport = {
      kind: "persistent",
      processStartCount: 1,
      callTool: vi.fn(async () => Promise.reject(new Error("init failed"))),
      close: vi.fn()
    };
    const fallback = new CliCbmTransport({
      bin: "/tmp/cbm",
      spawnProcess: () => {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ structuredContent: { total: 1 } })}\n`);
          child.emit("close", 0);
        });
        return child as never;
      }
    });
    const transport = new FallbackCbmTransport(primary, fallback);
    await expect(transport.callTool("search_graph", {})).resolves.toMatchObject({
      transport: "cli-fallback"
    });
  });

  it("passes the same per-call timeout to persistent and CLI fallback", async () => {
    const seen: Array<{ transport: string; timeoutMs?: number }> = [];
    const primary: CbmTransport = {
      kind: "persistent",
      processStartCount: 1,
      callTool: vi.fn(async (_tool, _args, options) => {
        seen.push({ transport: "persistent", timeoutMs: options?.timeoutMs });
        throw new Error("init failed");
      }),
      close: vi.fn()
    };
    const fallbackCall: CbmTransport["callTool"] = async <T,>(
      tool: string,
      _args?: CbmArgs,
      options?: CbmCallOptions
    ) => {
      seen.push({ transport: "cli", timeoutMs: options?.timeoutMs });
      return { command: tool, args: [], stdout: "{}", stderr: "", parsed: {} as T };
    };
    const fallback: CbmTransport = {
      kind: "cli",
      processStartCount: 1,
      callTool: fallbackCall,
      close: vi.fn()
    };
    const transport = new FallbackCbmTransport(primary, fallback);
    await transport.callTool("index_repository", {}, { timeoutMs: 180_000 });
    expect(seen).toEqual([
      { transport: "persistent", timeoutMs: 180_000 },
      { transport: "cli", timeoutMs: 180_000 }
    ]);
  });

  it("does not run a second full custom timeout after persistent timeout", async () => {
    let fallbackCalls = 0;
    const fallbackCall: CbmTransport["callTool"] = async <T,>(tool: string) => {
      fallbackCalls += 1;
      return {
      command: tool,
      args: [],
      stdout: "{}",
      stderr: "",
      parsed: {} as T
      };
    };
    const fallback: CbmTransport = {
      kind: "cli",
      processStartCount: 1,
      callTool: fallbackCall,
      close: vi.fn()
    };
    const transport = new FallbackCbmTransport(
      {
        kind: "persistent",
        processStartCount: 1,
        callTool: vi.fn(async () => {
          throw new Error("Codebase Memory MCP request timed out: index_repository");
        }),
        close: vi.fn()
      },
      fallback
    );
    await expect(transport.callTool("index_repository", {}, { timeoutMs: 180_000 })).rejects.toThrow("index_repository");
    expect(fallbackCalls).toBe(0);
  });

  it("allows policy fail-open when both transports fail", async () => {
    const transport: CbmTransport = {
      kind: "test",
      processStartCount: 0,
      callTool: vi.fn(async () => Promise.reject(new Error("all down"))),
      close: vi.fn()
    };
    const client = new CbmClient({ transport });
    await expect(client.listProjects()).rejects.toThrow("all down");
  });
});
