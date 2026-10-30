/** The unblocks-in-flight set resets with the derived caches, after the domain stores. */
import { describe, expect, it } from "vitest";
import { listSessionResets, registerSessionReset } from "../../src/lib/net/sessionRegistry";
import "../../src/features/safety/BlockedUsers";

describe("blocked users session reset", () => {
  it("is registered, and runs after the domain stores are emptied", () => {
    const dispose = registerSessionReset("test:later-domain", () => {}, { phase: "domain" });
    try {
      const order = listSessionResets();
      expect(order).toContain("blocked-users:pending");
      expect(order.indexOf("blocked-users:pending")).toBeGreaterThan(
        order.indexOf("test:later-domain"),
      );
    } finally {
      dispose();
    }
  });
});
