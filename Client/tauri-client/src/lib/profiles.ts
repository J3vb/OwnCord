/**
 * Server profiles management module.
 *
 * Manages saved server connection profiles for the OwnCord login page.
 * Uses the createStore reactive pattern for state and Tauri invoke
 * commands for persistence (mockable via dependency injection).
 */

import { createStore, type Store } from "./store";
import { fetch } from "@tauri-apps/plugin-http";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "owncord:profiles";
const CURRENT_SCHEMA_VERSION = 1;
const HEALTH_TIMEOUT_MS = 3000;
const SLOW_THRESHOLD_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly username: string;
  readonly autoConnect: boolean;
  readonly rememberPassword: boolean;
  readonly color: string;
  readonly lastConnected: string | null;
}

export interface HealthStatus {
  readonly status: "online" | "slow" | "offline" | "checking";
  readonly latencyMs: number | null;
  readonly version: string | null;
  readonly onlineUsers: number | null;
}

export interface ProfilesState {
  readonly profiles: readonly ServerProfile[];
  readonly healthStatuses: ReadonlyMap<string, HealthStatus>;
}

export type CreateProfileData = Omit<ServerProfile, "id" | "lastConnected">;

export type UpdateProfileData = Partial<Omit<ServerProfile, "id">>;

/** Schema-versioned persistence envelope. */
interface StoredData {
  readonly schemaVersion: number;
  readonly profiles: readonly ServerProfile[];
}

/**
 * Persistence backend abstraction.
 * In production, wraps Tauri `invoke("save_settings", ...)` / `invoke("get_settings")`.
 * In tests, can be replaced with a synchronous Map-backed implementation.
 */
export interface PersistenceBackend {
  load(): Promise<StoredData | null>;
  save(data: StoredData): Promise<void>;
}

/**
 * Fetch function type matching the Tauri HTTP plugin signature.
 * Allows injection of a mock in tests.
 */
export type FetchFn = typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidProfileShape(item: unknown): item is ServerProfile {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    obj.name.length > 0 &&
    typeof obj.host === "string" &&
    obj.host.length > 0 &&
    typeof obj.username === "string" &&
    typeof obj.color === "string" &&
    typeof obj.autoConnect === "boolean" &&
    (obj.rememberPassword === undefined || typeof obj.rememberPassword === "boolean") &&
    (obj.lastConnected === null || typeof obj.lastConnected === "string")
  );
}

function isValidStoredData(data: unknown): data is StoredData {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.schemaVersion === "number" &&
    Array.isArray(obj.profiles) &&
    obj.profiles.every(isValidProfileShape)
  );
}

// ---------------------------------------------------------------------------
// Default Tauri persistence backend
// ---------------------------------------------------------------------------

export function createTauriBackend(): PersistenceBackend {
  return {
    async load(): Promise<StoredData | null> {
      const { invoke } = await import("@tauri-apps/api/core");
      const settings = (await invoke("get_settings")) as Record<
        string,
        unknown
      >;
      const raw = settings[STORAGE_KEY];
      if (raw === undefined || raw === null) return null;
      if (isValidStoredData(raw)) return raw;
      return null;
    },
    async save(data: StoredData): Promise<void> {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_settings", { key: STORAGE_KEY, value: data });
    },
  };
}

// ---------------------------------------------------------------------------
// Profile Manager
// ---------------------------------------------------------------------------

export interface ProfileManager {
  /** Reactive store — subscribe for state changes. */
  readonly store: Store<ProfilesState>;

  /** Load profiles from persistence backend into store. */
  loadProfiles(): Promise<void>;

  /** Save current profiles to persistence backend. */
  saveProfiles(): Promise<void>;

  /** Get all profiles (snapshot). */
  getAll(): readonly ServerProfile[];

  /** Get a profile by id. */
  getById(id: string): ServerProfile | null;

  /** Add a new profile. Returns the created profile. */
  addProfile(data: CreateProfileData): ServerProfile;

  /** Update an existing profile. Returns updated profile or null if not found. */
  updateProfile(id: string, data: UpdateProfileData): ServerProfile | null;

