/**
 * B7-11a: the CDP lifecycle probe for the long-session soak.
 *
 * The static inventory test (tests/unit/lifecycle-ownership.test.ts) classifies
 * sites lexically; it cannot see a listener that outlives the thing it served.
 * This probe reads Chromium's own counters after a forced GC, so the soak can
 * prove there is no net growth across repeated session cycles.
 *
 * Every count is taken from the renderer after a quiesce step and two
 * `HeapProfiler.collectGarbage` calls. `Runtime.queryObjects` retains every
 * object it returns until its object group is released, so the release is part
 * of the measurement — without it a count can never fall.
 *
 * The counters are the plan's metric table: DOM listeners, nodes, documents,
 * live `AbortController`s, live intervals and pending timeouts, open sockets
 * and peer connections, live tracks and `AudioContext`s, and JS heap.
 */
import type { CDPSession, Page } from "@playwright/test";

export interface LifecycleSample {
  /** Cycle number, or -1 for the idle-phase samples. */
  cycle: number;
  cycleAt: number;
  documents: number;
  nodes: number;
  listeners: number;
  abortControllers: number;
  intervals: number;
  timeouts: number;
  sockets: number;
  peerConnections: number;
  tracks: number;
  audioContexts: number;
  heapUsed: number;
}

const COUNT_BAR_SLOPE = 0.05;
const HEAP_BAR_RATIO = 1.1;
const HEAP_BAR_SLOPE = 25 * 1024;

/**
 * The timer ledger: an init script that wraps `setTimeout`/`setInterval` (and
 * their `clear` counterparts) into id sets. It records ids only, so it adds no
 * retention of its own — a leaked closure is exactly what a live id means.
 */
export async function installTimerLedger(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { timeouts: new Set<number>(), intervals: new Set<number>() };
    (window as unknown as { __ocTimerLedger: typeof state }).__ocTimerLedger = state;
    const realSetTimeout = window.setTimeout.bind(window);
    const realSetInterval = window.setInterval.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    const realClearInterval = window.clearInterval.bind(window);
    // Only function handlers are tracked: the app never passes a string, and
    // recompiling one would change when and where it runs.
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof handler !== "function")
        return realSetTimeout(handler, timeout) as unknown as number;
      let id = 0;
      // A fired timeout is no longer pending, so it removes its own id before
      // running the handler. The ledger counts only live timeouts.
      id = realSetTimeout(() => {
        state.timeouts.delete(id);
        handler(...args);
      }, timeout) as unknown as number;
      state.timeouts.add(id);
      return id;
    }) as typeof setTimeout;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof handler !== "function")
        return realSetInterval(handler, timeout) as unknown as number;
      const id = realSetInterval(() => handler(...args), timeout) as unknown as number;
      state.intervals.add(id);
      return id;
    }) as typeof setInterval;
    window.clearTimeout = ((id?: number) => {
      state.timeouts.delete(id as number);
      return realClearTimeout(id);
    }) as typeof clearTimeout;
    window.clearInterval = ((id?: number) => {
      state.intervals.delete(id as number);
      return realClearInterval(id);
    }) as typeof clearInterval;
  });
}

/**
 * Count the live instances of a built-in prototype. The filter runs inside the
 * page on the returned object array; objects that were collected before the
 * query are absent by construction.
 */
async function countInstances(cdp: CDPSession, prototype: string, filter: string): Promise<number> {
  const group = `probe-${prototype}-${Math.random().toString(36).slice(2)}`;
  const proto = await cdp.send("Runtime.evaluate", {
    expression: prototype,
    objectGroup: group,
  });
  if (proto.result.objectId === undefined) return 0;
  const objects = await cdp.send("Runtime.queryObjects", {
    prototypeObjectId: proto.result.objectId,
    objectGroup: group,
  });
  if (objects.objects.objectId === undefined) return 0;
  const counted = await cdp.send("Runtime.callFunctionOn", {
    objectId: objects.objects.objectId,
    functionDeclaration: `function () { return this.filter(${filter}).length; }`,
    returnByValue: true,
  });
  await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group });
  return typeof counted.result.value === "number" ? counted.result.value : 0;
}

/**
 * Quiesce the page, then read every metric. Callers pass the same `cdp` session
 * for the whole run so the object groups are released between samples.
 */
