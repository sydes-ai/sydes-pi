import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import benchmarkRequestPacer, {
  MODEL_CALL_MIN_INTERVAL_ENV,
  MODEL_CALL_PACING_EVENTS_ENV,
  MODEL_TPM_BUDGET_ENV,
  createProviderRequestPacer,
  createRollingTpmPacer,
  estimateProviderPayloadTokens,
  parseMinIntervalMs,
  parseTpmBudget
} from "../src/benchmark/pi-request-pacer.js";

const tempRoots: string[] = [];

afterEach(async () => {
  delete process.env[MODEL_CALL_MIN_INTERVAL_ENV];
  delete process.env[MODEL_TPM_BUDGET_ENV];
  delete process.env[MODEL_CALL_PACING_EVENTS_ENV];
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("benchmark Pi request pacer", () => {
  it("is disabled by default", () => {
    const pi = fakePi();
    benchmarkRequestPacer(pi as never);
    expect(pi.handlers).toHaveLength(0);
    expect(parseMinIntervalMs(undefined)).toBe(0);
    expect(parseMinIntervalMs("bad")).toBe(0);
    expect(parseTpmBudget(undefined)).toBe(0);
    expect(parseTpmBudget("bad")).toBe(0);
  });

  it("paces first, repeated, and after-interval provider requests deterministically", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const events: unknown[] = [];
    const handler = createProviderRequestPacer(65_000, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      writeEvent: async (event) => {
        events.push(event);
      }
    });

    await expect(handler({ payload: "first" }, {})).resolves.toBeUndefined();
    now += 5_000;
    await expect(handler({ payload: "second" }, {})).resolves.toBeUndefined();
    now += 65_000;
    await expect(handler({ payload: "third" }, {})).resolves.toBeUndefined();

    expect(sleeps).toEqual([60_000]);
    expect(events).toMatchObject([
      { sequence: 1, waitedMs: 0 },
      { sequence: 2, waitedMs: 60_000 },
      { sequence: 3, waitedMs: 0 }
    ]);
    expect(JSON.stringify(events)).not.toContain("first");
    expect(JSON.stringify(events)).not.toContain("second");
    expect(JSON.stringify(events)).not.toContain("third");
  });

  it("records minimal JSONL events without replacing the payload", async () => {
    const root = await tempRoot();
    const eventsPath = join(root, "provider-pacing-events.jsonl");
    process.env[MODEL_CALL_MIN_INTERVAL_ENV] = "5";
    process.env[MODEL_CALL_PACING_EVENTS_ENV] = eventsPath;
    const pi = fakePi();
    benchmarkRequestPacer(pi as never);

    expect(pi.handlers).toHaveLength(1);
    await expect(pi.handlers[0]({ type: "before_provider_request", payload: { unchanged: true } }, { signal: undefined })).resolves.toBeUndefined();
    await expect(pi.handlers[0]({ type: "before_provider_request", payload: { unchanged: true } }, { signal: undefined })).resolves.toBeUndefined();

    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ sequence: 1, waitedMs: 0 });
    expect(events[1].sequence).toBe(2);
    expect(events[1].waitedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toContain("unchanged");
  });

  it("sends first request under rolling budget without waiting", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const events: unknown[] = [];
    const payload = providerPayload("abcd", 10);
    const before = JSON.stringify(payload);
    const handler = createRollingTpmPacer(100, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      estimateTokens: () => 20,
      writeEvent: async (event) => { events.push(event); }
    });

    await expect(handler(payload, {})).resolves.toBeUndefined();

    expect(sleeps).toEqual([]);
    expect(JSON.stringify(payload)).toBe(before);
    expect(events).toMatchObject([
      { sequence: 1, estimatedTokens: 20, rollingTokensBefore: 0, configuredBudget: 100, waitedMs: 0, oversizedRequest: false }
    ]);
  });

  it("allows multiple small requests below rolling budget without waiting", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const events: unknown[] = [];
    const handler = createRollingTpmPacer(100, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      estimateTokens: () => 30,
      writeEvent: async (event) => { events.push(event); }
    });

    await handler(providerPayload("one"), {});
    now += 10_000;
    await handler(providerPayload("two"), {});
    now += 10_000;
    await handler(providerPayload("three"), {});

    expect(sleeps).toEqual([]);
    expect(events).toMatchObject([
      { rollingTokensBefore: 0, waitedMs: 0 },
      { rollingTokensBefore: 30, waitedMs: 0 },
      { rollingTokensBefore: 60, waitedMs: 0 }
    ]);
  });

  it("waits only until enough prior rolling load expires", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const events: unknown[] = [];
    const handler = createRollingTpmPacer(100, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      estimateTokens: () => 60,
      writeEvent: async (event) => { events.push(event); }
    });

    await handler(providerPayload("one"), {});
    now += 10_000;
    await handler(providerPayload("two"), {});

    expect(sleeps).toEqual([50_000]);
    expect(events).toMatchObject([
      { rollingTokensBefore: 0, waitedMs: 0 },
      { rollingTokensBefore: 0, waitedMs: 50_000 }
    ]);
    expect(now).toBe(60_000);
  });

  it("removes records older than the rolling window", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const events: unknown[] = [];
    const handler = createRollingTpmPacer(100, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      estimateTokens: () => 70,
      writeEvent: async (event) => { events.push(event); }
    });

    await handler(providerPayload("old"), {});
    now = 60_001;
    await handler(providerPayload("new"), {});

    expect(sleeps).toEqual([]);
    expect(events).toMatchObject([
      { rollingTokensBefore: 0 },
      { rollingTokensBefore: 0 }
    ]);
  });

  it("allows oversized single requests and records them without deadlock", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const events: unknown[] = [];
    const handler = createRollingTpmPacer(100, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      estimateTokens: () => 150,
      writeEvent: async (event) => { events.push(event); }
    });

    await handler(providerPayload("oversized"), {});

    expect(sleeps).toEqual([]);
    expect(events).toMatchObject([
      { estimatedTokens: 150, configuredBudget: 100, waitedMs: 0, oversizedRequest: true }
    ]);
  });

  it("estimates OpenAI Responses payload load without persisting contents", () => {
    const payload = providerPayload("abcdefgh", 16);
    expect(estimateProviderPayloadTokens(payload)).toBeGreaterThanOrEqual(16);
    expect(estimateProviderPayloadTokens({ type: "before_provider_request", payload })).toBe(estimateProviderPayloadTokens(payload));
  });

  it("uses TPM pacing ahead of fixed interval when both env vars are set", async () => {
    const root = await tempRoot();
    const eventsPath = join(root, "provider-pacing-events.jsonl");
    process.env[MODEL_CALL_MIN_INTERVAL_ENV] = "65000";
    process.env[MODEL_TPM_BUDGET_ENV] = "180000";
    process.env[MODEL_CALL_PACING_EVENTS_ENV] = eventsPath;
    const pi = fakePi();
    benchmarkRequestPacer(pi as never);

    expect(pi.handlers).toHaveLength(1);
    await expect(pi.handlers[0](providerPayload("small", 16), { signal: undefined })).resolves.toBeUndefined();

    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ configuredBudget: 180000, waitedMs: 0, oversizedRequest: false });
    expect(events[0]).toHaveProperty("estimatedTokens");
    expect(events[0]).toHaveProperty("rollingTokensBefore");
  });
});

function fakePi(): { handlers: Array<(event: unknown, ctx: { signal?: AbortSignal }) => Promise<unknown>>; on: (event: string, handler: (event: unknown, ctx: { signal?: AbortSignal }) => Promise<unknown>) => void } {
  return {
    handlers: [],
    on(event, handler) {
      if (event === "before_provider_request") this.handlers.push(handler);
    }
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sydes-pacer-test-"));
  tempRoots.push(root);
  return root;
}

function providerPayload(text: string, maxOutputTokens = 0): Record<string, unknown> {
  return {
    model: "gpt-5-nano",
    input: [{ role: "user", content: [{ type: "input_text", text }] }],
    stream: true,
    max_output_tokens: maxOutputTokens,
    store: false
  };
}
