import { parseSweRepeatArgs, runSweRepeat } from "../src/benchmark/swe-repeat.js";

async function main(): Promise<void> {
  try {
    process.exitCode = await runSweRepeat(parseSweRepeatArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
