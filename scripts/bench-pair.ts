import { parseBenchArgs, runBench } from "./bench.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const base = parseBenchArgs(argv);
  const confirm = argv.includes("--confirm-paid-runs");
  const dryRun = argv.includes("--dry-run");
  if (!base.taskId) {
    console.error("Missing --task <task-id>.");
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !confirm) {
    console.error("Refusing to start paired paid benchmark.");
    console.error("bench:pair will make TWO paid model runs. Re-run with --confirm-paid-runs.");
    process.exitCode = 1;
    return;
  }

  const runId = base.runId ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z-pair");
  console.log(dryRun ? "Paired dry run: no model generation will be started." : "Paired benchmark: this will make TWO paid model runs.");
  const stock = await runBench({ ...base, mode: "stock", dryRun, confirmPaidRun: confirm, runId });
  if (stock !== 0) {
    process.exitCode = stock;
    return;
  }
  const sydes = await runBench({ ...base, mode: "sydes", dryRun, confirmPaidRun: confirm, runId });
  process.exitCode = sydes;
}

void main();
