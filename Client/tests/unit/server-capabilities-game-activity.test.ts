import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyGameActivityPolicy,
  applyReadyCapabilities,
  onGameActivityPolicy,
  resetServerCapabilities,
  serverSupportsGameActivity,
} from "@lib/serverCapabilities";

/**
 * WP 8.3e-2: the runtime game activity switch. `auth_ok.game_activity_policy`
 * and the `game_activity_policy` frame carry it; it overrides the `ready`
 * capability, which only says what the server understood at that ready.
 */
describe("game activity policy", () => {
  afterEach(() => resetServerCapabilities());

  it("overrides the capability in both directions, once a ready has arrived", () => {
    applyReadyCapabilities({ game_activity: true });
    expect(serverSupportsGameActivity()).toBe(true);
    applyGameActivityPolicy(false);
    expect(serverSupportsGameActivity()).toBe(false);
    applyGameActivityPolicy(true);
    expect(serverSupportsGameActivity()).toBe(true);

    // A ready that advertised it off, and an admin turning it on later.
    applyReadyCapabilities({ game_activity: false });
    applyGameActivityPolicy(true);
    expect(serverSupportsGameActivity()).toBe(true);
  });

  it("is not trusted before a ready has arrived: every capability reads false until then", () => {
    applyGameActivityPolicy(true);
    expect(serverSupportsGameActivity()).toBe(false);
    applyReadyCapabilities({ read_pointer: true });
    expect(serverSupportsGameActivity()).toBe(true);
  });

  it("falls back to the capability while no policy has been heard (an older server)", () => {
    applyReadyCapabilities({ game_activity: true });
    expect(serverSupportsGameActivity()).toBe(true);
    applyReadyCapabilities({});
    expect(serverSupportsGameActivity()).toBe(false);
  });

  it("is cleared by a reset, so the next server does not inherit it", () => {
    applyReadyCapabilities({ game_activity: true });
    applyGameActivityPolicy(false);
    resetServerCapabilities();
    applyReadyCapabilities({ game_activity: true });
    expect(serverSupportsGameActivity()).toBe(true);
  });

  it("tells listeners about a change only, and reports whether it changed", () => {
    applyReadyCapabilities({ game_activity: true });
    const seen = vi.fn();
    const off = onGameActivityPolicy(seen);

    expect(applyGameActivityPolicy(false)).toBe(true);
    expect(applyGameActivityPolicy(false)).toBe(false);
    expect(applyGameActivityPolicy(true)).toBe(true);
    expect(seen.mock.calls).toEqual([[false], [true]]);

    off();
    applyGameActivityPolicy(false);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("lets a listener that unsubscribes while being called do so safely", () => {
    const calls: string[] = [];
    const offFirst = onGameActivityPolicy(() => {
      calls.push("first");
      offFirst();
    });
    onGameActivityPolicy(() => calls.push("second"));
    applyGameActivityPolicy(false);
    applyGameActivityPolicy(true);
    expect(calls).toEqual(["first", "second", "second"]);
  });

  it("keeps listeners across a reset: their owners remove them", () => {
    const seen = vi.fn();
    const off = onGameActivityPolicy(seen);
    resetServerCapabilities();
    applyGameActivityPolicy(false);
    expect(seen).toHaveBeenCalledWith(false);
    off();
  });
});
