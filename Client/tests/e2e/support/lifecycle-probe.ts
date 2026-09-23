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
  /** Cycle number, -1 for an asserted idle-phase sample, or -2 for an idle
   *  sample taken before the app's own auto-idle transition. */
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

/** A count metric the soak asserts. */
export type CountMetric =
  | "documents"
  | "nodes"
  | "listeners"
  | "abortControllers"
  | "intervals"
  | "timeouts"
  | "sockets"
  | "peerConnections"
  | "tracks"
  | "audioContexts";

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
  // Timers are read twice, at least a second apart, and the lower read counts:
  // a short timer the app is running at that instant (a debounce, a re-armed
  // poll) is not accumulation, while a leaked one is still pending on both
  // reads. A single read caught one such timer in 80 samples of the long run.
  const readLedger = () =>
    page.evaluate(() => {
      const state = (
        window as unknown as {
          __ocTimerLedger?: { timeouts: Set<number>; intervals: Set<number> };
        }
      ).__ocTimerLedger;
      return { timeouts: state?.timeouts.size ?? 0, intervals: state?.intervals.size ?? 0 };
    });
  const firstLedger = await readLedger();
  const firstLedgerAt = Date.now();
  // Two retainers exist only because the soak observes the page. V8 keeps
  // every console argument alive while an inspector session is attached
  // (livekit logs its E2EE worker, which reaches the whole Room), and the
  // media probe keeps every peer, socket and track it has seen. Drop both
  // before the GC so the counters read what the app holds.
  await cdp.send("Runtime.discardConsoleEntries");
  await page.evaluate(() => {
    const probe = (
      window as unknown as {
        __ocMedia?: {
          peers: RTCPeerConnection[];
          signaling: WebSocket[];
          tracks: MediaStreamTrack[];
        };
      }
    ).__ocMedia;
    if (probe === undefined) return;
    probe.peers = probe.peers.filter((peer) => peer.connectionState !== "closed");
    probe.signaling = probe.signaling.filter((socket) => socket.readyState <= WebSocket.OPEN);
    probe.tracks = probe.tracks.filter((track) => track.readyState === "live");
  });
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const counters = await cdp.send("Memory.getDOMCounters");
  const heap = await cdp.send("Runtime.getHeapUsage");
  await page.waitForTimeout(Math.max(0, firstLedgerAt + 1000 - Date.now()));
  const secondLedger = await readLedger();
  const ledger = {
    timeouts: Math.min(firstLedger.timeouts, secondLedger.timeouts),
    intervals: Math.min(firstLedger.intervals, secondLedger.intervals),
  };
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

/** Per-metric phase-series slope ceilings, in units per cycle; absent uses the
 *  plan's 0.05. Empty since 11c fixed the leaks that needed one. */
export type SlopeCeilings = Partial<Record<CountMetric, number>>;

export interface BarResult {
  metric: keyof Omit<LifecycleSample, "cycle" | "cycleAt">;
  warm: number | null;
  final: number;
  slope: number;
  bar: string;
  pass: boolean;
}

/**
 * Least-squares slope of y per **cycle** (not per sample index). Samples are 5
 * cycles apart, so regressing on the index would report a slope 5× the stated
 * bar; regressing on the cycle number keeps the "per cycle" labels honest.
 */
