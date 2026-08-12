import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface ReportOptions {
  taskIds: string[];
  artifactsRoot: string;
}

function parseArgs(argv: string[]): ReportOptions {
  const taskValues = argv.flatMap((arg, index) => {
    if (arg === "--task") return [argv[index + 1]].filter(Boolean);
    if (arg.startsWith("--task=")) return [arg.slice("--task=".length)];
    return [];
  });
  return {
    taskIds: taskValues.flatMap((value) => value.split(",")).filter(Boolean),
    artifactsRoot: resolve(homedir(), ".sydes-pi/benchmarks")
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.taskIds.length === 0) {
    console.error("Missing --task <task-id>.");
    process.exitCode = 1;
    return;
  }
  for (const taskId of options.taskIds) {
    await printTaskReport(options.artifactsRoot, taskId);
  }
}

async function printTaskReport(root: string, taskId: string): Promise<void> {
  const taskRoot = join(root, taskId);
  const stock = await latestModeSummary(taskRoot, "stock");
  const sydes = await latestModeSummary(taskRoot, "sydes");
  if (!stock && !sydes) {
    console.log(`${taskId}: no benchmark runs found`);
    return;
  }
  console.log(`Task: ${taskId}`);
  console.log(`Stock run: ${stock?.runId ?? "n/a"}`);
  console.log(`Sydes run: ${sydes?.runId ?? "n/a"}`);
  console.log("");
  printRow("Metric", "Stock", "Sydes");
  printRow("Correctness", pass(stock?.summary), pass(sydes?.summary));
  printRow("API calls", val(stock?.summary?.usage?.apiCalls), val(sydes?.summary?.usage?.apiCalls));
  printRow("Tool calls", val(stock?.summary?.tools?.total), val(sydes?.summary?.tools?.total));
  printRow("Reads before edit", val(stock?.summary?.exploration?.readsBeforeFirstEdit), val(sydes?.summary?.exploration?.readsBeforeFirstEdit));
  printRow("Unique reads", val(stock?.summary?.exploration?.uniqueReads), val(sydes?.summary?.exploration?.uniqueReads));
  printRow("Repeated reads", val(stock?.summary?.exploration?.repeatedReads), val(sydes?.summary?.exploration?.repeatedReads));
  printRow("Time to first edit", val(stock?.summary?.editing?.timeToFirstEditSeconds), val(sydes?.summary?.editing?.timeToFirstEditSeconds));
  printRow("Elapsed", val(stock?.summary?.agent?.elapsedSeconds), val(sydes?.summary?.agent?.elapsedSeconds));
  printRow("Input tokens", val(stock?.summary?.usage?.inputTokens), val(sydes?.summary?.usage?.inputTokens));
  printRow("Output tokens", val(stock?.summary?.usage?.outputTokens), val(sydes?.summary?.usage?.outputTokens));
  printRow("Files changed", val(stock?.summary?.editing?.filesChanged?.length), val(sydes?.summary?.editing?.filesChanged?.length));
  printRow("Insertions/deletions", insDel(stock?.summary), insDel(sydes?.summary));
}

async function readSummary(path: string): Promise<any | null> {
  return JSON.parse(await readFile(path, "utf8").catch(() => "null"));
}

async function latestModeSummary(taskRoot: string, mode: "stock" | "sydes"): Promise<{ runId: string; summary: any } | null> {
  const runIds = (await readdir(taskRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const runId of runIds) {
    const summary = await readSummary(join(taskRoot, runId, mode, "summary.json"));
    if (summary) return { runId, summary };
  }
  return null;
}

function pass(summary: any | null): string {
  return summary?.correctness?.taskCorrectness ?? "n/a";
}

function val(value: unknown): string {
  return value === null || value === undefined ? "n/a" : String(value);
}

function insDel(summary: any | null): string {
  if (!summary) return "n/a";
  return `${val(summary.editing?.insertions)}/${val(summary.editing?.deletions)}`;
}

function printRow(metric: string, stock: string, sydes: string): void {
  console.log(`${metric.padEnd(24)}${stock.padEnd(12)}${sydes}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
