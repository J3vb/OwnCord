import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createProfileManager,
  type StorageBackend,
  type CreateProfileData,
  type ServerProfile,
} from "@lib/profiles";

// ---------------------------------------------------------------------------
// Mock StorageBackend backed by a Map
// ---------------------------------------------------------------------------
function createMockBackend(): StorageBackend {
  const store = new Map<string, string>();
  return {
    get(key: string): string | null {
      return store.get(key) ?? null;
    },
    set(key: string, value: string): void {
      store.set(key, value);
    },
    remove(key: string): void {
      store.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic UUID stub
// ---------------------------------------------------------------------------
let uuidCounter = 0;

function nextUuid(): string {
  uuidCounter++;
  return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sampleData: CreateProfileData = {
  name: "Dev Server",
  host: "localhost:8443",
  username: "alice",
  color: "#ff5500",
  autoConnect: false,
};

const sampleData2: CreateProfileData = {
  name: "Prod Server",
  host: "prod.example.com:443",
  username: "bob",
  color: "#00aaff",
  autoConnect: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ProfileManager", () => {
  let backend: StorageBackend;

  beforeEach(() => {
    backend = createMockBackend();
    uuidCounter = 0;
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => nextUuid()),
    });
  });

  // 1. Initial state is empty
  it("starts with an empty profile list", () => {
    const mgr = createProfileManager(backend);
    expect(mgr.getAll()).toEqual([]);
  });

  // 2. create adds a profile with UUID
  it("creates a profile with a generated UUID and schema v1", () => {
    const mgr = createProfileManager(backend);
    const profile = mgr.create(sampleData);

    expect(profile.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(profile.name).toBe("Dev Server");
    expect(profile.host).toBe("localhost:8443");
    expect(profile.username).toBe("alice");
    expect(profile.color).toBe("#ff5500");
    expect(profile.autoConnect).toBe(false);
    expect(profile.lastConnected).toBeNull();
    expect(profile.schemaVersion).toBe(1);
    expect(mgr.getAll()).toHaveLength(1);
  });

  // 3. getById returns the correct profile
  it("retrieves a profile by id", () => {
    const mgr = createProfileManager(backend);
    const created = mgr.create(sampleData);

    expect(mgr.getById(created.id)).toEqual(created);
    expect(mgr.getById("nonexistent")).toBeNull();
  });

  // 4. update modifies fields immutably
  it("updates a profile immutably", () => {
    const mgr = createProfileManager(backend);
    const original = mgr.create(sampleData);

    const updated = mgr.update(original.id, { name: "Renamed" });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.host).toBe(original.host);
    // Original object should not have been mutated
    expect(original.name).toBe("Dev Server");
    // The stored profile should be the updated one
    expect(mgr.getById(original.id)!.name).toBe("Renamed");
  });

  it("returns null when updating a nonexistent profile", () => {
    const mgr = createProfileManager(backend);
    expect(mgr.update("missing", { name: "X" })).toBeNull();
  });

  // 5. remove deletes a profile
  it("removes an existing profile", () => {
    const mgr = createProfileManager(backend);
    const profile = mgr.create(sampleData);

    expect(mgr.remove(profile.id)).toBe(true);
    expect(mgr.getAll()).toHaveLength(0);
    expect(mgr.getById(profile.id)).toBeNull();
  });

  it("returns false when removing a nonexistent profile", () => {
    const mgr = createProfileManager(backend);
    expect(mgr.remove("missing")).toBe(false);
  });

  // 6. setLastConnected updates timestamp
  it("sets lastConnected to current ISO timestamp", () => {
    const mgr = createProfileManager(backend);
    const profile = mgr.create(sampleData);

    const before = new Date().toISOString();
    mgr.setLastConnected(profile.id);
    const after = new Date().toISOString();

    const updated = mgr.getById(profile.id)!;
    expect(updated.lastConnected).not.toBeNull();
    expect(updated.lastConnected! >= before).toBe(true);
    expect(updated.lastConnected! <= after).toBe(true);
    // Original object not mutated
    expect(profile.lastConnected).toBeNull();
  });

  it("does nothing when setting lastConnected on nonexistent profile", () => {
    const mgr = createProfileManager(backend);
    // Should not throw
    mgr.setLastConnected("missing");
  });

  // 7. getAutoConnect returns first auto-connect or null
  it("returns first auto-connect profile", () => {
    const mgr = createProfileManager(backend);
    mgr.create(sampleData); // autoConnect: false
    const autoProfile = mgr.create(sampleData2); // autoConnect: true

    expect(mgr.getAutoConnect()).toEqual(autoProfile);
  });

  it("returns null when no profiles have autoConnect", () => {
    const mgr = createProfileManager(backend);
    mgr.create(sampleData);
    expect(mgr.getAutoConnect()).toBeNull();
  });

  // 8. exportProfiles / importProfiles round-trip
  it("round-trips profiles through export and import", () => {
    const mgr1 = createProfileManager(backend);
    mgr1.create(sampleData);
    mgr1.create(sampleData2);

    const exported = mgr1.exportProfiles();

    const backend2 = createMockBackend();
    const mgr2 = createProfileManager(backend2);
    const result = mgr2.importProfiles(exported);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(mgr2.getAll()).toHaveLength(2);
    // Imported profiles get new UUIDs
    const hosts = mgr2.getAll().map((p) => p.host);
    expect(hosts).toContain("localhost:8443");
    expect(hosts).toContain("prod.example.com:443");
  });

  // 9. importProfiles skips duplicates by host
  it("skips duplicate hosts during import", () => {
    const mgr = createProfileManager(backend);
    mgr.create(sampleData);

    const incoming: ServerProfile[] = [
      {
        id: "ext-1",
        name: "Duplicate",
        host: "localhost:8443",
        username: "charlie",
        color: "#000000",
        autoConnect: false,
        lastConnected: null,
        schemaVersion: 1,
      },
      {
        id: "ext-2",
        name: "New Server",
        host: "new.example.com:443",
        username: "dave",
        color: "#ffffff",
        autoConnect: false,
        lastConnected: null,
        schemaVersion: 1,
      },
    ];

    const result = mgr.importProfiles(JSON.stringify(incoming));

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mgr.getAll()).toHaveLength(2);
  });

  it("handles invalid JSON gracefully on import", () => {
    const mgr = createProfileManager(backend);
    const result = mgr.importProfiles("not json");
    expect(result).toEqual({ imported: 0, skipped: 0 });
  });

  it("handles non-array JSON gracefully on import", () => {
    const mgr = createProfileManager(backend);
    const result = mgr.importProfiles(JSON.stringify({ foo: "bar" }));
    expect(result).toEqual({ imported: 0, skipped: 0 });
  });

  // 10. Persistence: new manager with same backend loads existing data
  it("persists profiles across manager instances", () => {
    const mgr1 = createProfileManager(backend);
    const created = mgr1.create(sampleData);

    // Create a second manager with the same backend
    const mgr2 = createProfileManager(backend);
    const loaded = mgr2.getAll();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(created);
  });

  // migrate is currently a no-op
  it("migrate runs without error", () => {
    const mgr = createProfileManager(backend);
    expect(() => mgr.migrate()).not.toThrow();
  });
});
