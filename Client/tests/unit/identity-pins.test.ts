import { describe, it, expect } from "vitest";
import { exportPublicKey } from "../../src/lib/e2eeCrypto";
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

  it("round-trips: one key stays bare, several are joined with _", () => {
    expect(encodePinSlot(["a"])).toBe("a");
    expect(encodePinSlot(["a", "b"])).toBe("a_b");
    expect(decodePinSlot(encodePinSlot(["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });

  it("collapses duplicates on read", () => {
    expect(decodePinSlot("a_b_a")).toEqual(["a", "b"]);
  });

  it.each(["", "_", "a_", "_a", "a__b", "a b", "a-b", '["a","b"]', "a$"])(
    "treats %j as unreadable, not as unpinned",
    (slot) => {
      expect(decodePinSlot(slot)).toBeNull();
    },
  );

  it("caps the set at 5 so the encoded slot fits the desktop store", () => {
    expect(MAX_PINS_PER_USER).toBe(5);
  });

  // Mirror of store_identity_pin's pin validation in src-tauri/src/commands.rs:
  // 1-512 characters of [A-Za-z0-9+/=_-]. Keep in sync with that function.
  function rustAcceptsPin(pin: string): boolean {
    return pin.length >= 1 && pin.length <= 512 && /^[A-Za-z0-9+/=_-]+$/.test(pin);
  }

  async function realKey(): Promise<string> {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    return exportPublicKey(pair.publicKey);
  }

  it("encodes 1..5 real-length keys into a slot the desktop store accepts", async () => {
    const keys: string[] = [];
    for (let i = 0; i < MAX_PINS_PER_USER; i++) keys.push(await realKey());
    expect(keys[0]).toHaveLength(88);
    for (let n = 1; n <= MAX_PINS_PER_USER; n++) {
      const slot = encodePinSlot(keys.slice(0, n));
      expect(rustAcceptsPin(slot)).toBe(true);
      expect(decodePinSlot(slot)).toEqual(keys.slice(0, n));
    }
    expect(encodePinSlot(keys)).toHaveLength(444);
  });

  it("keeps every slot withPin can produce within the store limit", async () => {
    let set: readonly string[] = [];
    for (let i = 0; i < MAX_PINS_PER_USER + 3; i++) {
      set = withPin(set, await realKey());
      expect(rustAcceptsPin(encodePinSlot(set))).toBe(true);
    }
    expect(set).toHaveLength(MAX_PINS_PER_USER);
  });

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
