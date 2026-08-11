import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { CbmClient } from "../src/cbm/client.js";
import { buildExplorationGuidance, buildRelevantContext } from "../src/policy/exploration.js";

const task =
  "POST /api/v1/pokemon with hp=0 must return HTTP 400; preserve existing valid POST behavior. Update or add the relevant tests, run the affected tests, and make only the minimal necessary changes.";
const repoPath = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");

async function main(): Promise<void> {
  const client = new CbmClient({ bin: cbmBin });
  try {
    const warmupStart = performance.now();
    await client.warmup();
    const warmupMs = Math.round(performance.now() - warmupStart);
    const context = await buildRelevantContext(task, repoPath, client, {
      allowIndex: true
    });
    if (!context) {
      throw new Error("Sydes policy did not produce context");
    }

    const guidance = buildExplorationGuidance(context);
    console.log(`transport: ${client.transportKind}`);
    console.log(`process starts: ${client.processStartCount}`);
    console.log(`warmup ms: ${warmupMs}`);
    console.log(`project: ${context.project}`);
    console.log(`query count: ${context.querySummary.queryCount}`);
    console.log(`graph elapsed ms: ${context.querySummary.elapsedMs}`);
    console.log(
      `per-call elapsed: ${
        context.querySummary.calls?.map((call) => `${call.name}=${call.elapsedMs}ms`).join(", ") ?? "none"
      }`
    );
    console.log(`entry points: ${context.entryPoints.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ")}`);
    console.log(`files: ${context.files.join(", ")}`);
    console.log(`tests: ${context.tests.join(", ") || "none"}`);
    console.log("guidance:");
    console.log(guidance);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
