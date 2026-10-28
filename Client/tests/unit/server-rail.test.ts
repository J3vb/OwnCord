import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerRail } from "@components/ServerRail";
import { setSidebarMode, uiStore } from "@stores/ui.store";
import { RAIL_LAYOUT_KEY } from "@lib/serverRailLayout";
import type { ServerProfile } from "@lib/profiles";

function profile(name: string, host: string, color = "#5865f2"): ServerProfile {
  return {
    id: host,
    name,
    host,
    username: "u",
    autoConnect: false,
    rememberPassword: false,
    color,
    lastConnected: null,
  };
}

interface Opts {
  profiles?: ServerProfile[];
  currentHost?: string;
  currentName?: string;
  joinInvite?: (t: string) => boolean;
}

async function mountRail(o: Opts = {}) {
  const switchServer = vi.fn();
  const addServer = vi.fn();
  const joinInvite = vi.fn(o.joinInvite ?? (() => false));
  const rail = createServerRail({
    currentHost: o.currentHost ?? "a.example",
    currentName: o.currentName ?? "Alpha",
    loadServers: () => Promise.resolve(o.profiles ?? []),
    switchServer,
    addServer,
    joinInvite,
    newFolderId: () => "fid",
  });
  rail.mount(document.body);
  await Promise.resolve();
  await Promise.resolve();
  return { rail, switchServer, addServer, joinInvite };
}

const servers = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="server-rail-server"]'));

describe("ServerRail", () => {
  beforeEach(() => {
    localStorage.clear();
    setSidebarMode("channels");
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders saved servers plus the current one, with initials and nav semantics", async () => {
    await mountRail({
      profiles: [profile("Beta Base", "b.example")],
      currentHost: "a.example",
      currentName: "Alpha",
    });
    const nav = document.querySelector("nav.server-rail");
    expect(nav?.getAttribute("aria-label")).toBeTruthy();
    expect(servers().map((b) => b.dataset["host"])).toEqual(["b.example", "a.example"]);
    expect(servers()[0]?.textContent).toBe("BB");
    expect(servers()[1]?.getAttribute("aria-label")).toContain("Alpha");
  });

  it("marks the current server active in channels mode and Home active in DM mode", async () => {
    await mountRail({ profiles: [profile("Alpha", "a.example")] });
    const cur = servers()[0];
    expect(cur?.getAttribute("aria-current")).toBe("true");
    setSidebarMode("dms");
    uiStore.flush();
    expect(servers()[0]?.hasAttribute("aria-current")).toBe(false);
    expect(
      document.querySelector('[data-testid="server-rail-home"]')?.getAttribute("aria-current"),
    ).toBe("true");
    servers()[0]?.click();
    expect(uiStore.getState().sidebarMode).toBe("channels");
  });

  it("Home switches the sidebar to DM mode", async () => {
    await mountRail();
    document.querySelector<HTMLElement>('[data-testid="server-rail-home"]')?.click();
    expect(uiStore.getState().sidebarMode).toBe("dms");
  });

  it("switches once even on a double click, and ignores add afterwards", async () => {
    const { switchServer, addServer } = await mountRail({
      profiles: [profile("Beta", "b.example"), profile("Alpha", "a.example")],
    });
    const beta = servers().find((b) => b.dataset["host"] === "b.example");
    beta?.click();
    beta?.click();
    expect(switchServer).toHaveBeenCalledTimes(1);
    expect(switchServer).toHaveBeenCalledWith("b.example");
    document.querySelector<HTMLElement>('[data-testid="server-rail-add"]')?.click();
    expect(addServer).not.toHaveBeenCalled();
  });

  it("+ calls add-server", async () => {
    const { addServer } = await mountRail();
    document.querySelector<HTMLElement>('[data-testid="server-rail-add"]')?.click();
    expect(addServer).toHaveBeenCalledTimes(1);
  });

  it("compass opens the invite dialog and rejects an invalid link inline", async () => {
    const { joinInvite } = await mountRail();
    document.querySelector<HTMLElement>('[data-testid="server-rail-join"]')?.click();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="server-rail-join-input"]',
    );
    expect(input).not.toBeNull();
    input!.value = "garbage!!";
    document.querySelector<HTMLElement>('[data-testid="server-rail-join-submit"]')?.click();
    expect(joinInvite).toHaveBeenCalledWith("garbage!!");
    const err = document.querySelector<HTMLElement>('[data-testid="server-rail-join-error"]');
    expect(err?.hidden).toBe(false);
    expect(err?.textContent).toBeTruthy();
    expect(document.querySelector('[data-testid="server-rail-join-dialog"]')).not.toBeNull();
    document.querySelector<HTMLElement>('[data-testid="server-rail-join-cancel"]')?.click();
    expect(document.querySelector('[data-testid="server-rail-join-dialog"]')).toBeNull();
  });

  it("closes the invite dialog when the link is accepted", async () => {
    await mountRail({ joinInvite: () => true });
    document.querySelector<HTMLElement>('[data-testid="server-rail-join"]')?.click();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="server-rail-join-input"]',
    );
    input!.value = "owncord://invite/abcd1234";
    document.querySelector<HTMLElement>('[data-testid="server-rail-join-submit"]')?.click();
    expect(document.querySelector('[data-testid="server-rail-join-dialog"]')).toBeNull();
  });

  it("reconciles a saved layout naming a removed server and missing a new one", async () => {
    localStorage.setItem(
      RAIL_LAYOUT_KEY,
      JSON.stringify([
        { kind: "server", host: "removed.example" },
        { kind: "server", host: "a.example" },
      ]),
    );
    await mountRail({
      profiles: [profile("Alpha", "a.example"), profile("New", "new.example")],
    });
    expect(servers().map((b) => b.dataset["host"])).toEqual(["a.example", "new.example"]);
  });

  it("context menu groups with the next server and shows a folder", async () => {
    await mountRail({
      profiles: [profile("Alpha", "a.example"), profile("Beta", "b.example")],
    });
    servers()[0]?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    document.querySelector<HTMLElement>('[data-testid="rail-group-next"]')?.click();
    expect(document.querySelector('[data-testid="server-rail-folder"]')).not.toBeNull();
    const saved = JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "[]") as unknown[];
    expect(saved).toHaveLength(1);
  });

  it("dropping a server on another creates a folder", async () => {
    await mountRail({
      profiles: [profile("Alpha", "a.example"), profile("Beta", "b.example")],
    });
    const [a, b] = servers();
    const target = b!.closest<HTMLElement>(".server-rail-item")!;
    a!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    expect(target.classList.contains("drop-into")).toBe(true);
    target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(document.querySelectorAll('[data-testid="server-rail-folder"]')).toHaveLength(1);
  });

  it("destroy removes the rail", async () => {
    const { rail } = await mountRail();
    rail.destroy?.();
    expect(document.querySelector("nav.server-rail")).toBeNull();
  });
});

describe("web portal", () => {
  it("MainPage only creates the rail outside the web build", () => {
    const src = readFileSync("src/pages/MainPage.ts", "utf8");
    expect(src).toMatch(
      /if \(!__OWNCORD_WEB__\) \{[\s\S]{0,400}import\("@components\/ServerRail"\)/,
    );
    expect(src.match(/createServerRail/g)?.length).toBe(2);
  });
});
