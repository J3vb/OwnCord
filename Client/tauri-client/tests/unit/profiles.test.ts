import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  createProfileManager,
  type PersistenceBackend,
  type CreateProfileData,
  type ServerProfile,
  type FetchFn,
  type HealthStatus,
  type ProfilesState,
} from "@lib/profiles";

// ---------------------------------------------------------------------------
// Deterministic UUID stub
// ---------------------------------------------------------------------------

let uuidCounter = 0;

function nextUuid(): string {
  uuidCounter++;
  return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Mock persistence backend
// ---------------------------------------------------------------------------

function createMockBackend(): PersistenceBackend & {
  saved: Array<{ schemaVersion: number; profiles: readonly ServerProfile[] }>;
} {
  let stored: { schemaVersion: number; profiles: readonly ServerProfile[] } | null =
    null;
  const saved: Array<{ schemaVersion: number; profiles: readonly ServerProfile[] }> =
    [];

  return {
    saved,
    async load() {
      return stored;
    },
    async save(data) {
      stored = data;
      saved.push(data);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): FetchFn {
  return handler as unknown as FetchFn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  let backend: ReturnType<typeof createMockBackend>;
  let mockFetch: Mock;

  beforeEach(() => {
    backend = createMockBackend();
    uuidCounter = 0;
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => nextUuid()),
    });
    mockFetch = vi.fn();
  });

  function mgr(fetchFn?: FetchFn) {
    return createProfileManager(backend, fetchFn ?? (mockFetch as unknown as FetchFn));
  }

  // ── CRUD ─────────────────────────────────────────────────

  describe("CRUD operations", () => {
    it("starts with an empty profile list", () => {
      const m = mgr();
      expect(m.getAll()).toEqual([]);
    });

    it("adds a profile with a generated UUID", () => {
      const m = mgr();
      const profile = m.addProfile(sampleData);

      expect(profile.id).toBe("00000000-0000-0000-0000-000000000001");
      expect(profile.name).toBe("Dev Server");
      expect(profile.host).toBe("localhost:8443");
      expect(profile.username).toBe("alice");
      expect(profile.color).toBe("#ff5500");
      expect(profile.autoConnect).toBe(false);
      expect(profile.lastConnected).toBeNull();
      expect(m.getAll()).toHaveLength(1);
    });

    it("retrieves a profile by id", () => {
      const m = mgr();
      const created = m.addProfile(sampleData);

      expect(m.getById(created.id)).toEqual(created);
      expect(m.getById("nonexistent")).toBeNull();
    });

    it("updates a profile immutably", () => {
      const m = mgr();
      const original = m.addProfile(sampleData);

      const updated = m.updateProfile(original.id, { name: "Renamed" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Renamed");
      expect(updated!.host).toBe(original.host);
      // Original object not mutated
      expect(original.name).toBe("Dev Server");
      // Store has the updated version
      expect(m.getById(original.id)!.name).toBe("Renamed");
    });

    it("returns null when updating a nonexistent profile", () => {
      const m = mgr();
      expect(m.updateProfile("missing", { name: "X" })).toBeNull();
    });

    it("removes an existing profile", () => {
      const m = mgr();
      const profile = m.addProfile(sampleData);

      expect(m.removeProfile(profile.id)).toBe(true);
      expect(m.getAll()).toHaveLength(0);
      expect(m.getById(profile.id)).toBeNull();
    });

    it("returns false when removing a nonexistent profile", () => {
      const m = mgr();
      expect(m.removeProfile("missing")).toBe(false);
    });

    it("sets lastConnected to current ISO timestamp", () => {
      const m = mgr();
      const profile = m.addProfile(sampleData);

      const before = new Date().toISOString();
      m.setLastConnected(profile.id);
      const after = new Date().toISOString();

      const updated = m.getById(profile.id)!;
      expect(updated.lastConnected).not.toBeNull();
      expect(updated.lastConnected! >= before).toBe(true);
      expect(updated.lastConnected! <= after).toBe(true);
      // Original not mutated
      expect(profile.lastConnected).toBeNull();
    });

    it("does nothing when setting lastConnected on nonexistent profile", () => {
      const m = mgr();
      // Should not throw
      m.setLastConnected("missing");
    });
  });

  // ── Auto-connect ─────────────────────────────────────────

  describe("auto-connect", () => {
    it("returns the first auto-connect profile", () => {
      const m = mgr();
      m.addProfile(sampleData); // autoConnect: false
      const autoProfile = m.addProfile(sampleData2); // autoConnect: true

      expect(m.getAutoConnectProfile()).toEqual(autoProfile);
    });

    it("returns null when no profiles have autoConnect", () => {
      const m = mgr();
      m.addProfile(sampleData);
      expect(m.getAutoConnectProfile()).toBeNull();
    });

    it("returns null when no profiles exist", () => {
      const m = mgr();
      expect(m.getAutoConnectProfile()).toBeNull();
    });
  });

  // ── Health check ─────────────────────────────────────────

  describe("health checks", () => {
    it("returns online status for a healthy server", async () => {
      const fetchFn = createMockFetch(async () =>
        jsonResponse({ version: "1.2.3" }),
      );
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      const result = await m.checkHealth(profile.id);

      expect(result.status).toBe("online");
      expect(result.version).toBe("1.2.3");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("sets status to checking before resolving", async () => {
      const states: Array<HealthStatus | undefined> = [];
      let resolveReq!: () => void;
      const pending = new Promise<void>((r) => {
        resolveReq = r;
      });

      const fetchFn = createMockFetch(async () => {
        await pending;
        return jsonResponse({ version: "1.0.0" });
      });
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      // Subscribe to capture the "checking" state
      m.store.subscribe((state: ProfilesState) => {
        states.push(state.healthStatuses.get(profile.id));
      });

      const healthPromise = m.checkHealth(profile.id);

      // At this point, state should have been set to "checking"
      const checkingState = m.store.getState().healthStatuses.get(profile.id);
      expect(checkingState?.status).toBe("checking");

      resolveReq();
      await healthPromise;

      const finalState = m.store.getState().healthStatuses.get(profile.id);
      expect(finalState?.status).toBe("online");
    });

    it("returns offline when fetch throws", async () => {
      const fetchFn = createMockFetch(async () => {
        throw new Error("network error");
      });
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      const result = await m.checkHealth(profile.id);

      expect(result.status).toBe("offline");
      expect(result.latencyMs).toBeNull();
      expect(result.version).toBeNull();
    });

    it("returns offline for non-OK response", async () => {
      const fetchFn = createMockFetch(async () =>
        jsonResponse({ error: "bad" }, 500),
      );
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      const result = await m.checkHealth(profile.id);

      expect(result.status).toBe("offline");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("returns offline for nonexistent profile", async () => {
      const m = mgr();
      const result = await m.checkHealth("nonexistent");
      expect(result.status).toBe("offline");
    });

    it("pings the correct URL with /api/v1/health", async () => {
      let capturedUrl = "";
      const fetchFn = createMockFetch(async (url) => {
        capturedUrl = url;
        return jsonResponse({ version: "1.0.0" });
      });
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      await m.checkHealth(profile.id);

      expect(capturedUrl).toBe("https://localhost:8443/api/v1/health");
    });

    it("uses AbortController signal in fetch call", async () => {
      let capturedSignal: AbortSignal | undefined;
      const fetchFn = createMockFetch(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return jsonResponse({ version: "1.0.0" });
      });
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      await m.checkHealth(profile.id);

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    });

    it("checkAllHealth pings all profiles in parallel", async () => {
      const pingedHosts: string[] = [];
      const fetchFn = createMockFetch(async (url) => {
        pingedHosts.push(url);
        return jsonResponse({ version: "2.0.0" });
      });
      const m = mgr(fetchFn);
      const p1 = m.addProfile(sampleData);
      const p2 = m.addProfile(sampleData2);

      const results = await m.checkAllHealth();

      expect(results.size).toBe(2);
      expect(results.get(p1.id)?.status).toBe("online");
      expect(results.get(p2.id)?.status).toBe("online");
      expect(pingedHosts).toHaveLength(2);
      expect(pingedHosts).toContain("https://localhost:8443/api/v1/health");
      expect(pingedHosts).toContain(
        "https://prod.example.com:443/api/v1/health",
      );
    });

    it("checkAllHealth returns empty map when no profiles", async () => {
      const m = mgr();
      const results = await m.checkAllHealth();
      expect(results.size).toBe(0);
    });
  });

  // ── Export / Import ──────────────────────────────────────

  describe("export and import", () => {
    it("round-trips profiles through export and import", () => {
      const m1 = mgr();
      m1.addProfile(sampleData);
      m1.addProfile(sampleData2);

      const exported = m1.exportProfiles();

      const backend2 = createMockBackend();
      const m2 = createProfileManager(
        backend2,
        mockFetch as unknown as FetchFn,
      );
      const result = m2.importProfiles(exported);

      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(m2.getAll()).toHaveLength(2);

      const hosts = m2.getAll().map((p) => p.host);
      expect(hosts).toContain("localhost:8443");
      expect(hosts).toContain("prod.example.com:443");
    });

    it("skips duplicate hosts during import", () => {
      const m = mgr();
      m.addProfile(sampleData);

      const incoming: ServerProfile[] = [
        {
          id: "ext-1",
          name: "Duplicate",
          host: "localhost:8443",
          username: "charlie",
          color: "#000000",
          autoConnect: false,
          lastConnected: null,
        },
        {
          id: "ext-2",
          name: "New Server",
          host: "new.example.com:443",
          username: "dave",
          color: "#ffffff",
          autoConnect: false,
          lastConnected: null,
        },
      ];

      const result = m.importProfiles(JSON.stringify(incoming));

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
      expect(m.getAll()).toHaveLength(2);
    });

    it("handles invalid JSON gracefully", () => {
      const m = mgr();
      const result = m.importProfiles("not json");
      expect(result).toEqual({ imported: 0, skipped: 0 });
    });

    it("handles non-array, non-envelope JSON gracefully", () => {
      const m = mgr();
      const result = m.importProfiles(JSON.stringify({ foo: "bar" }));
      expect(result).toEqual({ imported: 0, skipped: 0 });
    });

    it("rejects import entries with invalid shape", () => {
      const m = mgr();
      const badEntries = [
        { id: "x", name: "", host: "a", username: "b", color: "#000", autoConnect: false, lastConnected: null },
        { id: "y", name: "Valid", host: "valid.com:443", username: "u", color: "#fff", autoConnect: false, lastConnected: null },
      ];
      const result = m.importProfiles(JSON.stringify(badEntries));
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it("exported data includes schema version", () => {
      const m = mgr();
      m.addProfile(sampleData);

      const exported = JSON.parse(m.exportProfiles());
      expect(exported.schemaVersion).toBe(1);
      expect(Array.isArray(exported.profiles)).toBe(true);
    });

    it("imports new UUIDs rather than keeping originals", () => {
      const m1 = mgr();
      const created = m1.addProfile(sampleData);
      const exported = m1.exportProfiles();

      const backend2 = createMockBackend();
      const m2 = createProfileManager(
        backend2,
        mockFetch as unknown as FetchFn,
      );
      m2.importProfiles(exported);

      const imported = m2.getAll();
      expect(imported).toHaveLength(1);
      // The imported profile should have a NEW UUID
      expect(imported[0]!.id).not.toBe(created.id);
    });
  });

  // ── Persistence ──────────────────────────────────────────

  describe("persistence", () => {
    it("loadProfiles populates store from backend", async () => {
      // Pre-seed the backend
      await backend.save({
        schemaVersion: 1,
        profiles: [
          {
            id: "persisted-1",
            name: "Saved Server",
            host: "saved.example.com:443",
            username: "eve",
            color: "#112233",
            autoConnect: false,
            lastConnected: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

      const m = mgr();
      await m.loadProfiles();

      expect(m.getAll()).toHaveLength(1);
      expect(m.getAll()[0]!.name).toBe("Saved Server");
    });

    it("saveProfiles writes current state with schema version to backend", async () => {
      const m = mgr();
      m.addProfile(sampleData);

      await m.saveProfiles();

      expect(backend.saved).toHaveLength(1);
      expect(backend.saved[0]!.schemaVersion).toBe(1);
      expect(backend.saved[0]!.profiles).toHaveLength(1);
      expect(backend.saved[0]!.profiles[0]!.name).toBe("Dev Server");
    });

    it("loadProfiles handles empty backend gracefully", async () => {
      const m = mgr();
      await m.loadProfiles();
      expect(m.getAll()).toEqual([]);
    });
  });

  // ── Reactive store ───────────────────────────────────────

  describe("reactive store", () => {
    it("notifies subscribers on profile add", () => {
      const m = mgr();
      const states: ProfilesState[] = [];
      m.store.subscribe((s) => states.push(s));

      m.addProfile(sampleData);

      expect(states).toHaveLength(1);
      expect(states[0]!.profiles).toHaveLength(1);
    });

    it("notifies subscribers on profile remove", () => {
      const m = mgr();
      const profile = m.addProfile(sampleData);

      const states: ProfilesState[] = [];
      m.store.subscribe((s) => states.push(s));

      m.removeProfile(profile.id);

      expect(states).toHaveLength(1);
      expect(states[0]!.profiles).toHaveLength(0);
    });

    it("healthStatuses updates are visible via store", async () => {
      const fetchFn = createMockFetch(async () =>
        jsonResponse({ version: "3.0.0" }),
      );
      const m = mgr(fetchFn);
      const profile = m.addProfile(sampleData);

      await m.checkHealth(profile.id);

      const statuses = m.store.getState().healthStatuses;
      expect(statuses.get(profile.id)?.status).toBe("online");
      expect(statuses.get(profile.id)?.version).toBe("3.0.0");
    });
  });
});
