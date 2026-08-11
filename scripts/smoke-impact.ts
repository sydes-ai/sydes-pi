import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CbmClient } from "../src/cbm/client.js";
import { buildAffectedContext, buildImpactGuidance } from "../src/policy/impact.js";

const execFileAsync = promisify(execFile);
const sourceRepo = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");

async function main(): Promise<void> {
  const originalStatus = await gitStatus(sourceRepo);
  const tempRoot = await mkdtemp(join(tmpdir(), "sydes-impact-"));
  const repoCopy = join(tempRoot, "pokemon-api");
  const client = new CbmClient({ bin: cbmBin });

  try {
    await execFileAsync("git", ["clone", "--quiet", sourceRepo, repoCopy]);
    await makeTinyMutation(repoCopy);
    await client.run("index_repository", {
      "repo-path": repoCopy,
      name: "sydes-impact-smoke",
      mode: "fast"
    });
    await client.warmup();
    const context = await buildAffectedContext(repoCopy, client);
    if (!context) {
      throw new Error("Sydes impact smoke did not produce context");
    }
    const guidance = buildImpactGuidance(context);
    const finalOriginalStatus = await gitStatus(sourceRepo);
    if (finalOriginalStatus !== originalStatus) {
      throw new Error("Pokemon source repo status changed during smoke");
    }
    await execFileAsync("git", ["restore", "."], { cwd: repoCopy });
    const finalCopyStatus = await gitStatus(repoCopy);
    if (finalCopyStatus) {
      throw new Error(`temporary Pokemon repo was not restored clean: ${finalCopyStatus}`);
    }

    console.log(`transport: ${client.transportKind}`);
    console.log(`process starts: ${client.processStartCount}`);
    console.log(`project: ${context.project}`);
    console.log(`changed files: ${context.changedFiles.join(", ")}`);
    console.log(`impacted symbols: ${context.impactedSymbols.map((symbol) => `${symbol.filePath}:${symbol.name}`).join(", ")}`);
    console.log(`routes: ${context.routes.map((route) => `${route.method ?? ""} ${route.path}`.trim()).join(", ") || "none"}`);
    console.log(`tests: ${context.tests.join(", ") || "none"}`);
    console.log(`detect_changes ms: ${context.querySummary.detectChangesElapsedMs ?? "n/a"}`);
    console.log(`total elapsed ms: ${context.querySummary.elapsedMs}`);
    console.log(`temporary repo restored clean: ${finalCopyStatus || "clean"}`);
    console.log(`source repo status preserved: ${finalOriginalStatus || "clean"}`);
    console.log("guidance:");
    console.log(guidance);
  } finally {
    await client.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function makeTinyMutation(repoPath: string): Promise<void> {
  const file = join(repoPath, "pkg/handler/pokedex.go");
  const original = await readFile(file, "utf8");
  const next = original.replace(
    "// Decode pokemon data from json",
    "// Decode pokemon payload from json"
  );
  if (next === original) {
    throw new Error("smoke mutation target not found");
  }
  await writeFile(file, next);
}

async function gitStatus(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: repoPath });
  return stdout.trim();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
