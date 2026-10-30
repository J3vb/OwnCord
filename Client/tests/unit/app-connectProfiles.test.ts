/**
 * Tests for src/app/connectProfiles.ts (WP 7.4f): the connect page's
 * saved-server helpers, moved out of main.ts. createConnectProfiles() gets an
 * in-memory profile manager and a real SessionScope as the page owner.
 *
 * The two edge cases the move must keep: a credential delete that fails after
 * the connect page left shows no notice (the owner guard), and the host of a
 * login in flight is never touched by mutateAutoLogin (its own save/delete
 * already decides that credential).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionScope } from "@lib/net/sessionScope";
import type { ProfileManager } from "@lib/profiles";

const hoisted = vi.hoisted(() => ({
  deleteCredential: vi.fn(),
  setTransientError: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@lib/net/credentials", () => ({ deleteCredential: hoisted.deleteCredential }));
vi.mock("@stores/ui.store", () => ({ setTransientError: hoisted.setTransientError }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: hoisted.warn,
    error: vi.fn(),
  }),
}));

import { connectText } from "../../src/i18n/connect";
import { createConnectProfiles } from "../../src/app/connectProfiles";

interface P {
  id: string;
  name: string;
  host: string;
  username?: string;
  autoConnect?: boolean;
  rememberPassword?: boolean;
}

let profiles: P[];
let manager: ProfileManager;
let saveProfiles: ReturnType<typeof vi.fn>;
let owner: SessionScope;

beforeEach(() => {
  hoisted.deleteCredential.mockReset().mockResolvedValue(true);
  hoisted.setTransientError.mockReset();
  hoisted.warn.mockReset();
  profiles = [];
  saveProfiles = vi.fn().mockResolvedValue(undefined);
  let next = 0;
  manager = {
    getAll: () => profiles,
    saveProfiles,
    addProfile: (data: Omit<P, "id">) => {
      const created = { id: `p${++next}`, ...data };
      profiles.push(created);
      return created;
    },
    updateProfile: (id: string, patch: Partial<P>) => {
      const p = profiles.find((x) => x.id === id);
      if (p) Object.assign(p, patch);
      return p ?? null;
    },
    setLastConnected: vi.fn(),
    setAutoLogin: (id: string | null) => {
      for (const p of profiles) p.autoConnect = p.id === id;
    },
  } as unknown as ProfileManager;
  owner = new SessionScope({ host: "", generation: 0 });
});

const make = () => createConnectProfiles(manager, owner);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("getProfileList", () => {
  it("returns the saved profiles", () => {
    profiles.push({ id: "a", name: "A", host: "a.example:8443" });
    expect(make()[0]()).toBe(profiles);
  });

  it("falls back to one synthetic local entry when nothing is saved", () => {
    expect(make()[0]()).toEqual([
      { name: connectText("profiles.defaultName"), host: "localhost:8443", synthetic: true },
    ]);
  });
});

describe("persistProfiles", () => {
  it("saves quietly when the write succeeds", async () => {
    make()[1]();
    await flush();
    expect(saveProfiles).toHaveBeenCalledTimes(1);
    expect(hoisted.setTransientError).not.toHaveBeenCalled();
  });

  it("surfaces a failed write", async () => {
    saveProfiles.mockRejectedValue(new Error("disk full"));
    make()[1]();
    await flush();
    expect(hoisted.setTransientError).toHaveBeenCalledWith(connectText("profiles.saveFailed"));
  });
});

describe("mutateAutoLogin", () => {
  beforeEach(() => {
    profiles.push({ id: "a", name: "A", host: "a.example:8443", autoConnect: true });
  });

  it("deletes the credential of a host that loses its only sign-in reason", async () => {
    make()[2](() => manager.setAutoLogin(null));
    await flush();
    expect(hoisted.deleteCredential).toHaveBeenCalledWith("a.example:8443");
    expect(hoisted.setTransientError).not.toHaveBeenCalled();
  });

  it("keeps the credential while the host still remembers its password", async () => {
    profiles[0]!.rememberPassword = true;
    make()[2](() => manager.setAutoLogin(null));
    await flush();
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
  });

  it("keeps the credential while auto-login stays on that host", async () => {
    make()[2](() => undefined);
    await flush();
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
  });

  it("skips the host of a login in flight", async () => {
    make()[2](() => manager.setAutoLogin(null), "a.example:8443");
    await flush();
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
  });

  it("warns and tells the user when the delete fails on a live page", async () => {
    hoisted.deleteCredential.mockResolvedValue(false);
    make()[2](() => manager.setAutoLogin(null));
    await flush();
    expect(hoisted.warn).toHaveBeenCalledWith(
      "Credential delete failed — the saved sign-in is still stored",
      { host: "a.example:8443" },
    );
    expect(hoisted.setTransientError).toHaveBeenCalledWith(
      connectText("session.passwordRemoveFailed"),
    );
  });

  it("stays silent when the delete fails after the connect page left", async () => {
    hoisted.deleteCredential.mockResolvedValue(false);
    make()[2](() => manager.setAutoLogin(null));
    owner.dispose();
    await flush();
    expect(hoisted.deleteCredential).toHaveBeenCalledTimes(1);
    expect(hoisted.warn).not.toHaveBeenCalled();
    expect(hoisted.setTransientError).not.toHaveBeenCalled();
  });
});

describe("ensureProfileExists", () => {
  it("creates a profile for a new host and persists", async () => {
    make()[3]("new.example:8443", "alex", true, false);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      name: "new.example",
      host: "new.example:8443",
      username: "alex",
      autoConnect: false,
      rememberPassword: true,
      color: "#5865F2",
    });
    expect(manager.setLastConnected).toHaveBeenCalledWith("p1");
    await flush();
    expect(saveProfiles).toHaveBeenCalledTimes(1);
  });

  it("updates the username and remember flag of an existing profile", () => {
    profiles.push({ id: "a", name: "A", host: "a.example:8443", username: "old" });
    make()[3]("a.example:8443", "alex", true, false);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ username: "alex", rememberPassword: true });
    expect(manager.setLastConnected).toHaveBeenCalledWith("a");
  });

  it("makes the profile the auto-login holder when asked", () => {
    profiles.push({ id: "a", name: "A", host: "a.example:8443" });
    profiles.push({ id: "b", name: "B", host: "b.example:8443", autoConnect: true });
    make()[3]("a.example:8443", "alex", false, true);
    expect(profiles.map((p) => p.autoConnect)).toEqual([true, false]);
  });

  it("clears auto-login only when the profile was the holder", () => {
    profiles.push({ id: "a", name: "A", host: "a.example:8443", autoConnect: true });
    make()[3]("a.example:8443", "alex", false, false);
    expect(profiles[0]!.autoConnect).toBe(false);

    profiles.push({ id: "b", name: "B", host: "b.example:8443", autoConnect: true });
    make()[3]("a.example:8443", "alex", false, false);
    expect(profiles[1]!.autoConnect).toBe(true);
  });

  it("never deletes the credential of the host it is signing in", async () => {
    profiles.push({ id: "a", name: "A", host: "a.example:8443", autoConnect: true });
    make()[3]("a.example:8443", "alex", false, false);
    await flush();
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
  });
});
