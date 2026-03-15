/**
 * Server profiles management service.
 *
 * Manages saved server connection profiles for OwnCord.
 * Uses a pluggable StorageBackend so the real app can swap
 * in tauri-plugin-store while tests use a simple Map backend.
 */

const STORAGE_KEY = "owncord:profiles";
const CURRENT_SCHEMA_VERSION = 1;

export interface ServerProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly username: string;
  readonly color: string;
  readonly autoConnect: boolean;
  readonly lastConnected: string | null;
  readonly schemaVersion: number;
}

export interface StorageBackend {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type CreateProfileData = Omit<
  ServerProfile,
  "id" | "schemaVersion" | "lastConnected"
>;

export type UpdateProfileData = Partial<
  Omit<ServerProfile, "id" | "schemaVersion">
>;

export interface ProfileManager {
  getAll(): readonly ServerProfile[];
  getById(id: string): ServerProfile | null;
  create(data: CreateProfileData): ServerProfile;
  update(id: string, data: UpdateProfileData): ServerProfile | null;
  remove(id: string): boolean;
  setLastConnected(id: string): void;
  getAutoConnect(): ServerProfile | null;
  exportProfiles(): string;
  importProfiles(json: string): { imported: number; skipped: number };
  migrate(): void;
}

const localStorageBackend: StorageBackend = {
  get(key: string): string | null {
    return localStorage.getItem(key);
  },
  set(key: string, value: string): void {
    localStorage.setItem(key, value);
  },
  remove(key: string): void {
    localStorage.removeItem(key);
  },
};

function isValidProfileShape(item: unknown): item is ServerProfile {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" && obj.name.length > 0 &&
    typeof obj.host === "string" && obj.host.length > 0 &&
    typeof obj.username === "string" && obj.username.length > 0 &&
    typeof obj.color === "string" &&
    typeof obj.autoConnect === "boolean"
  );
}

function loadProfiles(backend: StorageBackend): ServerProfile[] {
  const raw = backend.get(STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidProfileShape);
  } catch {
    return [];
  }
}

function saveProfiles(
  backend: StorageBackend,
  profiles: readonly ServerProfile[],
): void {
  backend.set(STORAGE_KEY, JSON.stringify(profiles));
}

export function createProfileManager(
  backend: StorageBackend = localStorageBackend,
): ProfileManager {
  let profiles: ServerProfile[] = loadProfiles(backend);

  function persist(): void {
    saveProfiles(backend, profiles);
  }

  return {
    getAll(): readonly ServerProfile[] {
      return [...profiles];
    },

    getById(id: string): ServerProfile | null {
      return profiles.find((p) => p.id === id) ?? null;
    },

    create(data: CreateProfileData): ServerProfile {
      const profile: ServerProfile = {
        ...data,
        id: crypto.randomUUID(),
        lastConnected: null,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
      profiles = [...profiles, profile];
      persist();
      return profile;
    },

    update(id: string, data: UpdateProfileData): ServerProfile | null {
      const index = profiles.findIndex((p) => p.id === id);
      if (index === -1) {
        return null;
      }
      const existing = profiles[index]!;
      const updated: ServerProfile = { ...existing, ...data };
      profiles = profiles.map((p) => (p.id === id ? updated : p));
      persist();
      return updated;
    },

    remove(id: string): boolean {
      const before = profiles.length;
      profiles = profiles.filter((p) => p.id !== id);
      if (profiles.length === before) {
        return false;
      }
      persist();
      return true;
    },

    setLastConnected(id: string): void {
      const index = profiles.findIndex((p) => p.id === id);
      if (index === -1) {
        return;
      }
      const existing = profiles[index]!;
      const updated: ServerProfile = {
        ...existing,
        lastConnected: new Date().toISOString(),
      };
      profiles = profiles.map((p) => (p.id === id ? updated : p));
      persist();
    },

    getAutoConnect(): ServerProfile | null {
      return profiles.find((p) => p.autoConnect) ?? null;
    },

    exportProfiles(): string {
      return JSON.stringify(profiles);
    },

    importProfiles(json: string): { imported: number; skipped: number } {
      let incoming: unknown;
      try {
        incoming = JSON.parse(json);
      } catch {
        return { imported: 0, skipped: 0 };
      }

      if (!Array.isArray(incoming)) {
        return { imported: 0, skipped: 0 };
      }

      const existingHosts = new Set(profiles.map((p) => p.host));
      let imported = 0;
      let skipped = 0;

      for (const raw of incoming) {
        if (!isValidProfileShape(raw)) {
          skipped++;
          continue;
        }
        if (existingHosts.has(raw.host)) {
          skipped++;
        } else {
          const profile: ServerProfile = {
            name: raw.name,
            host: raw.host,
            username: raw.username,
            color: raw.color,
            autoConnect: raw.autoConnect,
            lastConnected: null,
            id: crypto.randomUUID(),
            schemaVersion: CURRENT_SCHEMA_VERSION,
          };
          profiles = [...profiles, profile];
          existingHosts.add(profile.host);
          imported++;
        }
      }

      if (imported > 0) {
        persist();
      }

      return { imported, skipped };
    },

    migrate(): void {
      // Currently a no-op for schema version 1.
      // Future migrations will go here.
    },
  };
}
