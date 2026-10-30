import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  load: vi.fn<() => Promise<unknown>>(),
  save: vi.fn<(data: unknown) => Promise<void>>(),
  httpFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  ensureHttpProxy: vi.fn<(host: string) => Promise<string>>(),
}));
vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/desktop")>();
  return {
    desktop: {
      ...real.desktop,
      settings: { load: host.load, save: host.save },
      http: { fetch: host.httpFetch },
      nativeProxies: { ensureHttpProxy: host.ensureHttpProxy },
    },
  };
});

import {
  createProfileManager,
  createTauriBackend,
  isValidProfileShape,
  type CreateProfileData,
  type FetchFn,
  type PersistenceBackend,
  type ServerProfile,
} from "../../src/lib/presence/profiles";

const A: CreateProfileData = {
  name: "Alpha",
  host: "alpha.example:443",
  username: "ann",
  color: "#111111",
  autoConnect: false,
  rememberPassword: false,
};
const B: CreateProfileData = {
  name: "Beta",
  host: "beta.example:443",
  username: "bob",
  color: "#222222",
  autoConnect: false,
  rememberPassword: true,
};

const full: ServerProfile = {
  id: "p1",
  name: "Alpha",
  host: "alpha.example:443",
  username: "ann",
  autoConnect: false,
  rememberPassword: false,
  color: "#111111",
  lastConnected: null,
};

function memoryBackend(): PersistenceBackend {
  return { load: () => Promise.resolve(null), save: () => Promise.resolve() };
}

function ok(body: unknown = { version: "1.0.0", online_users: 2 }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

let uuid = 0;
beforeEach(() => {
  uuid = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `id-${String(++uuid)}` });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  host.load.mockReset();
  host.save.mockReset();
  host.httpFetch.mockReset();
  host.ensureHttpProxy.mockReset();
});

