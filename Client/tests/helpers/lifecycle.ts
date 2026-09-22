// The lifecycle guard for the unit suite (B7-11a).
//
// The console guard (tests/helpers/console.ts) proves a green run prints
// nothing unexplained. This guard is its sibling for the other half of
// teardown: a unit test must not leave a bare `window`/`document` listener or a
// real interval alive when it ends.
//
// It records only registrations that carry neither `once: true` nor a
// `signal` — those are the ones no teardown can be trusted to run. A
// registration that passes a `signal` releases its entry when the signal
// aborts, so a correctly-owned listener never trips it. `setTimeout` is out of
// scope: a pending timeout is a scheduling fact, not a retained owner, and the
// soak's timeout ledger is where that is measured.
//
// It is installed from tests/setup.ts, directly after `installConsoleGuard()`,
// and it copies the console guard's three load-bearing properties:
//
//   1. plain functions, not `vi.fn`, so a test file's own
//      `beforeEach(() => vi.restoreAllMocks())` cannot switch the recorder off;
//   2. per-test reset, so a leak is attributed to the test that made it;
//   3. a test that proves the guard fails (tests/unit/lifecycle-guard.test.ts).
//
// tests/lifecycle-guard-baseline.json lists the test files allowed to leak at
// the 11a base. The list is shrink-only: the guard fails a listed file that
// runs clean, so an entry cannot outlive its leak. 11b empties this list.
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

type ListenerTarget = Window | Document;

interface ListenerEntry {
  target: ListenerTarget;
  event: string;
  listener: unknown;
  capture: boolean;
}

interface IntervalEntry {
  handle: number;
}

// The real functions, captured once at module load — before any test file has
// had a chance to replace them — so the wrappers always delegate to the
// platform and afterEach can put the originals back.
const realAdd = {
  window: window.addEventListener.bind(window),
  document: document.addEventListener.bind(document),
};
const realRemove = {
  window: window.removeEventListener.bind(window),
  document: document.removeEventListener.bind(document),
};
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);

// jsdom implements `requestAnimationFrame` on top of its own internal
// `setInterval` (Window.js): the first pending frame of a burst starts the
// shared 60 Hz timer, and cancelling every frame clears it. That timer is
// jsdom's, not the app's, so the guard must not record it. jsdom starts it
// synchronously inside `requestAnimationFrame`, so a flag around that call is
// the deterministic discriminator — no stack inspection, no per-call string.
let inAnimationFrame = false;

let listeners: ListenerEntry[] = [];
let intervals: IntervalEntry[] = [];

function capture(target: ListenerTarget, options?: boolean | AddEventListenerOptions): boolean {
  if (typeof options === "object" && options !== null) return Boolean(options.capture);
  return Boolean(options);
}

function recordListener(
  target: ListenerTarget,
  event: string,
  listener: unknown,
  options?: boolean | AddEventListenerOptions,
): void {
  // A `once` listener removes itself, so it is never live at teardown. Every
  // other registration is recorded: a bare one is a leak unless the test
  // removes it, and a `signal`-owned one stays recorded until its signal
  // aborts — which is exactly how a component that was never destroyed is
  // caught, even though every listener it registered carried a signal.
  if (typeof options === "object" && options !== null && options.once === true) return;

  const entry: ListenerEntry = {
    target,
    event,
    listener,
    capture: capture(target, options),
  };

  const signal = typeof options === "object" && options !== null ? options.signal : undefined;
  if (signal !== undefined) {
    if (signal.aborted) return;
    listeners.push(entry);
    signal.addEventListener("abort", () => forgetListener(entry), { once: true });
    return;
  }

  listeners.push(entry);
}

function forgetListener(entry: ListenerEntry): void {
  listeners = listeners.filter((e) => e !== entry);
}

function dropListener(
  target: ListenerTarget,
  event: string,
  listener: unknown,
  options?: boolean | AddEventListenerOptions,
): void {
  const captureFlag = capture(target, options);
  listeners = listeners.filter(
    (e) =>
      !(
        e.target === target &&
        e.event === event &&
        e.listener === listener &&
        e.capture === captureFlag
      ),
  );
}

