import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const instance = argv[argv.indexOf("--instance") + 1] ?? argv.find((arg) => arg.startsWith("--instance="))?.slice("--instance=".length);
  if (!instance) {
    console.error("Missing --instance <id>.");
    process.exitCode = 1;
    return;
  }
  const root = resolve(homedir(), ".sydes-pi/swebench", instance);
  const stock = await latest(root, "stock");
  const sydes = await latest(root, "sydes");
  console.log(`Instance: ${instance}`);
  console.log("");
  row("Metric", "Stock", "Sydes");
  row("Official resolved", official(stock), official(sydes));
  row("API calls", val(stock?.summary?.usage?.apiCalls), val(sydes?.summary?.usage?.apiCalls));
  row("Tool calls", val(stock?.summary?.tools?.total), val(sydes?.summary?.tools?.total));
  row("Reads before edit", val(stock?.summary?.exploration?.readsBeforeFirstEdit), val(sydes?.summary?.exploration?.readsBeforeFirstEdit));
  row("Unique reads", val(stock?.summary?.exploration?.uniqueReads), val(sydes?.summary?.exploration?.uniqueReads));
  row("Repeated reads", val(stock?.summary?.exploration?.repeatedReads), val(sydes?.summary?.exploration?.repeatedReads));
  row("Searches", val(stock?.summary?.tools?.byName?.bash), val(sydes?.summary?.tools?.byName?.bash));
  row("Time to first edit", val(stock?.summary?.editing?.timeToFirstEditSeconds), val(sydes?.summary?.editing?.timeToFirstEditSeconds));
  row("Elapsed", val(stock?.summary?.agent?.elapsedSeconds), val(sydes?.summary?.agent?.elapsedSeconds));
  row("Input tokens", val(stock?.summary?.usage?.inputTokens), val(sydes?.summary?.usage?.inputTokens));
  row("Cached tokens", val(stock?.summary?.usage?.cachedTokens), val(sydes?.summary?.usage?.cachedTokens));
  row("Output tokens", val(stock?.summary?.usage?.outputTokens), val(sydes?.summary?.usage?.outputTokens));
  row("Cost", val(stock?.summary?.usage?.totalCost), val(sydes?.summary?.usage?.totalCost));
  row("Files changed", val(stock?.summary?.editing?.filesChanged?.length), val(sydes?.summary?.editing?.filesChanged?.length));
  row("Insertions/deletions", insDel(stock?.summary), insDel(sydes?.summary));
  if (sydes?.summary) {
    console.log("");
    console.log("Sydes diagnostics");
    console.log(`first3 priority hit: ${val(sydes.summary.exploration?.first3PriorityHitRate)}`);
    console.log(`first5 priority hit: ${val(sydes.summary.exploration?.first5PriorityHitRate)}`);
    console.log(`first10 priority hit: ${val(sydes.summary.exploration?.first10PriorityHitRate)}`);
    console.log(`impact guidance count: ${val(sydes.summary.sydes?.impactGuidanceCount)}`);
    console.log(`drift warnings: ${val(sydes.summary.sydes?.driftWarningCount)}`);
    console.log(`final drift severity: ${val(sydes.summary.sydes?.latestDriftSeverity)}`);
  }
}

async function latest(root: string, mode: "stock" | "sydes"): Promise<any | null> {
  const ids = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const id of ids) {
    const dir = join(root, id, mode);
    const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8").catch(() => "null"));
    const official = JSON.parse(await readFile(join(dir, "official-result.json"), "utf8").catch(() => "null"));
    if (summary || official) return { summary, official };
  }
  return null;
}

function official(run: any): string {
  if (!run?.official) return "n/a";
  return run.official.resolved ? "PASS" : "FAIL";
}

function val(value: unknown): string {
  return value === null || value === undefined ? "n/a" : String(value);
}

function insDel(summary: any): string {
  return summary ? `${val(summary.editing?.insertions)}/${val(summary.editing?.deletions)}` : "n/a";
}

function row(metric: string, stock: string, sydes: string): void {
  console.log(`${metric.padEnd(24)}${stock.padEnd(12)}${sydes}`);
}

void main();
