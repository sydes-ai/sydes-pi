import { SWE_DATASET } from "../src/benchmark/swebench.js";

async function main(): Promise<void> {
  console.log(`Dataset: ${SWE_DATASET}`);
  console.log("Use swe:import -- --instance <id> to materialize selected instances.");
  console.log("Candidate listing intentionally avoids patch and test_patch fields.");
  console.log("Network-backed broad listing is not enabled in this thin adapter yet; inspect official dataset metadata before selecting pilot IDs.");
}

void main();
