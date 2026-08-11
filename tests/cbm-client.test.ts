import { describe, expect, it } from "vitest";
import { CbmClient, serializeArgs } from "../src/cbm/client.js";

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
});
