import { resolve } from "node:path";
import { CbmClient } from "../src/cbm/client.js";

const project = "Users-ksnaik-sample_repos-pokemon-api";
const cbmBin = resolve("node_modules/.bin/codebase-memory-mcp");

async function main(): Promise<void> {
  const client = new CbmClient({ bin: cbmBin });
  try {
    await client.warmup();
    const timings: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await client.searchGraph(project, "AddPokemon");
      timings.push(response.elapsedMs ?? -1);
    }

    console.log(`transport: ${client.transportKind}`);
    console.log(`process starts: ${client.processStartCount}`);
    timings.forEach((elapsedMs, index) => {
      console.log(`run ${index + 1}: ${elapsedMs} ms`);
    });

    if (client.transportKind === "persistent" && client.processStartCount !== 1) {
      throw new Error(`expected one persistent CBM process, saw ${client.processStartCount}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
