import { parseSweArgs, runSweBench } from "../src/benchmark/swebench.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const base = parseSweArgs(argv);
  const dryRun = argv.includes("--dry-run");
  const confirm = argv.includes("--confirm-paid-runs");
  if (!base.instanceId) {
    console.error("Missing --instance <id>.");
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !confirm) {
    console.error("Refusing to start paired paid SWE-bench run.");
    console.error("swe:pair will make TWO paid model calls. Re-run with --confirm-paid-runs.");
    process.exitCode = 1;
    return;
  }
  const runId = base.runId ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z-swe-pair");
  console.log(dryRun ? "Paired SWE dry run: no model generation will be started." : "Paired SWE benchmark: this will make TWO paid model calls.");
  const stock = await runSweBench({ ...base, mode: "stock", dryRun, confirmPaidRun: confirm, runId });
  if (stock !== 0) {
    process.exitCode = stock;
    return;
  }
  process.exitCode = await runSweBench({ ...base, mode: "sydes", dryRun, confirmPaidRun: confirm, runId });
}

void main();
