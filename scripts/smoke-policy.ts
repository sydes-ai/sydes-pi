import { resolve } from "node:path";
import { CbmClient } from "../src/cbm/client.js";
import { buildExplorationGuidance, buildRelevantContext } from "../src/policy/exploration.js";

const task =
  "POST /api/v1/pokemon with hp=0 must return HTTP 400; preserve existing valid POST behavior. Update or add the relevant tests, run the affected tests, and make only the minimal necessary changes.";
const repoPath = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");

async function main(): Promise<void> {
  const context = await buildRelevantContext(task, repoPath, new CbmClient({ bin: cbmBin }), {
    allowIndex: true
  });
  if (!context) {
    throw new Error("Sydes policy did not produce context");
  }

  const guidance = buildExplorationGuidance(context);
  console.log(`project: ${context.project}`);
  console.log(`query count: ${context.querySummary.queryCount}`);
  console.log(`graph elapsed ms: ${context.querySummary.elapsedMs}`);
  console.log(`entry points: ${context.entryPoints.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ")}`);
  console.log(`files: ${context.files.join(", ")}`);
  console.log(`tests: ${context.tests.join(", ") || "none"}`);
  console.log("guidance:");
  console.log(guidance);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
