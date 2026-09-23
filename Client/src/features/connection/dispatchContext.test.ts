import { describe, it, expect } from "vitest";
import { createReconnectClock } from "./dispatchContext";

describe("createReconnectClock", () => {
  it("starts a login with no handshake, no ready and no skew", () => {
    expect(createReconnectClock()).toEqual({
      hasAuthenticatedBefore: false,
      hasReceivedReadyBefore: false,
      lastReconnectHandshakeAt: null,
      serverClockSkewMs: 0,
    });
  });

  it("hands every call its own clock, so one login's state never leaks into the next", () => {
    const first = createReconnectClock();
    first.hasAuthenticatedBefore = true;
    first.lastReconnectHandshakeAt = 123;
    first.serverClockSkewMs = 45;

    const second = createReconnectClock();
    expect(second).not.toBe(first);
    expect(second.hasAuthenticatedBefore).toBe(false);
    expect(second.lastReconnectHandshakeAt).toBeNull();
    expect(second.serverClockSkewMs).toBe(0);
  });
});
