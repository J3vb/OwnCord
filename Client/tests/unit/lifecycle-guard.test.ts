// B7-11a: the lifecycle guard must fail, and must not be switchable off.
// Mirrors tests/unit/console-guard.test.ts — the console guard is the template.
//
// Each leak case observes the guard's verdict directly by calling
// assertNoUnclaimedLifecycle(), which clears the record as it asserts, so the
// guard's own afterEach still sees a clean file and this file needs no baseline
// entry.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoUnclaimedLifecycle } from "../helpers/lifecycle";

// The exact defeat from call-ring.test.ts (and console-guard.test.ts), in the
// same position relative to the guard: it runs after the setup file's
// beforeEach, so the wrapper is already installed when it fires.
beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the lifecycle guard survives a test file's mock resets", () => {
  it("fails a bare document listener left alive", () => {
    document.addEventListener("keydown", () => {});

    expect(() => assertNoUnclaimedLifecycle()).toThrow(/Lifecycle leak/);
  });

  it("fails a real interval left alive", () => {
    globalThis.setInterval(() => {}, 1000);

    expect(() => assertNoUnclaimedLifecycle()).toThrow(/1 live interval/);
  });

  it("passes when the listener was removed", () => {
    const listener = (): void => {};
    document.addEventListener("keydown", listener);
    document.removeEventListener("keydown", listener);

    expect(() => assertNoUnclaimedLifecycle()).not.toThrow();
  });

  it("passes for a signal-owned listener once its signal aborts", () => {
    const ac = new AbortController();
    document.addEventListener("keydown", () => {}, { signal: ac.signal });
    ac.abort();

    expect(() => assertNoUnclaimedLifecycle()).not.toThrow();
  });

  it("still fails a signal-owned listener whose signal never aborted", () => {
    // This is the OC-0335 class in miniature: carrying a signal is not enough
    // if the signal outlives the thing it served.
    document.addEventListener("keydown", () => {}, { signal: new AbortController().signal });

    expect(() => assertNoUnclaimedLifecycle()).toThrow(/document:keydown/);
  });

  it("does not report a once listener (it removes itself)", () => {
    document.addEventListener("keydown", () => {}, { once: true });

    expect(() => assertNoUnclaimedLifecycle()).not.toThrow();
  });

  it("does not report jsdom's own animation-frame timer", () => {
    globalThis.requestAnimationFrame(() => {});

    expect(() => assertNoUnclaimedLifecycle()).not.toThrow();
  });

  it("cannot be switched off by a file's restoreAllMocks", () => {
    vi.restoreAllMocks();
    document.addEventListener("keydown", () => {});

    expect(() => assertNoUnclaimedLifecycle()).toThrow(/Lifecycle leak/);
  });
});
