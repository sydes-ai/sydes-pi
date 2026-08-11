import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { CbmClient } from "../src/cbm/client.js";

const execFileAsync = promisify(execFile);

interface CbmCliEnvelope<T> {
  structuredContent?: T;
}

interface CbmProject {
  name: string;
  root_path: string;
}

interface ListProjects {
  projects: CbmProject[];
}

interface SearchGraph {
  total: number;
  rows?: unknown[][];
  has_more?: boolean;
}

const repoPath = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");
const queries = ["InitRoutes", "AddPokemon", "addPokemon"];

async function main(): Promise<void> {
  const start = performance.now();

  if (!existsSync(repoPath)) {
    throw new Error(`Pokemon sample repo not found: ${repoPath}`);
  }

  if (!existsSync(cbmBin)) {
    throw new Error(`Local Codebase Memory binary not found: ${cbmBin}`);
  }

  const client = new CbmClient({ bin: cbmBin });
  const version = await readVersion(cbmBin);
  let project = await findProject(client);

  if (!project) {
    await client.indexRepository(repoPath);
    project = await findProject(client);
  }

  if (!project) {
    throw new Error(`Codebase Memory did not return an indexed project for ${repoPath}`);
  }

  const results = [];
  for (const query of queries) {
    const response = await client.searchGraph(project.name, query);
    const search = unwrapStructured<SearchGraph>(response.parsed);
    if (search?.total) {
      results.push({ query, search });
    }
  }

  if (results.length === 0) {
    throw new Error(`No matching Pokemon symbols found for ${queries.join(", ")}`);
  }

  const best = results[0];
  const symbols = (best.search.rows ?? [])
    .slice(0, 3)
    .map((row) => String(row[0]))
    .join(", ");
  const elapsedMs = Math.round(performance.now() - start);

  console.log(`cbm binary: ${cbmBin}`);
  console.log(`cbm version: ${version}`);
  console.log(`project: ${project.name}`);
  console.log(`query: ${best.query}`);
  console.log(`result count: ${best.search.total}`);
  console.log(`symbols: ${symbols}`);
  console.log(`elapsed ms: ${elapsedMs}`);
}

async function findProject(client: CbmClient): Promise<CbmProject | null> {
  const response = await client.listProjects();
  const list = unwrapStructured<ListProjects>(response.parsed);
  return list?.projects.find((project) => project.root_path === repoPath) ?? null;
}

function unwrapStructured<T>(value: unknown): T | null {
  const envelope = value as CbmCliEnvelope<T> | null;
  return envelope?.structuredContent ?? null;
}

async function readVersion(bin: string): Promise<string> {
  const { stdout } = await execFileAsync(bin, ["--version"]);
  return stdout.trim();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
