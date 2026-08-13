import { analyzeSwePilot, parseSweAnalyzeArgs } from "../src/benchmark/swe-analysis.js";

const exitCode = await analyzeSwePilot(parseSweAnalyzeArgs(process.argv.slice(2)))
  .then(() => 0)
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });

process.exit(exitCode);
