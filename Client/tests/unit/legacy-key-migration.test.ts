import { describe, it, expect, vi, afterEach } from "vitest";
import { migrateLegacyValue } from "../../src/lib/legacyKeyMigration";

const LEGACY = "owncord:test-pref:7";
const HOST_A = "owncord:test-pref:a.example.com:7";
const HOST_B = "owncord:test-pref:b.example.com:7";
const CLAIM = `owncord:legacy-claim:${LEGACY}`;

/** Make every setItem whose key starts with `prefix` fail like a full store. */
function failWritesTo(prefix: string) {
  const realSetItem = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key.startsWith(prefix)) throw new DOMException("quota exceeded", "QuotaExceededError");
    realSetItem.call(this, key, value);
  });
}

describe("migrateLegacyValue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("returns null when nothing was saved before scoping", () => {
    expect(migrateLegacyValue(LEGACY, HOST_A)).toBeNull();
    expect(localStorage.getItem(HOST_A)).toBeNull();
  });

  it("moves the value to the first host's key and consumes the legacy key", () => {
    localStorage.setItem(LEGACY, "30");

    expect(migrateLegacyValue(LEGACY, HOST_A)).toBe("30");
    expect(localStorage.getItem(HOST_A)).toBe("30");
    expect(localStorage.getItem(LEGACY)).toBeNull();

    // A later host with the same user id finds nothing to inherit.
    expect(migrateLegacyValue(LEGACY, HOST_B)).toBeNull();
    expect(localStorage.getItem(HOST_B)).toBeNull();
  });

  it("binds a failed copy to the first host and refuses every other host until it lands", () => {
    localStorage.setItem(LEGACY, "30");
    const setItem = failWritesTo(HOST_A);

    // The owner still gets its value; the legacy key is restored under a claim.
    expect(migrateLegacyValue(LEGACY, HOST_A)).toBe("30");
    expect(localStorage.getItem(HOST_A)).toBeNull();
    expect(localStorage.getItem(LEGACY)).toBe("30");
    expect(localStorage.getItem(CLAIM)).toBe(HOST_A);

    // Another host neither reads nor consumes it while the claim stands.
    expect(migrateLegacyValue(LEGACY, HOST_B)).toBeNull();
    expect(localStorage.getItem(HOST_B)).toBeNull();
    expect(localStorage.getItem(LEGACY)).toBe("30");

    // Storage writable again: the owner's next read completes the move.
    setItem.mockRestore();
    expect(migrateLegacyValue(LEGACY, HOST_A)).toBe("30");
    expect(localStorage.getItem(HOST_A)).toBe("30");
    expect(localStorage.getItem(LEGACY)).toBeNull();
    expect(localStorage.getItem(CLAIM)).toBeNull();
    expect(migrateLegacyValue(LEGACY, HOST_B)).toBeNull();
  });

  it("honours a claim written by an earlier session", () => {
    localStorage.setItem(LEGACY, "30");
    localStorage.setItem(CLAIM, HOST_A);

    expect(migrateLegacyValue(LEGACY, HOST_B)).toBeNull();
    expect(localStorage.getItem(LEGACY)).toBe("30");

    expect(migrateLegacyValue(LEGACY, HOST_A)).toBe("30");
    expect(localStorage.getItem(HOST_A)).toBe("30");
    expect(localStorage.getItem(LEGACY)).toBeNull();
    expect(localStorage.getItem(CLAIM)).toBeNull();
  });

  it("keeps the claim and the value in memory when not even the marker can be written", () => {
    localStorage.setItem(LEGACY, "30");
    const setItem = failWritesTo("owncord:");

    expect(migrateLegacyValue(LEGACY, HOST_A)).toBe("30");
    expect(localStorage.getItem(HOST_A)).toBeNull();
    expect(localStorage.getItem(CLAIM)).toBeNull();

    expect(migrateLegacyValue(LEGACY, HOST_B)).toBeNull();
    expect(localStorage.getItem(HOST_B)).toBeNull();

    setItem.mockRestore();
    expect(migrateLegacyValue(LEGACY, HOST_A)).toBe("30");
    expect(localStorage.getItem(HOST_A)).toBe("30");
    expect(localStorage.getItem(LEGACY)).toBeNull();
  });

  it("drops a stale claim whose value is gone", () => {
    localStorage.setItem(CLAIM, HOST_A);

    expect(migrateLegacyValue(LEGACY, HOST_A)).toBeNull();
    expect(localStorage.getItem(CLAIM)).toBeNull();
  });

  it("reads unusable storage as null", () => {
    localStorage.setItem(LEGACY, "30");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("storage disabled", "SecurityError");
    });

    expect(migrateLegacyValue(LEGACY, HOST_A)).toBeNull();
  });
});
