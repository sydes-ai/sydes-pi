import { writeFile } from "node:fs/promises";
import { parseOfficialReport } from "../src/benchmark/swebench.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const report = argv[argv.indexOf("--report") + 1] ?? argv.find((arg) => arg.startsWith("--report="))?.slice("--report=".length);
  const output = argv[argv.indexOf("--output") + 1] ?? argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
  if (!report) {
    console.error("Missing --report <path>.");
    process.exitCode = 1;
    return;
  }
  const parsed = await parseOfficialReport(report);
  if (output) await writeFile(output, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(JSON.stringify(parsed, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
