// B7-1 review round 1, finding 1: the guard could be switched off by a test
// file without anyone noticing.
//
// The guard used to install its recorder with `vi.spyOn`. A test file's own
// `beforeEach(() => vi.restoreAllMocks())` runs *after* the setup file's
// beforeEach, so it removed the recorder — the file's console output went
// unchecked and printed — and `vi.resetAllMocks` blanked the spy's
// implementation, which swallowed the output without even printing it.
// `call-ring.test.ts:53-55` is a live site of the first form.
//
// These tests perform each defeat attempt and then prove the guard still
// reports the call. Every case claims or clears what it provoked, so the real
// afterEach check passes afterwards.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoUnclaimedConsole, expectConsole } from "../helpers/console";

// The exact defeat from call-ring.test.ts, in the same position relative to the
// guard: it runs after the setup file's beforeEach, so the recorder is already
// installed when it fires.
beforeEach(() => {
  vi.restoreAllMocks();
});

describe("the console guard survives a test file's mock resets", () => {
  it("fails an unclaimed console.warn after the file's restoreAllMocks", () => {
    console.warn("guard probe");

    expect(() => assertNoUnclaimedConsole()).toThrow(/Unexpected console\.warn: guard probe/);
  });

  it("fails an unclaimed console.warn after an explicit restoreAllMocks", () => {
    vi.restoreAllMocks();
    console.warn("guard probe");

    expect(() => assertNoUnclaimedConsole()).toThrow(/Unexpected console\.warn: guard probe/);
  });

  it("fails an unclaimed console.error after resetAllMocks", () => {
    vi.resetAllMocks();
    console.error("guard probe");

    expect(() => assertNoUnclaimedConsole()).toThrow(/Unexpected console\.error: guard probe/);
  });

  it("passes once the call is claimed with expectConsole", () => {
    console.warn("expected warning");
    expectConsole("warn", "expected warning");

    expect(() => assertNoUnclaimedConsole()).not.toThrow();
  });

  it("expectConsole fails when no recorded call matches", () => {
    console.warn("a real warning");

    expect(() => expectConsole("warn", "no such text")).toThrow(/no console\.warn matching/);

    // Still unclaimed — claim it so the guard's own afterEach passes.
    expectConsole("warn", "a real warning");
  });
});
