import { importSweInstance, SWE_DATASET } from "../src/benchmark/swebench.js";

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const instanceId = valueAfter(argv, "--instance") ?? argv.find((arg) => arg.startsWith("--instance="))?.slice("--instance=".length);
  if (!instanceId) {
    console.error("Missing --instance <instance_id>.");
    process.exitCode = 1;
    return;
  }
  const manifest = await importSweInstance({ instanceId, dataset: SWE_DATASET });
  console.log(`imported: ${manifest.instance_id}`);
  console.log(`dataset: ${manifest.dataset}`);
  console.log(`revision: ${manifest.datasetRevision ?? "unknown"}`);
  console.log(`repo: ${manifest.repo}`);
  console.log(`base_commit: ${manifest.base_commit}`);
  console.log(`FAIL_TO_PASS: ${manifest.FAIL_TO_PASS.length}`);
  console.log(`PASS_TO_PASS: ${manifest.PASS_TO_PASS.length}`);
  console.log(`image: ${manifest.image ?? "n/a"}`);
  console.log(`eval_type: ${manifest.eval_type ?? "n/a"}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
