import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { canonicalRepoRelativePath } from "../src/policy/paths.js";

const execFileAsync = promisify(execFile);

describe("canonical repo path normalization", () => {
  it("normalizes absolute and relative repo paths to POSIX repo-relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sydes-paths-"));
    try {
      await execFileAsync("git", ["init", root]);
      await mkdir(join(root, "pkg/handler"), { recursive: true });
      await mkdir(join(root, "helpers"), { recursive: true });
      await mkdir(join(root, "pkg/repository"), { recursive: true });
      await writeFile(join(root, "pkg/handler/pokedex.go"), "");
      await writeFile(join(root, "pkg/handler/pokedex_test.go"), "");
      await writeFile(join(root, "helpers/helpers.go"), "");
      await writeFile(join(root, "pkg/repository/pokedex_postgres.go"), "");
      await execFileAsync("git", ["add", "."], { cwd: root });

      expect(canonicalRepoRelativePath(root, join(root, "pkg/handler/pokedex.go"))).toBe("pkg/handler/pokedex.go");
      expect(canonicalRepoRelativePath(root, "./pkg/handler/pokedex_test.go")).toBe("pkg/handler/pokedex_test.go");
      expect(canonicalRepoRelativePath(root, "helpers/helpers.go")).toBe("helpers/helpers.go");
      expect(canonicalRepoRelativePath(root, "pkg/repository/pokedex_postgres.go")).toBe("pkg/repository/pokedex_postgres.go");
      expect(canonicalRepoRelativePath(root, "handler/pokedex.go")).toBe("pkg/handler/pokedex.go");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
