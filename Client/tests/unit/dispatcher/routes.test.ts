// Features list their own events (wsRoutes in features/*/wsHandlers.ts) and
// the dispatcher subscribes them. These pin the two ways a table can go wrong:
// an event claimed twice, and listeners that outlive the connection they were
// wired for.
import { describe, expect, it, vi } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { createMockWs } from "../../helpers/dispatcherHarness";
import { featureRoutes, wireDispatcher } from "../../../src/lib/dispatcher";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("../../../src/features/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());

/** Events whose handlers run in a set order across features, written out in the dispatcher. */
const orderedEvents = ["auth_ok", "ready", "error"];

function listenerCounts(mock: ReturnType<typeof createMockWs>): Map<string, number> {
  return new Map([...mock.listeners].map(([type, set]) => [type, set.size]));
}

describe("feature routes", () => {
  it("claim each event once, and never one of the ordered chains", () => {
    const types = featureRoutes.map((r) => r.type);
    expect(new Set(types).size).toBe(types.length);
    for (const type of orderedEvents) expect(types).not.toContain(type);
  });

  it("give every event exactly one listener, routed or ordered", () => {
    const mock = createMockWs();
    const cleanup = wireDispatcher(mock.ws);
    try {
      const counts = listenerCounts(mock);
      for (const type of [...featureRoutes.map((r) => r.type), ...orderedEvents]) {
        expect(counts.get(type), type).toBe(1);
      }
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("leave nothing subscribed after cleanup, and a rewire starts from one listener each", () => {
    const mock = createMockWs();
    wireDispatcher(mock.ws)();
    expect([...mock.listeners.values()].every((set) => set.size === 0)).toBe(true);

    const cleanup = wireDispatcher(mock.ws);
    for (const r of featureRoutes) expect(mock.listeners.get(r.type)?.size, r.type).toBe(1);
    cleanup();
    expect([...mock.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});
