import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import sydesPiExtension from "../src/index.js";

const execFileAsync = promisify(execFile);

const piBin = resolve("node_modules/.bin/pi");
const extensionPath = resolve("src/index.ts");

async function main(): Promise<void> {
  const start = performance.now();
  const piAgentDir = await mkdtemp(resolve(tmpdir(), "sydes-pi-smoke-agent-"));
  const registrations = verifyRegistrations();
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: piAgentDir,
    PI_OFFLINE: "1"
  };

  const version = (await execFileAsync(piBin, ["--version"], { env })).stdout.trim();
  await execFileAsync(
    piBin,
    ["--offline", "--no-extensions", "--extension", extensionPath, "--list-models", "claude"],
    { env }
  );

  const elapsedMs = Math.round(performance.now() - start);
  console.log(`pi binary: ${piBin}`);
  console.log(`pi version: ${version}`);
  console.log(`extension: ${extensionPath}`);
  console.log(`registered commands: ${registrations.commands.join(", ")}`);
  console.log(`registered hooks: ${registrations.hooks.join(", ")}`);
  console.log("load path: --offline --no-extensions --extension ./src/index.ts --list-models claude");
  console.log(`elapsed ms: ${elapsedMs}`);
}

function verifyRegistrations(): { commands: string[]; hooks: string[] } {
  const commands: string[] = [];
  const hooks: string[] = [];
  sydesPiExtension({
    registerCommand: (name: string) => {
      commands.push(name);
    },
    on: (event: string) => {
      hooks.push(event);
    },
    registerTool: () => {
      throw new Error("Sydes must not register model-facing CBM tools");
    }
  } as never);

  if (!commands.includes("sydes-context")) {
    throw new Error("/sydes-context was not registered");
  }
  if (!commands.includes("sydes-impact")) {
    throw new Error("/sydes-impact was not registered");
  }
  if (!hooks.includes("before_agent_start")) {
    throw new Error("before_agent_start was not registered");
  }
  if (!hooks.includes("tool_result")) {
    throw new Error("tool_result was not registered");
  }
  if (!hooks.includes("agent_settled")) {
    throw new Error("agent_settled was not registered");
  }

  return { commands, hooks };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
