import { describe, expect, it, vi } from "vitest";
import sydesPiExtension, { createSydesExtension } from "../src/extension.js";

describe("createSydesExtension", () => {
  it("creates a foundation extension without registering Pi tools", () => {
    const extension = createSydesExtension();

    expect(extension.name).toBe("sydes");
    expect(extension.phase).toBe("foundation");
    expect(extension.cbm).toBeDefined();
  });

  it("exports a Pi extension factory", () => {
    expect(() =>
      sydesPiExtension({
        registerCommand: vi.fn(),
        on: vi.fn()
      } as never)
    ).not.toThrow();
  });

  it("enables tool-middleware mode from SYDES_INTEGRATION_MODE", () => {
    const previous = process.env.SYDES_INTEGRATION_MODE;
    process.env.SYDES_INTEGRATION_MODE = "tool-middleware";
    try {
      expect(createSydesExtension().integrationMode).toBe("tool-middleware");
    } finally {
      if (previous === undefined) {
        delete process.env.SYDES_INTEGRATION_MODE;
      } else {
        process.env.SYDES_INTEGRATION_MODE = previous;
      }
    }
  });
});
