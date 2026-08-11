import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CbmClient } from "../src/cbm/client.js";
import { buildExplorationGuidance, buildRelevantContext } from "../src/policy/exploration.js";

const execFileAsync = promisify(execFile);

const task =
  "POST /api/v1/pokemon with hp=0 must return HTTP 400; preserve existing valid POST behavior. Update or add the relevant tests, run the affected tests, and make only the minimal necessary changes.";
const baseCommit = "5d6a96f373b67afddbafaa0ab7d26e61fb3bf3f0";
const sourceRepo = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sydes-worktree-policy-"));
  const worktree = join(root, "pokemon-api");
  const client = new CbmClient({ bin: cbmBin });
  try {
    await execFileAsync("git", ["clone", "--quiet", sourceRepo, worktree]);
    await execFileAsync("git", ["checkout", "--quiet", baseCommit], { cwd: worktree });

    const context = await buildRelevantContext(task, worktree, client, {
      allowIndex: true,
      projectCache: new Map()
    });
    if (!context) {
      throw new Error("Sydes worktree policy did not produce context");
    }
    if (context.entryPoints.length === 0 || context.files.length === 0) {
      throw new Error("Sydes worktree policy produced empty priority context");
    }
    const surfaced = [...context.files, ...context.tests, ...context.entryPoints.map((entry) => entry.filePath ?? "")]
      .join("\n")
      .toLowerCase();
    for (const expected of ["handler", "service", "repository"]) {
      if (!surfaced.includes(expected)) {
        throw new Error(`Sydes worktree policy did not surface ${expected} path`);
      }
    }

    const guidance = buildExplorationGuidance(context);
    console.log(`worktree: ${worktree}`);
    console.log(`resolved project: ${context.project}`);
    console.log(`indexedThisSession: ${context.projectIndexedThisSession ? "yes" : "no"}`);
    console.log(`project ensure elapsed ms: ${context.projectEnsureElapsedMs ?? "n/a"}`);
    console.log(`project index elapsed ms: ${context.projectIndexElapsedMs ?? "n/a"}`);
    console.log(`readiness wait ms: ${context.projectReadinessWaitMs ?? "n/a"}`);
    console.log(`readiness polls: ${context.projectReadinessPollCount ?? "n/a"}`);
    console.log(`readiness strategy: ${context.projectReadinessStrategy ?? "n/a"}`);
    console.log(`context query elapsed ms: ${context.querySummary.elapsedMs}`);
    console.log(`entry points: ${context.entryPoints.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ")}`);
    console.log(`files: ${context.files.join(", ")}`);
    console.log(`tests: ${context.tests.join(", ") || "none"}`);
    console.log("guidance:");
    console.log(guidance);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
