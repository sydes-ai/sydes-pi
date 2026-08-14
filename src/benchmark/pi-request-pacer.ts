import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MODEL_CALL_MIN_INTERVAL_ENV = "SYDES_BENCH_MODEL_CALL_MIN_INTERVAL_MS";
export const MODEL_TPM_BUDGET_ENV = "SYDES_BENCH_MODEL_TPM_BUDGET";
export const MODEL_CALL_PACING_EVENTS_ENV = "SYDES_BENCH_PROVIDER_PACING_EVENTS_PATH";
export const MAX_PROVIDER_CALLS_ENV = "SYDES_BENCH_MAX_PROVIDER_CALLS";
const ROLLING_WINDOW_MS = 60_000;
const CHARS_PER_TOKEN = 4;
const PROVIDER_CALL_BUDGET_EXHAUSTED = "provider_call_budget_exhausted";

export interface ProviderPacingEvent {
  sequence: number;
  timestamp: string;
  estimatedTokens: number;
  rollingTokensBefore: number;
  configuredBudget: number;
  waitedMs: number;
  oversizedRequest: boolean;
  providerCallsStarted?: number;
  providerCallBudgetMax?: number;
  providerCallBudgetExhausted?: boolean;
  terminationReason?: typeof PROVIDER_CALL_BUDGET_EXHAUSTED;
}

export interface ProviderRequestPacerDeps {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  writeEvent?: (event: ProviderPacingEvent) => Promise<void>;
  estimateTokens?: (event: unknown) => number;
}

export default function benchmarkRequestPacer(pi: ExtensionAPI): void {
  const tpmBudget = parseTpmBudget(process.env[MODEL_TPM_BUDGET_ENV]);
  const minIntervalMs = parseMinIntervalMs(process.env[MODEL_CALL_MIN_INTERVAL_ENV]);
  const maxProviderCalls = parseMaxProviderCalls(process.env[MAX_PROVIDER_CALLS_ENV]);
  if (tpmBudget <= 0 && minIntervalMs <= 0 && maxProviderCalls <= 0) return;

  const eventsPath = process.env[MODEL_CALL_PACING_EVENTS_ENV];
  const pacer = tpmBudget > 0 ? createRollingTpmPacer(tpmBudget, {
    now: () => Date.now(),
    sleep,
    writeEvent: eventsPath ? (event) => writePacingEvent(eventsPath, event) : undefined
  }) : createProviderRequestPacer(minIntervalMs, {
    now: () => Date.now(),
    sleep,
    writeEvent: eventsPath ? (event) => writePacingEvent(eventsPath, event) : undefined
  });
  const handler = maxProviderCalls > 0
    ? createProviderCallBudget(maxProviderCalls, pacer, {
      now: () => Date.now(),
      writeEvent: eventsPath ? (event) => writePacingEvent(eventsPath, event) : undefined
    })
    : pacer;

  pi.on("before_provider_request", handler);
}

export function createProviderCallBudget(
  maxProviderCalls: number,
  next: (event: unknown, ctx: { signal?: AbortSignal }) => Promise<void>,
  deps: Pick<ProviderRequestPacerDeps, "now" | "writeEvent">
): (event: unknown, ctx: { signal?: AbortSignal }) => Promise<void> {
  let requestsStarted = 0;
  return async (event, ctx) => {
    if (requestsStarted >= maxProviderCalls) {
      if (deps.writeEvent) {
        await deps.writeEvent({
          sequence: requestsStarted + 1,
          timestamp: new Date(deps.now()).toISOString(),
          estimatedTokens: 0,
          rollingTokensBefore: 0,
          configuredBudget: maxProviderCalls,
          waitedMs: 0,
          oversizedRequest: false,
          providerCallsStarted: requestsStarted,
          providerCallBudgetMax: maxProviderCalls,
          providerCallBudgetExhausted: true,
          terminationReason: PROVIDER_CALL_BUDGET_EXHAUSTED
        });
      }
      throw new Error(PROVIDER_CALL_BUDGET_EXHAUSTED);
    }
    requestsStarted += 1;
    await next(event, ctx);
  };
}

