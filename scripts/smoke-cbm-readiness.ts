import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CbmClient } from "../src/cbm/client.js";
import { ensureProjectForRepo } from "../src/policy/exploration.js";

const execFileAsync = promisify(execFile);

const sourceRepo = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");
const probeQuery = "InitRoutes AddPokemon addPokemon";

interface CbmEnvelope<T> {
  structuredContent?: T;
}

interface SearchRows {
  total?: number;
  cols?: string[];
  rows?: unknown[][];
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sydes-cbm-readiness-"));
  const worktree = join(root, "pokemon-api");
  const client = new CbmClient({ bin: cbmBin });
  try {
    await execFileAsync("git", ["clone", "--quiet", sourceRepo, worktree]);
    const resolution = await ensureProjectForRepo(worktree, client, {
      allowIndex: true,
      readinessProbeQuery: probeQuery
    });
    if (!resolution.project) {
      throw new Error(`CBM readiness smoke could not resolve indexed project: ${resolution.reason ?? "unknown"}`);
    }
    if (!resolution.indexedThisSession) {
      throw new Error("CBM readiness smoke expected a fresh temp repo to index this session");
    }
    if (resolution.readinessStrategy?.startsWith("timeout")) {
      throw new Error(`CBM readiness timed out using ${resolution.readinessStrategy}`);
    }

    const search = await client.searchGraphByArgs({
      project: resolution.project.name,
      query: probeQuery,
      limit: 5
    });
    const rows = rowsFromSearch(unwrapStructured<SearchRows>(search.parsed));
    if (rows.length === 0) {
      throw new Error("CBM readiness smoke produced zero immediate graph results after readiness");
    }

    console.log(`project: ${resolution.project.name}`);
    console.log(`index elapsed ms: ${resolution.indexElapsedMs ?? "n/a"}`);
    console.log(`readiness wait ms: ${resolution.readinessWaitMs ?? "n/a"}`);
    console.log(`readiness polls: ${resolution.readinessPollCount ?? "n/a"}`);
    console.log(`readiness strategy: ${resolution.readinessStrategy ?? "n/a"}`);
    console.log(`query: ${probeQuery}`);
    console.log(`result count: ${rows.length}`);
    console.log(`matches: ${rows.slice(0, 3).map((row) => row.qn).join(", ")}`);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

function rowsFromSearch(search: SearchRows | null): Array<Record<string, unknown>> {
  if (!search?.rows || !search.cols) {
    return [];
  }
  return search.rows.map((row) => Object.fromEntries(search.cols!.map((col, index) => [col, row[index]])));
}

function unwrapStructured<T>(value: unknown): T | null {
  const envelope = value as CbmEnvelope<T> | T | null;
  if (envelope && typeof envelope === "object" && "structuredContent" in envelope) {
    return (envelope as CbmEnvelope<T>).structuredContent ?? null;
  }
  return (value as T) ?? null;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