describe("isValidProfileShape", () => {
  it("accepts a complete profile, with or without rememberPassword, and any string lastConnected", () => {
    expect(isValidProfileShape(full)).toBe(true);
    const { rememberPassword: _omitted, ...bare } = full;
    expect(isValidProfileShape(bare)).toBe(true);
    expect(isValidProfileShape({ ...full, lastConnected: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isValidProfileShape({ ...full, rememberPassword: true })).toBe(true);
  });

  it.each([null, undefined, 42, "profile", true])("rejects %s", (value) => {
    expect(isValidProfileShape(value)).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a non-string id", { id: 5 }],
    ["a non-string name", { name: 5 }],
    ["an empty name", { name: "" }],
    ["a non-string host", { host: 5 }],
    ["an empty host", { host: "" }],
    ["a non-string username", { username: 5 }],
    ["a non-string colour", { color: 5 }],
    ["a non-boolean autoConnect", { autoConnect: "yes" }],
    ["a non-boolean rememberPassword", { rememberPassword: "yes" }],
    ["a numeric lastConnected", { lastConnected: 5 }],
    ["a missing lastConnected", { lastConnected: undefined }],
  ])("rejects a profile with %s", (_label, patch) => {
    expect(isValidProfileShape({ ...full, ...patch })).toBe(false);
  });
});

describe("createTauriBackend envelope checks", () => {
  it.each<[string, unknown]>([
    ["a number", 42],
    ["a string", "profiles"],
    ["an array", []],
    ["a missing schema version", { profiles: [] }],
    ["a non-numeric schema version", { schemaVersion: "1", profiles: [] }],
    ["profiles that are not a list", { schemaVersion: 1, profiles: "none" }],
    ["no profiles", { schemaVersion: 1 }],
  ])("loads nothing from %s", async (_label, raw) => {
    host.load.mockResolvedValue(raw);
    await expect(createTauriBackend().load()).resolves.toBeNull();
  });

  it("keeps the valid entries of a valid envelope", async () => {
    host.load.mockResolvedValue({ schemaVersion: 3, profiles: [full, { junk: true }] });
    await expect(createTauriBackend().load()).resolves.toEqual({
      schemaVersion: 3,
      profiles: [full],
    });
  });

  it("passes a save through to the host", async () => {
    host.save.mockResolvedValue(undefined);
    await createTauriBackend().save({ schemaVersion: 1, profiles: [full] });
    expect(host.save).toHaveBeenCalledWith({ schemaVersion: 1, profiles: [full] });
  });
});

function two() {
  const m = createProfileManager(memoryBackend(), vi.fn());
  const a = m.addProfile(A);
  const b = m.addProfile(B);
  return { m, a, b };
}

const entry = (hostName: string): ServerProfile => ({ ...full, id: hostName, host: hostName });

describe("profile list edits", () => {
  it("updates only the profile it names", () => {
    const { m, a, b } = two();
    const updated = m.updateProfile(b.id, { name: "Beta 2" });
    expect(updated).toEqual({ ...b, name: "Beta 2" });
    expect(m.getById(a.id)).toEqual(a);
    expect(m.getById(b.id)?.name).toBe("Beta 2");
    expect(m.getAll()).toHaveLength(2);
  });

  it("removes only the profile it names", () => {
    const { m, a, b } = two();
    expect(m.removeProfile(a.id)).toBe(true);
    expect(m.getAll()).toEqual([b]);
  });

  it("stamps only the connected profile, wherever it sits in the list", () => {
    const { m, a, b } = two();
    m.setLastConnected(b.id);
    expect(m.getById(a.id)?.lastConnected).toBeNull();
    expect(m.getById(b.id)?.lastConnected).not.toBeNull();
    expect(m.getById(b.id)?.host).toBe(B.host);
    expect(m.getAll().map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("leaves the list untouched when asked to stamp a profile it does not have", () => {
    const { m } = two();
    const before = m.store.getState().profiles;
    m.setLastConnected("missing");
    expect(m.store.getState().profiles).toBe(before);
  });
});

describe("importing profiles", () => {
  it("skips a host that appears twice in one file", () => {
    const m = createProfileManager(memoryBackend(), vi.fn());
    const result = m.importProfiles(JSON.stringify([entry("x.example"), entry("x.example")]));
    expect(result).toEqual({ imported: 1, skipped: 1 });
    expect(m.getAll()).toHaveLength(1);
  });

  it("does not touch the list when nothing was imported", () => {
    const m = createProfileManager(memoryBackend(), vi.fn());
    m.addProfile(A);
    const before = m.store.getState().profiles;
    expect(m.importProfiles(JSON.stringify([entry(A.host)]))).toEqual({ imported: 0, skipped: 1 });
    expect(m.store.getState().profiles).toBe(before);
  });

  it.each(["null", "42", '"text"', "true"])("imports nothing from the JSON %s", (json) => {
    const m = createProfileManager(memoryBackend(), vi.fn());
    expect(m.importProfiles(json)).toEqual({ imported: 0, skipped: 0 });
  });

  it("takes an envelope only when every entry in it is a valid profile", () => {
    const m = createProfileManager(memoryBackend(), vi.fn());
    const bad = { schemaVersion: 1, profiles: [entry("y.example"), { junk: true }] };
    expect(m.importProfiles(JSON.stringify(bad))).toEqual({ imported: 0, skipped: 0 });
    const good = { schemaVersion: 1, profiles: [entry("y.example")] };
    expect(m.importProfiles(JSON.stringify(good))).toEqual({ imported: 1, skipped: 0 });
  });

  it("does not take an envelope with a missing or non-numeric schema version", () => {
    const m = createProfileManager(memoryBackend(), vi.fn());
    expect(m.importProfiles(JSON.stringify({ profiles: [entry("z.example")] }))).toEqual({
      imported: 0,
      skipped: 0,
    });
    expect(
      m.importProfiles(JSON.stringify({ schemaVersion: "1", profiles: [entry("z.example")] })),
    ).toEqual({ imported: 0, skipped: 0 });
  });
});

describe("health checks", () => {
  it("pings the profile it names, not the first one", async () => {
    const fetchFn = vi.fn((_url: string) => Promise.resolve(ok()));
    const m = createProfileManager(memoryBackend(), fetchFn as unknown as FetchFn);
    m.addProfile(A);
    const b = m.addProfile(B);
    await m.checkHealth(b.id);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://beta.example:443/api/v1/health");
  });

  it("goes through the local proxy unless a fetch was injected", async () => {
    host.ensureHttpProxy.mockResolvedValue("http://127.0.0.1:5555");
    host.httpFetch.mockResolvedValue(ok());
    const m = createProfileManager(memoryBackend());
    const a = m.addProfile(A);
    const result = await m.checkHealth(a.id);
    expect(host.ensureHttpProxy).toHaveBeenCalledWith(A.host);
    expect(host.httpFetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5555/api/v1/health");
    expect(result.status).toBe("online");

    const injected = vi.fn(() => Promise.resolve(ok()));
    const direct = createProfileManager(memoryBackend(), injected);
    host.ensureHttpProxy.mockClear();
    await direct.checkHealth(direct.addProfile(A).id);
    expect(host.ensureHttpProxy).not.toHaveBeenCalled();
  });

  it("calls a slow answer slow only past 1500 ms", async () => {
    vi.useFakeTimers();
    let latency = 1500;
    const fetchFn = vi.fn(() => {
      vi.advanceTimersByTime(latency);
      return Promise.resolve(ok());
    });
    const m = createProfileManager(memoryBackend(), fetchFn);
    const a = m.addProfile(A);
    const exact = await m.checkHealth(a.id);
    expect(exact).toMatchObject({ status: "online", latencyMs: 1500 });
    latency = 1501;
    const over = await m.checkHealth(a.id);
    expect(over).toMatchObject({ status: "slow", latencyMs: 1501 });
  });

  it("gives up after three seconds and cleans its timer up after an answer", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const m = createProfileManager(memoryBackend(), fetchFn as unknown as FetchFn);
    const a = m.addProfile(A);
    const pending = m.checkHealth(a.id);
    await vi.advanceTimersByTimeAsync(2999);
    expect(m.store.getState().healthStatuses.get(a.id)?.status).toBe("checking");
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      status: "offline",
      latencyMs: null,
      version: null,
      onlineUsers: null,
    });
    expect(vi.getTimerCount()).toBe(0);

    fetchFn.mockImplementation(() => Promise.resolve(ok()));
    await m.checkHealth(a.id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows every profile as checking while a full check runs, then each result", async () => {
    const gates: Array<() => void> = [];
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          gates.push(() => resolve(ok({ version: "9.9.9", online_users: 4 })));
        }),
    );
    const m = createProfileManager(memoryBackend(), fetchFn);
    const a = m.addProfile(A);
    const b = m.addProfile(B);
    const all = m.checkAllHealth();
    const statuses = () => m.store.getState().healthStatuses;
    expect(statuses().get(a.id)?.status).toBe("checking");
    expect(statuses().get(b.id)?.status).toBe("checking");
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    for (const open of gates) open();
    const results = await all;
    expect(results.get(a.id)).toMatchObject({ status: "online", version: "9.9.9", onlineUsers: 4 });
    expect(statuses().get(a.id)).toBe(results.get(a.id));
    expect(statuses().get(b.id)).toBe(results.get(b.id));
  });
});