/** The test file the guard is currently running, or undefined outside a file. */
function currentFile(): string | undefined {
  return expect.getState().testPath ?? undefined;
}

function baselineFiles(): Set<string> {
  const file = path.join(__dirname, "..", "lifecycle-guard-baseline.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { files?: string[] };
    return new Set(parsed.files ?? []);
  } catch {
    return new Set();
  }
}

const baseline = baselineFiles();
let currentOnBaseline = false;
// Per-file, not per-test: a baseline file is allowed to leak in some tests and
// be clean in others, and the afterAll ratchet must see the whole file.
let everLeaked = false;
let currentRel: string | undefined;

/** Fail the current test if a bare listener or a real interval is still live. */
export function assertNoUnclaimedLifecycle(): void {
  const remaining = {
    listeners: listeners.map((e) => `${e.target === window ? "window" : "document"}:${e.event}`),
    intervals: intervals.length,
  };
  listeners = [];
  intervals = [];
  if (remaining.listeners.length === 0 && remaining.intervals === 0) return;
  everLeaked = true;
  if (currentOnBaseline) return;
  const detail = [
    remaining.listeners.length > 0
      ? `${remaining.listeners.length} live listener(s): ${remaining.listeners.join(", ")}`
      : null,
    remaining.intervals > 0 ? `${remaining.intervals} live interval(s)` : null,
  ]
    .filter(Boolean)
    .join("; ");
  throw new Error(
    `Lifecycle leak: this test ended with ${detail}. Own the listener with a signal ` +
      `(Disposable/SessionScope) or remove it in teardown; pass once: true where it is ` +
      `self-removing. ` +
      (currentRel !== undefined
        ? `If the leak is production code the test cannot release, add ${currentRel} ` +
          `to tests/lifecycle-guard-baseline.json with a reason.`
        : ""),
  );
}

/** Install the guard. Called once, from tests/setup.ts. */
export function installLifecycleGuard(): void {
  beforeEach(() => {
    listeners = [];
    intervals = [];
    const file = currentFile();
    currentRel =
      file === undefined
        ? undefined
        : path
            .relative(path.join(__dirname, "..", ".."), file)
            .split(path.sep)
            .join("/");
    currentOnBaseline = currentRel !== undefined && baseline.has(currentRel);

    for (const target of [window, document] as const) {
      const key = target === window ? "window" : "document";
      target.addEventListener = ((
        event: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        realAdd[key](event, listener, options);
        recordListener(target, event, listener, options);
      }) as typeof target.addEventListener;
      target.removeEventListener = ((
        event: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        realRemove[key](event, listener, options);
        dropListener(target, event, listener, options);
      }) as typeof target.removeEventListener;
    }

    // Fake timers are vitest's to clean up, and `vi.useFakeTimers()` replaces
    // the global before a test body runs, so the interval half is skipped when
    // fake timers are in play (checked in afterEach, after the test set them).
    //
    // jsdom's internal frame timer (see `inAnimationFrame`) is not an app
    // interval; only record intervals created outside a `requestAnimationFrame`
    // call.
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args) as unknown as number;
      if (!inAnimationFrame) intervals.push({ handle });
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle?: number) => {
      intervals = intervals.filter((entry) => entry.handle !== handle);
      return realClearInterval(handle);
    }) as typeof clearInterval;

    // Mark the window in which jsdom may start its internal frame timer.
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      inAnimationFrame = true;
      try {
        return realRequestAnimationFrame(callback);
      } finally {
        inAnimationFrame = false;
      }
    };
  });

  afterEach(() => {
    try {
      if (vi.isFakeTimers()) intervals = [];
      assertNoUnclaimedLifecycle();
    } finally {
      listeners = [];
      intervals = [];
    }
  });

  afterAll(() => {
    if (currentRel !== undefined && baseline.has(currentRel) && !everLeaked) {
      throw new Error(
        `tests/lifecycle-guard-baseline.json lists ${currentRel}, but it ran clean. ` +
          `Remove the entry — the list only shrinks.`,
      );
    }
  });
}
