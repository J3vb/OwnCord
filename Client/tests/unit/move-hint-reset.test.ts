/** The voice move notes reset with the derived caches, after the domain stores. */
import { describe, expect, it } from "vitest";
import { listSessionResets, registerSessionReset } from "../../src/lib/sessionRegistry";
import "../../src/features/voice/moveHint";

describe("move hint session reset", () => {
  it("runs with the derived caches, after the domain stores are emptied", () => {
    const dispose = registerSessionReset("test:later-domain", () => {}, { phase: "domain" });
    try {
      const order = listSessionResets();
      expect(order.indexOf("voice:move-hint")).toBeGreaterThan(order.indexOf("test:later-domain"));
    } finally {
      dispose();
    }
  });
});
