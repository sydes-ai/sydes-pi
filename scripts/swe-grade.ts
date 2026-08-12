import { spawn } from "node:child_process";
import { buildGradeCommand } from "../src/benchmark/swebench.js";

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const predictions = valueAfter(argv, "--predictions") ?? argv.find((arg) => arg.startsWith("--predictions="))?.slice("--predictions=".length);
  const runId = valueAfter(argv, "--run-id") ?? argv.find((arg) => arg.startsWith("--run-id="))?.slice("--run-id=".length);
  const instance = valueAfter(argv, "--instance") ?? argv.find((arg) => arg.startsWith("--instance="))?.slice("--instance=".length);
  const maxWorkers = Number(valueAfter(argv, "--max-workers") ?? argv.find((arg) => arg.startsWith("--max-workers="))?.slice("--max-workers=".length) ?? "1");
  const dryRun = argv.includes("--dry-run");
  if (!predictions || !runId) {
    console.error("Usage: npm run swe:grade -- --predictions <path> --run-id <id> [--instance <id>] [--max-workers <n>] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const command = buildGradeCommand({ predictionsPath: predictions, runId, instanceId: instance, maxWorkers });
  console.log(`cwd: ${command.cwd}`);
  console.log(`command: ${[command.command, ...command.args].join(" ")}`);
  if (dryRun) {
    console.log("Dry run: upstream SWE-bench evaluator was not launched.");
    return;
  }
  process.exitCode = await new Promise<number>((resolveExit) => {
    const child = spawn(command.command, command.args, { cwd: command.cwd, stdio: "inherit" });
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

void main();
