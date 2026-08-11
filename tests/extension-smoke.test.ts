import { describe, expect, it } from "vitest";
import sydesPiExtension, { createSydesExtension } from "../src/extension.js";

describe("createSydesExtension", () => {
  it("creates a foundation extension without registering Pi tools", () => {
    const extension = createSydesExtension();

    expect(extension.name).toBe("sydes");
    expect(extension.phase).toBe("foundation");
    expect(extension.cbm).toBeDefined();
  });

  it("exports a Pi extension factory", () => {
    expect(() => sydesPiExtension({} as never)).not.toThrow();
  });
});
