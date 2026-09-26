// Vitest global setup for the jsdom suite.
//
// Node >= 22.4 ships its own Web Storage implementation, and vitest's jsdom
// environment makes `window === globalThis`, so Node's globals shadow jsdom's:
// `localStorage` becomes an accessor that returns `undefined` unless the
// process was started with `--localstorage-file`, and — the part that bit us —
// `Storage` becomes Node's class rather than jsdom's.
//
// This file used to paper over the first half with an in-memory object
// literal. That kept the suite running but left the second half unaddressed,
// and worse: twelve tests simulate storage a browser has disabled by patching
// `Storage.prototype`, and with `Storage` naming Node's class those spies
// patched a prototype nothing in the suite ever calls. Four failed outright;
// the rest passed while asserting nothing at all (OC-0415).
//
// The fix is upstream of this file — vitest.config.ts appends
// `--no-experimental-webstorage` to `process.env.NODE_OPTIONS` before the pool
// starts, and every forked worker inherits it, so Node installs no Web Storage
// and jsdom's own `localStorage`, `sessionStorage` and `Storage` are the only
// ones present, on every Node version. (`--localstorage-file` is the
// wrong lever: it is file-backed and would be shared by vitest's parallel
// workers, leaking state between test files.)
//
// What is left here is the assertion that the flag actually arrived. It fails
// loudly instead of letting the suite go quietly vacuous again.
import { setLogLevel } from "../src/lib/logger";
import { installConsoleGuard } from "./helpers/console";
import { installLifecycleGuard } from "./helpers/lifecycle";

if (typeof globalThis.localStorage === "undefined") {
  throw new Error(
    "tests/setup.ts: localStorage is missing. Node's Web Storage is shadowing " +
      "jsdom's and the --no-experimental-webstorage flag did not reach this " +
      "worker — check the NODE_OPTIONS block at the top of vitest.config.ts (OC-0415).",
  );
}
if (Object.getPrototypeOf(globalThis.localStorage) !== Storage.prototype) {
  throw new Error(
    "tests/setup.ts: localStorage is not an instance of the global Storage. " +
      "Node's Storage class is shadowing jsdom's, so every " +
      "vi.spyOn(Storage.prototype, ...) in this suite would silently intercept " +
      "nothing — check the NODE_OPTIONS block at the top of vitest.config.ts (OC-0415).",
  );
}

// jsdom never lays anything out, so it doesn't implement scrollIntoView at
// all (not even as a no-op) — components that call it (e.g. the mention/emoji
// autocomplete's arrow-key scroll) throw "is not a function" under jsdom.
// Every real browser has it; this just fills the gap.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

// The app logger defaults to "debug" and writes every line to the console, so
// the suite used to print hundreds of debug/info blocks a green run nobody
// reads (C-04). Raising the floor here is what makes "a green run prints
// nothing unexplained" checkable — a test that genuinely asserts on a
// debug/info log entry (buffer entry, listener call) raises the level back for
// itself and restores "warn" afterwards.
setLogLevel("warn");

// ...and that a test does not leak a bare window/document listener or a real
// interval: the guard fails the test that made it, unless its file is on the
// shrink-only tests/lifecycle-guard-baseline.json (B7-11a).
//
// Installed BEFORE the console guard on purpose. vitest runs setup afterEach
// hooks in reverse registration order, so whichever registers later runs
// first. message-list-media-release.test.ts leaves a floating
// fetchExternalImage promise whose refusal logs through the app logger; if
// the console guard's afterEach runs after another setup afterEach, that
// microtask checkpoint lets the log land inside the assertion window and
// fails a test that is otherwise green. Registering this guard first keeps
// the console guard's afterEach last, where the base suite already had it.
installLifecycleGuard();

// ...and that nothing else prints either: console.warn/console.error are
// captured per test, and a test that provokes one must claim it with
// expectConsole (tests/helpers/console.ts) or fail.
installConsoleGuard();
