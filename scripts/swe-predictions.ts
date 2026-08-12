import { resolve } from "node:path";
import { exportPredictions, type SweMode } from "../src/benchmark/swebench.js";

function values(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => {
    if (arg === flag) return [argv[index + 1]].filter(Boolean);
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)];
    return [];
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = (values(argv, "--mode")[0] ?? "stock") as SweMode;
  const instanceIds = values(argv, "--instance").flatMap((value) => value.split(",")).filter(Boolean);
  const output = values(argv, "--output")[0];
  if (mode !== "stock" && mode !== "sydes") {
    console.error("Missing or invalid --mode <stock|sydes>.");
    process.exitCode = 1;
    return;
  }
  if (instanceIds.length === 0) {
    console.error("Missing --instance <id>.");
    process.exitCode = 1;
    return;
  }
  const path = await exportPredictions({ instanceIds, mode, outputPath: output ? resolve(output) : undefined });
  console.log(`predictions: ${path}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
