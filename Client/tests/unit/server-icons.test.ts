import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_ICONS_KEY,
  SERVER_ICONS_MAX,
  SERVER_ICON_CHANGED,
  SERVER_ICON_DATA_URL_MAX,
  cachedServerIcon,
  dropServerIcon,
  storeServerIcon,
  syncServerIcon,
} from "@lib/prefs/serverIcons";
import { createServerRail } from "../../src/features/server-rail/ServerRail";
import { authStore } from "@stores/auth.store";
import type { ServerProfile } from "@lib/presence/profiles";

const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";
const URL1 = "data:image/png;base64,AAAA";
const URL2 = "data:image/png;base64,BBBB";

beforeEach(() => localStorage.clear());

describe("server icon cache", () => {
  it("stores one entry per host and replaces it", () => {
    expect(storeServerIcon("a.example", { hash: H1, dataUrl: URL1 })).toBe(true);
    expect(storeServerIcon("a.example", { hash: H2, dataUrl: URL2 })).toBe(true);
    expect(cachedServerIcon("a.example")).toEqual({ hash: H2, dataUrl: URL2 });
  });

  it("refuses an entry that is not a short hash with a PNG data URL, or is too large", () => {
    expect(storeServerIcon("a", { hash: "xyz", dataUrl: URL1 })).toBe(false);
    expect(storeServerIcon("a", { hash: H1, dataUrl: "https://evil.example/x.png" })).toBe(false);
    const big = "data:image/png;base64," + "A".repeat(SERVER_ICON_DATA_URL_MAX);
    expect(storeServerIcon("a", { hash: H1, dataUrl: big })).toBe(false);
    expect(cachedServerIcon("a")).toBeUndefined();
  });

  it("keeps at most SERVER_ICONS_MAX hosts, oldest out first", () => {
    for (let i = 0; i <= SERVER_ICONS_MAX; i++) {
      storeServerIcon(`h${i}.example`, { hash: H1, dataUrl: URL1 });
    }
    expect(cachedServerIcon("h0.example")).toBeUndefined();
    expect(cachedServerIcon(`h${SERVER_ICONS_MAX}.example`)).toBeDefined();
  });

  it("reads damaged storage as empty", () => {
    localStorage.setItem(SERVER_ICONS_KEY, "{not json");
    expect(cachedServerIcon("a")).toBeUndefined();
    localStorage.setItem(SERVER_ICONS_KEY, JSON.stringify([{ host: "a", hash: 1 }, 7, null]));
    expect(cachedServerIcon("a")).toBeUndefined();
  });
});

describe("syncServerIcon", () => {
  it("fetches and stores when the hash is new", async () => {
    const fetchIcon = vi.fn(() => Promise.resolve(URL1));
    await syncServerIcon("a", H1, fetchIcon);
    expect(fetchIcon).toHaveBeenCalledOnce();
    expect(cachedServerIcon("a")).toEqual({ hash: H1, dataUrl: URL1 });
  });

  it("does not fetch when the cached hash is current", async () => {
    storeServerIcon("a", { hash: H1, dataUrl: URL1 });
    const fetchIcon = vi.fn(() => Promise.resolve(URL2));
    await syncServerIcon("a", H1, fetchIcon);
    expect(fetchIcon).not.toHaveBeenCalled();
  });

  it("refetches and replaces the entry when the owner changed the icon", async () => {
    storeServerIcon("a", { hash: H1, dataUrl: URL1 });
    await syncServerIcon("a", H2, () => Promise.resolve(URL2));
    expect(cachedServerIcon("a")).toEqual({ hash: H2, dataUrl: URL2 });
  });

  it("drops the entry when the icon was removed (empty hash)", async () => {
    storeServerIcon("a", { hash: H1, dataUrl: URL1 });
    const fetchIcon = vi.fn(() => Promise.resolve(URL2));
    await syncServerIcon("a", "", fetchIcon);
    expect(fetchIcon).not.toHaveBeenCalled();
    expect(cachedServerIcon("a")).toBeUndefined();
  });

  it("keeps the old entry when the fetch fails or the server sends no icon field", async () => {
    storeServerIcon("a", { hash: H1, dataUrl: URL1 });
    await syncServerIcon("a", H2, () => Promise.resolve(null));
    await syncServerIcon("a", undefined, () => Promise.resolve(URL2));
    await syncServerIcon("a", "not-a-hash", () => Promise.resolve(URL2));
    expect(cachedServerIcon("a")).toEqual({ hash: H1, dataUrl: URL1 });
  });
});

describe("server rail icon", () => {
  const profile: ServerProfile = {
    id: "b",
    name: "Beta Base",
    host: "b.example",
    username: "u",
    autoConnect: false,
    rememberPassword: false,
    color: "#5865f2",
    lastConnected: null,
  };
  const mounted: Array<{ destroy?: () => void }> = [];

  afterEach(() => {
    for (const r of mounted.splice(0)) r.destroy?.();
    document.body.innerHTML = "";
    authStore.setState((s) => ({ ...s, serverName: null }));
  });

  async function mountRail(): Promise<HTMLElement> {
    const rail = createServerRail({
      currentHost: "a.example",
      loadServers: () => Promise.resolve([profile]),
      switchServer: vi.fn(),
      addServer: vi.fn(),
      joinInvite: () => false,
      newFolderId: () => "fid",
    });
    rail.mount(document.body);
    mounted.push(rail);
    await Promise.resolve();
    await Promise.resolve();
    const btn = document.querySelector<HTMLElement>('[data-host="b.example"]');
    if (btn === null) throw new Error("server button missing");
    return btn;
  }

  it("shows the cached picture, then initials again once the icon is removed", async () => {
    storeServerIcon("b.example", { hash: H1, dataUrl: URL1 });
    await mountRail();
    const img = document.querySelector<HTMLImageElement>('[data-host="b.example"] img');
    expect(img?.getAttribute("src")).toBe(URL1);
    expect(img?.alt).toBe("Beta Base");

    dropServerIcon("b.example");
    const btn = document.querySelector('[data-host="b.example"]');
    expect(btn?.querySelector("img")).toBeNull();
    expect(btn?.textContent).toBe("BB");
  });

  it("swaps the picture when the cache entry changes while mounted", async () => {
    await mountRail();
    expect(document.querySelector('[data-host="b.example"] img')).toBeNull();
    const seen = vi.fn();
    window.addEventListener(SERVER_ICON_CHANGED, seen, { once: true });
    storeServerIcon("b.example", { hash: H1, dataUrl: URL1 });
    expect(seen).toHaveBeenCalled();
    storeServerIcon("b.example", { hash: H2, dataUrl: URL2 });
    expect(document.querySelector('[data-host="b.example"] img')?.getAttribute("src")).toBe(URL2);
  });
});
