import { describe, it, expect, vi, beforeEach } from "vitest";

// clearAuth pulls in voice/livekit/notification teardown; stub it so this test
// stays a pure unit test of the best-effort revoke-then-teardown ordering.
const clearAuth = vi.fn();
vi.mock("@stores/auth.store", () => ({
  clearAuth: () => clearAuth(),
}));

import { logout } from "../../src/lib/logout";

function makeApi(logoutImpl: () => Promise<void>): { logout: ReturnType<typeof vi.fn> } {
  return { logout: vi.fn(logoutImpl) };
}

describe("logout", () => {
  beforeEach(() => {
    clearAuth.mockClear();
  });

  it("calls POST /auth/logout and then clears local auth", () => {
    const api = makeApi(() => Promise.resolve());

    logout(api);

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(clearAuth).toHaveBeenCalledTimes(1);
  });

  it("still logs out locally when the revocation request rejects", async () => {
    const api = makeApi(() => Promise.reject(new Error("network down")));

    // Must not throw despite the rejected request...
    expect(() => logout(api)).not.toThrow();
    // ...and the local teardown must have happened regardless of the outcome.
    expect(clearAuth).toHaveBeenCalledTimes(1);

    // Let the rejected promise settle: the swallowing .catch() must prevent an
    // unhandled rejection and must not re-trigger teardown.
    await Promise.resolve();
    expect(clearAuth).toHaveBeenCalledTimes(1);
  });

  it("does not await the request before local logout (best-effort, non-blocking)", () => {
    // A request that never settles must not delay or block clearAuth.
    const api = makeApi(() => new Promise<void>(() => {}));

    logout(api);

    expect(clearAuth).toHaveBeenCalledTimes(1);
  });
});