export function createProviderRequestPacer(
  minIntervalMs: number,
  deps: ProviderRequestPacerDeps
): (_event: unknown, ctx: { signal?: AbortSignal }) => Promise<void> {
  let sequence = 0;
  let lastProviderRequestAt: number | undefined;
  return async (event, ctx) => {
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
        estimatedTokens: estimateProviderPayloadTokens(event),
        rollingTokensBefore: 0,
        configuredBudget: minIntervalMs,
        waitedMs,
        oversizedRequest: false
      });
    }
  };
}

export function createRollingTpmPacer(
  configuredBudget: number,
  deps: ProviderRequestPacerDeps
): (event: unknown, ctx: { signal?: AbortSignal }) => Promise<void> {
  let sequence = 0;
  const records: Array<{ startedAt: number; estimatedTokens: number }> = [];
  const estimate = deps.estimateTokens ?? estimateProviderPayloadTokens;
  return async (event, ctx) => {
    const requested = Math.max(1, Math.ceil(estimate(event)));
    let waitedMs = 0;
    let now = deps.now();
    pruneWindow(records, now);
    let rollingTokensBefore = sumTokens(records);
    const oversizedRequest = requested > configuredBudget;

    while (!oversizedRequest && rollingTokensBefore + requested > configuredBudget) {
      const waitMs = msUntilEnoughBudget(records, now, requested, configuredBudget);
      if (waitMs <= 0) break;
      await deps.sleep(waitMs, ctx.signal);
      waitedMs += waitMs;
      now = deps.now();
      pruneWindow(records, now);
      rollingTokensBefore = sumTokens(records);
    }

    const requestStartedAt = deps.now();
    pruneWindow(records, requestStartedAt);
    rollingTokensBefore = sumTokens(records);
    records.push({ startedAt: requestStartedAt, estimatedTokens: requested });
    sequence += 1;
    if (deps.writeEvent) {
      await deps.writeEvent({
        sequence,
        timestamp: new Date(requestStartedAt).toISOString(),
        estimatedTokens: requested,
        rollingTokensBefore,
        configuredBudget,
        waitedMs,
        oversizedRequest
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

export function parseTpmBudget(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function parseMaxProviderCalls(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function estimateProviderPayloadTokens(event: unknown): number {
  const payload = typeof event === "object" && event !== null && "payload" in event
    ? (event as { payload?: unknown }).payload
    : event;
  if (typeof payload !== "object" || payload === null) return estimateJsonTokens(payload);
  const request = payload as Record<string, unknown>;
  const requestTokens = estimateJsonTokens({
    input: request.input,
    tools: request.tools,
    tool_choice: request.tool_choice,
    reasoning: request.reasoning
  });
  const outputBudget = typeof request.max_output_tokens === "number" && Number.isFinite(request.max_output_tokens)
    ? Math.max(0, request.max_output_tokens)
    : 0;
  return requestTokens + outputBudget;
}

function estimateJsonTokens(value: unknown): number {
  return Math.max(1, Math.ceil(safeJsonStringify(value).length / CHARS_PER_TOKEN));
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function pruneWindow(records: Array<{ startedAt: number; estimatedTokens: number }>, now: number): void {
  while (records.length > 0 && now - records[0].startedAt >= ROLLING_WINDOW_MS) {
    records.shift();
  }
}

function sumTokens(records: Array<{ estimatedTokens: number }>): number {
  return records.reduce((sum, record) => sum + record.estimatedTokens, 0);
}

function msUntilEnoughBudget(
  records: Array<{ startedAt: number; estimatedTokens: number }>,
  now: number,
  requested: number,
  configuredBudget: number
): number {
  let used = sumTokens(records);
  for (const record of records) {
    used -= record.estimatedTokens;
    if (used + requested <= configuredBudget) {
      return Math.max(0, record.startedAt + ROLLING_WINDOW_MS - now);
    }
  }
  return ROLLING_WINDOW_MS;
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