  /** Remove a profile by id. Returns true if removed. */
  removeProfile(id: string): boolean;

  /** Returns the first profile with autoConnect=true, or null. */
  getAutoConnectProfile(): ServerProfile | null;

  /**
   * Set the auto-login profile. Only one profile can be auto-login at a time.
   * Passing null clears auto-login on all profiles.
   * Setting auto-login also forces rememberPassword to true on the target.
   */
  setAutoLogin(id: string | null): void;

  /** Set lastConnected to current ISO timestamp. */
  setLastConnected(id: string): void;

  /** Check health of a single profile by id. Updates healthStatuses. */
  checkHealth(profileId: string): Promise<HealthStatus>;

  /** Check health of all profiles in parallel. Updates healthStatuses. */
  checkAllHealth(): Promise<ReadonlyMap<string, HealthStatus>>;

  /** Export all profiles as a JSON string. */
  exportProfiles(): string;

  /** Import profiles from JSON string. Merges by host (skips duplicates). */
  importProfiles(json: string): { imported: number; skipped: number };
}

export function createProfileManager(
  backend: PersistenceBackend,
  fetchFn?: FetchFn,
): ProfileManager {
  const initialState: ProfilesState = {
    profiles: [],
    healthStatuses: new Map(),
  };

  const store = createStore<ProfilesState>(initialState);

  // Resolve which fetch to use: injected mock, Tauri plugin, or global
  const doFetch: FetchFn = fetchFn ?? fetch;

  // ── Helpers ────────────────────────────────────────────────

  function currentProfiles(): readonly ServerProfile[] {
    return store.getState().profiles;
  }

  function setProfiles(profiles: readonly ServerProfile[]): void {
    store.setState((prev) => ({
      ...prev,
      profiles,
    }));
  }

  function setHealthStatus(profileId: string, status: HealthStatus): void {
    store.setState((prev) => {
      const next = new Map(prev.healthStatuses);
      next.set(profileId, status);
      return { ...prev, healthStatuses: next };
    });
  }

  function toStoredData(): StoredData {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      profiles: [...currentProfiles()],
    };
  }

  // ── Health check implementation ────────────────────────────

  async function pingHost(host: string): Promise<HealthStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const start = performance.now();

    try {
      const res = await doFetch(`https://${host}/api/v1/health`, {
        signal: controller.signal,
      });
      const elapsed = Math.round(performance.now() - start);

      if (!res.ok) {
        return { status: "offline", latencyMs: elapsed, version: null, onlineUsers: null };
      }

      const body = (await res.json()) as { version?: string; online_users?: number };
      const version = typeof body.version === "string" ? body.version : null;
      const onlineUsers = typeof body.online_users === "number" ? body.online_users : null;
      const status = elapsed > SLOW_THRESHOLD_MS ? "slow" : "online";

      return { status, latencyMs: elapsed, version, onlineUsers };
    } catch {
      return { status: "offline", latencyMs: null, version: null, onlineUsers: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Public API ─────────────────────────────────────────────

  const manager: ProfileManager = {
    store,

    async loadProfiles(): Promise<void> {
      const data = await backend.load();
      if (data !== null) {
        setProfiles(data.profiles);
      }
    },

    async saveProfiles(): Promise<void> {
      await backend.save(toStoredData());
    },

    getAll(): readonly ServerProfile[] {
      return [...currentProfiles()];
    },

    getById(id: string): ServerProfile | null {
      return currentProfiles().find((p) => p.id === id) ?? null;
    },

    addProfile(data: CreateProfileData): ServerProfile {
      const profile: ServerProfile = {
        ...data,
        id: crypto.randomUUID(),
        lastConnected: null,
      };
      setProfiles([...currentProfiles(), profile]);
      return profile;
    },

    updateProfile(id: string, data: UpdateProfileData): ServerProfile | null {
      const profiles = currentProfiles();
      const index = profiles.findIndex((p) => p.id === id);
      if (index === -1) return null;

      const existing = profiles[index]!;
      const updated: ServerProfile = { ...existing, ...data };
      setProfiles(profiles.map((p) => (p.id === id ? updated : p)));
      return updated;
    },

    removeProfile(id: string): boolean {
      const profiles = currentProfiles();
      const filtered = profiles.filter((p) => p.id !== id);
      if (filtered.length === profiles.length) return false;
      setProfiles(filtered);
      return true;
    },

    getAutoConnectProfile(): ServerProfile | null {
      return currentProfiles().find((p) => p.autoConnect) ?? null;
    },

    setAutoLogin(id: string | null): void {
      const profiles = currentProfiles();
      const updated = profiles.map((p) => {
        if (id === null) {
          // Clear auto-login on all profiles
          return p.autoConnect ? { ...p, autoConnect: false } : p;
        }
        if (p.id === id) {
          return { ...p, autoConnect: true, rememberPassword: true };
        }
        // Clear auto-login on all other profiles
        return p.autoConnect ? { ...p, autoConnect: false } : p;
      });
      setProfiles(updated);
    },

    setLastConnected(id: string): void {
      const profiles = currentProfiles();
      const index = profiles.findIndex((p) => p.id === id);
      if (index === -1) return;

      const existing = profiles[index]!;
      const updated: ServerProfile = {
        ...existing,
        lastConnected: new Date().toISOString(),
      };
      setProfiles(profiles.map((p) => (p.id === id ? updated : p)));
    },

    async checkHealth(profileId: string): Promise<HealthStatus> {
      const profile = currentProfiles().find((p) => p.id === profileId);
      if (!profile) {
        const offline: HealthStatus = {
          status: "offline",
          latencyMs: null,
          version: null,
          onlineUsers: null,
        };
        return offline;
      }

      setHealthStatus(profileId, {
        status: "checking",
        latencyMs: null,
        version: null,
        onlineUsers: null,
      });

      const result = await pingHost(profile.host);
      setHealthStatus(profileId, result);
      return result;
    },

    async checkAllHealth(): Promise<ReadonlyMap<string, HealthStatus>> {
      const profiles = currentProfiles();

      // Set all to "checking" first
      for (const profile of profiles) {
        setHealthStatus(profile.id, {
          status: "checking",
          latencyMs: null,
          version: null,
          onlineUsers: null,
        });
      }

      // Ping all in parallel
      const results = await Promise.all(
        profiles.map(async (profile) => {
          const result = await pingHost(profile.host);
          setHealthStatus(profile.id, result);
          return [profile.id, result] as const;
        }),
      );

      return new Map(results);
    },

    exportProfiles(): string {
      return JSON.stringify(toStoredData());
    },

    importProfiles(json: string): { imported: number; skipped: number } {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { imported: 0, skipped: 0 };
      }

      // Accept either StoredData envelope or a bare array
      let incoming: unknown[];
      if (isValidStoredData(parsed)) {
        incoming = [...parsed.profiles];
      } else if (Array.isArray(parsed)) {
        incoming = parsed;
      } else {
        return { imported: 0, skipped: 0 };
      }

      const existingHosts = new Set(currentProfiles().map((p) => p.host));
      let imported = 0;
      let skipped = 0;
      const newProfiles: ServerProfile[] = [];

      for (const raw of incoming) {
        if (!isValidProfileShape(raw)) {
          skipped++;
          continue;
        }
        if (existingHosts.has(raw.host)) {
          skipped++;
        } else {
          const profile: ServerProfile = {
            id: crypto.randomUUID(),
            name: raw.name,
            host: raw.host,
            username: raw.username,
            color: raw.color,
            autoConnect: raw.autoConnect,
            rememberPassword: raw.rememberPassword ?? false,
            lastConnected: null,
          };
          newProfiles.push(profile);
          existingHosts.add(profile.host);
          imported++;
        }
      }

      if (imported > 0) {
        setProfiles([...currentProfiles(), ...newProfiles]);
      }

      return { imported, skipped };
    },
  };

  return manager;
}
