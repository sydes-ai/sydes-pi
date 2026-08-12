import { parseSweArgs, runSweBench } from "../src/benchmark/swebench.js";

async function main(): Promise<void> {
  const options = parseSweArgs(process.argv.slice(2));
  if (options.mode !== "stock" && options.mode !== "sydes") {
    console.error("Missing or invalid --mode <stock|sydes>.");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runSweBench(options);
}

void main();
