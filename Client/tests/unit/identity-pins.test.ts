import { describe, it, expect } from "vitest";
import {
  MAX_PINS_PER_USER,
  decodePinSlot,
  encodePinSlot,
  trustedPins,
  withPin,
} from "../../src/lib/identityPins";

describe("identity pin slot", () => {
  it("reads a bare legacy pin as a set of one", () => {
    expect(decodePinSlot("AbC+/=")).toEqual(["AbC+/="]);
  });

  it("round-trips: one key stays bare, several become an array", () => {
    expect(encodePinSlot(["a"])).toBe("a");
    expect(encodePinSlot(["a", "b"])).toBe('["a","b"]');
    expect(decodePinSlot(encodePinSlot(["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });

  it("collapses duplicates on read", () => {
    expect(decodePinSlot('["a","b","a"]')).toEqual(["a", "b"]);
  });

  it.each(["[", "[1,2]", '["a",""]', "[[]]"])(
    "treats %j as unreadable, not as unpinned",
    (slot) => {
      expect(decodePinSlot(slot)).toBeNull();
    },
  );

  it("drops the oldest key past the cap and leaves a known key alone", () => {
    const full = Array.from({ length: MAX_PINS_PER_USER }, (_, i) => `k${i}`);
    const next = withPin(full, "new");
    expect(next).toHaveLength(MAX_PINS_PER_USER);
    expect(next[0]).toBe("k1");
    expect(next[MAX_PINS_PER_USER - 1]).toBe("new");
    expect(withPin(full, "k3")).toBe(full);
  });

  it("lists every trusted key of a lookup", () => {
    expect(trustedPins({ pin: "a" })).toEqual(["a"]);
    expect(trustedPins({ pin: "b", pins: ["a", "b"] })).toEqual(["a", "b"]);
  });
});
