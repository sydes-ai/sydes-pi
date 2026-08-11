import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CbmClient } from "../src/cbm/client.js";
import { analyzeChangeSurfaceDrift, buildChangeSurfaceGuidance, loadSourceSymbolsForDiff } from "../src/policy/drift.js";
import { ensureProjectForRepo } from "../src/policy/exploration.js";
import type { RelevantContext } from "../src/policy/types.js";

const execFileAsync = promisify(execFile);

const baseCommit = "5d6a96f373b67afddbafaa0ab7d26e61fb3bf3f0";
const sourceRepo = resolve(process.env.HOME ?? "/Users/ksnaik", "sample_repos/pokemon-api");
const runsRoot = resolve(process.env.HOME ?? "/Users/ksnaik", ".sydes-pi/runs/pokemon-api");
const badRunDir = join(runsRoot, "20260811T133834Z-pokemon-sydes");
const cleanRunDir = join(runsRoot, "20260811T152400Z-pokemon-sydes");
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sydes-drift-replay-"));
  const worktree = join(root, "pokemon-api");
  const client = new CbmClient({ bin: cbmBin });
  try {
    await prepareWorktree(worktree);
    const context = JSON.parse(await readFile(join(badRunDir, "preflight-context.json"), "utf8")) as RelevantContext;
    const resolution = await ensureProjectForRepo(worktree, client, {
      allowIndex: true,
      readinessProbeQuery: "AddPokemon Test_AddPokemon"
    });
    if (!resolution.project) {
      throw new Error("Could not prepare CBM project for drift replay");
    }
    const bad = await replaySavedDiff("bad", badRunDir, worktree, client, resolution.project.name, resolution.repoRoot ?? worktree, context, root);
    const badUnexpected = bad.unexpectedChangedSymbols.map((symbol) => symbol.name);
    if (bad.severity !== "medium" && bad.severity !== "high") {
      throw new Error(`Expected bad saved diff drift to be medium/high, got ${bad.severity}`);
    }
    for (const expected of ["Test_GetAll", "Test_GetById", "Test_UpdatePokemon"]) {
      if (!badUnexpected.includes(expected)) {
        throw new Error(`Expected bad saved diff to flag ${expected}`);
      }
    }

    const clean = await replaySavedDiff("clean", cleanRunDir, worktree, client, resolution.project.name, resolution.repoRoot ?? worktree, context, root);
    const cleanUnexpected = clean.unexpectedChangedSymbols.map((symbol) => symbol.name);
    if (clean.severity !== "none" && clean.severity !== "low") {
      throw new Error(`Expected latest clean diff drift to be none/low, got ${clean.severity}`);
    }
    if (cleanUnexpected.includes("Test_DeletePokemon")) {
      throw new Error("Latest clean diff must not flag Test_DeletePokemon");
    }
    if (!clean.expectedChangedSymbols.some((symbol) => symbol.name === "Test_AddPokemon_HPZero")) {
      throw new Error("Latest clean diff did not recognize Test_AddPokemon_HPZero as expected/new");
    }

    await execFileAsync("git", ["reset", "--hard", "--quiet", baseCommit], { cwd: worktree });
    const minimalDiff = await createMinimalPokemonDiff(worktree);
    const minimalPre = await loadSourceSymbolsForDiff(resolution.project.name, resolution.repoRoot ?? worktree, client, minimalDiff, context);
    await client.indexRepository(worktree);
    const minimalPost = await loadSourceSymbolsForDiff(resolution.project.name, resolution.repoRoot ?? worktree, client, minimalDiff, context);
    const minimal = analyzeChangeSurfaceDrift({
      relevantContext: context,
      diffText: minimalDiff,
      preEditSymbols: minimalPre,
      postEditSymbols: minimalPost
    });
    if (minimal.severity !== "none" && minimal.severity !== "low") {
      throw new Error(`Expected minimal diff drift to be none/low, got ${minimal.severity}`);
    }

    console.log(`bad severity: ${bad.severity}`);
    console.log(`bad unexpected symbols: ${badUnexpected.join(", ")}`);
    console.log(`bad reasons: ${bad.reasons.join("; ")}`);
    console.log(`bad insertions/deletions: ${bad.insertionCount}/${bad.deletionCount}`);
    console.log(`clean severity: ${clean.severity}`);
    console.log(`clean unexpected symbols: ${cleanUnexpected.join(", ") || "none"}`);
    console.log(`clean expected symbols: ${clean.expectedChangedSymbols.map((symbol) => symbol.name).join(", ") || "none"}`);
    console.log("warning:");
    console.log(buildChangeSurfaceGuidance(bad));
    console.log(`minimal severity: ${minimal.severity}`);
    console.log(`minimal unexpected symbols: ${minimal.unexpectedChangedSymbols.map((symbol) => symbol.name).join(", ") || "none"}`);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function prepareWorktree(worktree: string): Promise<void> {
  await execFileAsync("git", ["clone", "--quiet", sourceRepo, worktree]);
  await execFileAsync("git", ["checkout", "--quiet", baseCommit], { cwd: worktree });
}

async function replaySavedDiff(
  label: string,
  runDir: string,
  worktree: string,
  client: CbmClient,
  project: string,
  repoRoot: string,
  context: RelevantContext,
  root: string
) {
  await execFileAsync("git", ["reset", "--hard", "--quiet", baseCommit], { cwd: worktree });
  await client.indexRepository(worktree);
  const diffText = await readFile(join(runDir, "final.diff"), "utf8");
  const preEditSymbols = await loadSourceSymbolsForDiff(project, repoRoot, client, diffText, context);
  const diffPath = join(root, `${label}.diff`);
  await writeFile(diffPath, diffText);
  await execFileAsync("git", ["apply", diffPath], { cwd: worktree });
  await client.indexRepository(worktree);
  const postEditSymbols = await loadSourceSymbolsForDiff(project, repoRoot, client, diffText, context);
  return analyzeChangeSurfaceDrift({
    relevantContext: context,
    diffText,
    preEditSymbols,
    postEditSymbols
  });
}

async function createMinimalPokemonDiff(worktree: string): Promise<string> {
  const handlerPath = join(worktree, "pkg/handler/pokedex.go");
  const testPath = join(worktree, "pkg/handler/pokedex_test.go");
  const handler = await readFile(handlerPath, "utf8");
  await writeFile(
    handlerPath,
    handler
      .replace('import (\n\t"fmt"', 'import (\n\t"errors"\n\t"fmt"')
      .replace(
        "\t// Run DB query\n",
        '\tif pokemon.Hp <= 0 {\n\t\thelpers.RespondWithError(w, errors.New("hp must be greater than zero"), http.StatusBadRequest)\n\t\treturn\n\t}\n\n\t// Run DB query\n'
      )
  );
  const tests = await readFile(testPath, "utf8");
  await writeFile(
    testPath,
    tests.replace(
      '\t\t{\n\t\t\ttestName:    "Server error. Error"\n',
      '\t\t{\n\t\t\ttestName:    "HP zero. Bad request",\n\t\t\tinputString: `{"name":"Test","type":["TestType"],"hp":0,"attack":40,"defense":40}`,\n\t\t\tmock: func(s *service.MockPokedex, pokemon string) {},\n\t\t\twantStatusCode:  400,\n\t\t\twantResposeBody: `{"error":"hp must be greater than zero"}`,\n\t\t},\n\t\t{\n\t\t\ttestName:    "Server error. Error"\n'
    )
  );
  const diff = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=0"], { cwd: worktree });
  return diff.stdout;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