export async function sampleLifecycle(
  page: Page,
  cdp: CDPSession,
  cycle: number,
): Promise<LifecycleSample> {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const counters = await cdp.send("Memory.getDOMCounters");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const ledger = await page.evaluate(() => {
    const state = (
      window as unknown as { __ocTimerLedger?: { timeouts: Set<number>; intervals: Set<number> } }
    ).__ocTimerLedger;
    return {
      timeouts: state?.timeouts.size ?? 0,
      intervals: state?.intervals.size ?? 0,
    };
  });
  return {
    cycle,
    cycleAt: Date.now(),
    documents: counters.documents,
    nodes: counters.nodes,
    listeners: counters.jsEventListeners,
    // "Live" controllers: an aborted one is spent. Counting by reachability
    // alone would also count controllers a disposed attempt left behind inside
    // an object the media probe still holds (the "reachable never falls" trap),
    // so the signal state is what makes the count mean "still owning".
    abortControllers: await countInstances(
      cdp,
      "AbortController.prototype",
      "(c) => !c.signal.aborted",
    ),
    intervals: ledger.intervals,
    timeouts: ledger.timeouts,
    sockets: await countInstances(cdp, "WebSocket.prototype", "(s) => s.readyState <= 1"),
    peerConnections: await countInstances(
      cdp,
      "RTCPeerConnection.prototype",
      "(p) => p.connectionState !== 'closed'",
    ),
    tracks: await countInstances(
      cdp,
      "MediaStreamTrack.prototype",
      "(t) => t.readyState === 'live'",
    ),
    audioContexts: await countInstances(
      cdp,
      "AudioContext.prototype",
      "(c) => c.state !== 'closed'",
    ),
    heapUsed: heap.usedSize,
  };
}

export interface BarResult {
  metric: keyof Omit<LifecycleSample, "cycle" | "cycleAt">;
  warm: number | null;
  final: number;
  slope: number;
  bar: string;
  pass: boolean;
}

/** Least-squares slope of y over the sample indices. */
function slope(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const COUNT_METRICS = [
  "documents",
  "nodes",
  "listeners",
  "abortControllers",
  "intervals",
  "timeouts",
  "sockets",
  "peerConnections",
  "tracks",
  "audioContexts",
] as const;

/**
 * Evaluate the pass bars over the post-warm samples. Warm is the sample at
 * cycle 5; every later sample is the evidence.
 *
 * Count bar: the final sample is ≤ warm, and the least-squares slope over all
 * post-warm samples is ≤ 0.05 per cycle. Heap bar: final ≤ warm × 1.10 and
 * slope ≤ 25 KB per cycle. `documents` and `intervals` must be exactly equal to
 * warm at every sample.
 */
export function evaluateBars(samples: readonly LifecycleSample[]): BarResult[] {
  const warmIndex = samples.findIndex((s) => s.cycle === 5);
  const warm = warmIndex === -1 ? samples[0] : samples[warmIndex];
  const post = samples.filter((s) => s.cycle > 5);
  if (warm === undefined || post.length === 0) return [];

  const results: BarResult[] = [];
  for (const metric of COUNT_METRICS) {
    const values = post.map((s) => s[metric]);
    const final = values[values.length - 1]!;
    const measuredSlope = slope(values);
    const exact = metric === "documents" || metric === "intervals";
    const pass = exact
      ? values.every((v) => v === warm[metric])
      : final <= warm[metric] && measuredSlope <= COUNT_BAR_SLOPE;
    results.push({
      metric,
      warm: warm[metric],
      final,
      slope: measuredSlope,
      bar: exact
        ? `every sample exactly ${warm[metric]}`
        : `final <= warm (${warm[metric]}) and slope <= ${COUNT_BAR_SLOPE}`,
      pass,
    });
  }

  const heapValues = post.map((s) => s.heapUsed);
  const heapFinal = heapValues[heapValues.length - 1]!;
  const heapSlope = slope(heapValues);
  results.push({
    metric: "heapUsed",
    warm: warm.heapUsed,
    final: heapFinal,
    slope: heapSlope,
    bar: `final <= warm * ${HEAP_BAR_RATIO} (${Math.round(warm.heapUsed * HEAP_BAR_RATIO)}) and slope <= ${HEAP_BAR_SLOPE}`,
    pass: heapFinal <= warm.heapUsed * HEAP_BAR_RATIO && heapSlope <= HEAP_BAR_SLOPE,
  });
  return results;
}

/** A compact one-line-per-metric report for the test output and the report JSON. */
export function formatBars(results: readonly BarResult[]): string {
  const header = "metric | warm | final | slope | bar | pass";
  const rows = results.map(
    (r) =>
      `${r.metric} | ${r.warm} | ${r.final} | ${r.slope.toFixed(3)} | ${r.bar} | ${r.pass ? "PASS" : "FAIL"}`,
  );
  return [header, ...rows].join("\n");
}

/**
 * The event types of the listeners still registered on a target, via
 * `DOMDebugger.getEventListeners`. The counts say a leak exists; this says
 * which events it holds, which is what a fix needs to start from.
 */
export async function describeLiveListeners(
  cdp: CDPSession,
  target: "window" | "document",
): Promise<string[]> {
  const group = `listeners-${target}`;
  const { result } = await cdp.send("Runtime.evaluate", { expression: target, objectGroup: group });
  if (result.objectId === undefined) return [];
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
    objectId: result.objectId,
  });
  await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group });
  return listeners.map((l) => l.type).toSorted();
}
