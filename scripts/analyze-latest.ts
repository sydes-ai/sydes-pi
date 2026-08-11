import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeSession } from "../src/telemetry/session-analyzer.js";

const defaultRunDir = resolve(
  process.env.HOME ?? "/Users/ksnaik",
  ".sydes-pi/runs/pokemon-api/20260811T133834Z-pokemon-sydes"
);

async function main(): Promise<void> {
  const runDir = process.argv.find((arg) => arg.startsWith("--run-dir="))?.slice("--run-dir=".length) ?? defaultRunDir;
  const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as { worktree: string; piSessionPath: string };
  const outputPath = join(runDir, "summary.corrected.json");
  const summary = await analyzeSession({
    sessionPath: run.piSessionPath,
    repoRoot: run.worktree,
    sydesPath: join(runDir, "sydes.json"),
    runJsonPath: join(runDir, "run.json"),
    finalDiffPath: join(runDir, "final.diff"),
    repoTestsPath: join(runDir, "repo-tests.txt"),
    oraclePath: join(runDir, "hidden-oracle.txt"),
    outputPath
  });
  const anySummary = summary as any;
  console.log(`summary: ${outputPath}`);
  console.log(`first3 reads: ${anySummary.exploration.first3Reads.join(", ")}`);
  console.log(`first3 hits: ${anySummary.exploration.first3PriorityHits.join(", ")}`);
  console.log(`first3 hit rate: ${anySummary.exploration.first3PriorityHitRate}`);
  console.log(`first5 hit rate: ${anySummary.exploration.first5PriorityHitRate}`);
  console.log(`first10 hit rate: ${anySummary.exploration.first10PriorityHitRate}`);
  console.log(`first priority read turn: ${anySummary.exploration.firstPriorityReadTurn}`);
  console.log(`turns: ${anySummary.agent.turns}`);
  console.log(`first edit turn: ${anySummary.editing.firstEditTurn}`);
  console.log(`elapsed seconds: ${anySummary.agent.elapsedSeconds}`);
  console.log(`time to first edit seconds: ${anySummary.editing.timeToFirstEditSeconds}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
