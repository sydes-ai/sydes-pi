import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MODEL_CALL_MIN_INTERVAL_ENV = "SYDES_BENCH_MODEL_CALL_MIN_INTERVAL_MS";
export const MODEL_CALL_PACING_EVENTS_ENV = "SYDES_BENCH_PROVIDER_PACING_EVENTS_PATH";

export interface ProviderPacingEvent {
  sequence: number;
  timestamp: string;
  waitedMs: number;
}

export interface ProviderRequestPacerDeps {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  writeEvent?: (event: ProviderPacingEvent) => Promise<void>;
}

export default function benchmarkRequestPacer(pi: ExtensionAPI): void {
  const minIntervalMs = parseMinIntervalMs(process.env[MODEL_CALL_MIN_INTERVAL_ENV]);
  if (minIntervalMs <= 0) return;

  const eventsPath = process.env[MODEL_CALL_PACING_EVENTS_ENV];
  const handler = createProviderRequestPacer(minIntervalMs, {
    now: () => Date.now(),
    sleep,
    writeEvent: eventsPath ? (event) => writePacingEvent(eventsPath, event) : undefined
  });

  pi.on("before_provider_request", handler);
}

export function createProviderRequestPacer(
  minIntervalMs: number,
  deps: ProviderRequestPacerDeps
): (_event: unknown, ctx: { signal?: AbortSignal }) => Promise<void> {
  let sequence = 0;
  let lastProviderRequestAt: number | undefined;
  return async (_event, ctx) => {
    const now = deps.now();
    const waitedMs = lastProviderRequestAt === undefined ? 0 : Math.max(0, minIntervalMs - (now - lastProviderRequestAt));
    if (waitedMs > 0) {
      await deps.sleep(waitedMs, ctx.signal);
    }
    const requestStartedAt = deps.now();
    lastProviderRequestAt = requestStartedAt;
    sequence += 1;
    if (deps.writeEvent) {
      await deps.writeEvent({
        sequence,
        timestamp: new Date(requestStartedAt).toISOString(),
        waitedMs
      });
    }
  };
}

export function parseMinIntervalMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(new Error("Benchmark provider request pacing aborted."));
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Benchmark provider request pacing aborted."));
    }, { once: true });
  });
}

async function writePacingEvent(path: string, data: ProviderPacingEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(data)}\n`);
}