function slope(points: readonly { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((a, p) => a + p.x, 0) / n;
  const meanY = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const COUNT_METRICS: readonly CountMetric[] = [
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
];

/**
 * Evaluate the pass bars.
 *
 * The plan's cycle logs out every 10 cycles and samples every 5, so the raw
 * series alternates between two ages-since-login and a single least-squares
 * slope would read the reset (and give the mid-session sample no weight), not
 * the app. Samples are therefore grouped by their phase in the 10-cycle login
 * generation (`cycle % 10`): cycles 5/15/25 are one like-for-like mid-session
 * series, cycles 10/20 are the post-logout series. A metric passes only when
 * *every* group's per-cycle slope is within its ceiling. The soak's re-login
 * navigates, so a phase series compares samples from different pages: it sees
 * growth that survives the navigation, but not growth the navigation releases.
 *
 * The within-page series closes that gap: every sample not taken right after a
 * reconnect or logout (`cycle % 5 !== 0`) is grouped by its page (`cycle / 10`),
 * and each page's samples must hold the plan's bar. Heap is not asserted within
 * a page: V8 compiles and tiers up code as a page ages (about 1 MB of `(code)`
 * over five cycles in a heap-snapshot diff), so page age, not a leak, moves it;
 * the phase series compare heap at equal page age.
 *
 * `slopeCeilings` raises the phase-series ceiling of a metric with a known,
 * recorded leak that survives the navigation, so the gate still fails on any
 * growth past the measured slope. It never applies to the within-page series.
 * `documents` and `intervals` must be exactly flat in every group.
 */
export function evaluateBars(
  samples: readonly LifecycleSample[],
  slopeCeilings: SlopeCeilings = {},
): BarResult[] {
  const post = samples.filter((s) => s.cycle > 0);
  if (post.length < 2) return [];

  // Group by phase in the 10-cycle login generation; each group is a
  // like-for-like series at the same age since the last login.
  const groups = new Map<number, LifecycleSample[]>();
  for (const sample of post) {
    const phase = sample.cycle % 10;
    groups.set(phase, [...(groups.get(phase) ?? []), sample]);
  }
  // Like-for-like samples within one page: neither right after a reconnect
  // nor after the logout that starts the page.
  const pages = new Map<number, LifecycleSample[]>();
  for (const sample of post) {
    if (sample.cycle % 5 === 0) continue;
    const page = Math.floor(sample.cycle / 10);
    pages.set(page, [...(pages.get(page) ?? []), sample]);
  }
  const series: { label: string; group: LifecycleSample[]; withinPage: boolean }[] = [
    ...[...groups].map(([phase, group]) => ({ label: `phase ${phase}`, group, withinPage: false })),
    ...[...pages].map(([page, group]) => ({ label: `page ${page}`, group, withinPage: true })),
  ];

  const results: BarResult[] = [];
  for (const metric of COUNT_METRICS) {
    const phaseCeiling = slopeCeilings[metric] ?? COUNT_BAR_SLOPE;
    const exact = metric === "documents" || metric === "intervals";
    const failures: string[] = [];
    let worstSlope = 0;
    let lastWarm: number | null = null;
    let lastFinal = 0;
    for (const { label, group, withinPage } of series) {
      const values = group.map((s) => s[metric]);
      const measuredSlope = slope(group.map((s) => ({ x: s.cycle, y: s[metric] })));
      if (Math.abs(measuredSlope) >= Math.abs(worstSlope)) {
        worstSlope = measuredSlope;
        lastWarm = values[0]!;
        lastFinal = values[values.length - 1]!;
      }
      const flat = values.every((v) => v === values[0]);
      const ok = exact ? flat : measuredSlope <= (withinPage ? COUNT_BAR_SLOPE : phaseCeiling);
      if (!ok) failures.push(`${label}: ${values.join("→")}`);
    }
    const result: BarResult = {
      metric,
      warm: lastWarm,
      final: lastFinal,
      slope: worstSlope,
      bar: exact
        ? "every phase and page series exactly flat"
        : `every phase series slope <= ${phaseCeiling}/cycle, every page series <= ${COUNT_BAR_SLOPE}/cycle`,
      pass: failures.length === 0,
    };
    if (failures.length > 0) result.bar += ` — FAIL ${failures.join("; ")}`;
    results.push(result);
  }

  // Heap gets the same like-for-like treatment as the counts: compare each
  // generation series against itself, so the intended post-logout drop is not
  // read as a breach and a real heap leak still shows.
  const heapFailures: string[] = [];
  let heapSlope = 0;
  let heapFirst: number | null = null;
  let heapLast = 0;
  for (const [phase, group] of groups) {
    const values = group.map((s) => s.heapUsed);
    const measured = slope(group.map((s) => ({ x: s.cycle, y: s.heapUsed })));
    if (Math.abs(measured) >= Math.abs(heapSlope)) {
      heapSlope = measured;
      heapFirst = values[0]!;
      heapLast = values[values.length - 1]!;
    }
    if (values[values.length - 1]! > values[0]! * HEAP_BAR_RATIO || measured > HEAP_BAR_SLOPE)
      heapFailures.push(`phase ${phase}: ${values.join("→")}`);
  }
  results.push({
    metric: "heapUsed",
    warm: heapFirst,
    final: heapLast,
    slope: heapSlope,
    bar: `every generation series last <= first * ${HEAP_BAR_RATIO} and slope <= ${HEAP_BAR_SLOPE}/cycle`,
    pass: heapFailures.length === 0,
  });
  if (heapFailures.length > 0)
    results[results.length - 1]!.bar += ` — FAIL ${heapFailures.join("; ")}`;
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
