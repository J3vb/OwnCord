import { readFileSync } from "node:fs";
import { makeDm } from "../helpers/dmHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerRail } from "../../src/features/server-rail/ServerRail";
import { setSidebarMode, uiStore } from "@stores/ui.store";
import { dmStore, setDmChannels, type DmChannel } from "@stores/dm.store";
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  resetVoiceStore,
  voiceStore,
} from "@stores/voice.store";
import { RAIL_LAYOUT_KEY } from "@lib/prefs/serverRailLayout";
import { authStore, clearAuth } from "@stores/auth.store";
import type { ServerProfile } from "@lib/presence/profiles";
import {
  applyFrame,
  messageRequestsStore,
  pendingRequestCount,
  resetMessageRequests,
} from "../../src/features/message-requests/store";
import type { MessageRequest } from "../../src/features/message-requests/api";

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
  loadServers?: () => Promise<readonly ServerProfile[]>;
  currentHost?: string;
  currentName?: string | null;
  joinInvite?: (t: string) => boolean;
  onOpenDm?: (dm: DmChannel) => void;
  onShowServer?: () => void;
  withRequests?: boolean;
}

const mounted: Array<{ destroy?: () => void }> = [];

async function mountRail(o: Opts = {}) {
  const switchServer = vi.fn();
  const addServer = vi.fn();
  const joinInvite = vi.fn(o.joinInvite ?? (() => false));
  setServerName(o.currentName === undefined ? "Alpha" : o.currentName);
  const rail = createServerRail({
    currentHost: o.currentHost ?? "a.example",
    loadServers: o.loadServers ?? (() => Promise.resolve(o.profiles ?? [])),
    switchServer,
    addServer,
    joinInvite,
    newFolderId: () => "fid",
    ...(o.onOpenDm !== undefined ? { onOpenDm: o.onOpenDm } : {}),
    ...(o.onShowServer !== undefined ? { onShowServer: o.onShowServer } : {}),
    ...(o.withRequests === true ? { pendingRequests: pendingRequestCount } : {}),
  });
  rail.mount(document.body);
  mounted.push(rail);
  await Promise.resolve();
  await Promise.resolve();
  return { rail, switchServer, addServer, joinInvite };
}

function request(id: number): MessageRequest {
  return {
    id,
    channelId: 200 + id,
    sender: { id: 10 + id, username: `s${id}`, displayName: "" },
    preview: null,
    createdAt: "2026-11-13T10:00:00Z",
  };
}

function dm(channelId: number, unreadCount: number): DmChannel {
  const user = { id: channelId, username: `u${channelId}`, avatar: "", status: "online" as const };
  return makeDm({ channelId, recipient: user, participants: [user], unreadCount });
}

function setServerName(serverName: string | null): void {
  authStore.setState((s) => ({ ...s, serverName }));
  authStore.flush();
}

const glyph = (btn: HTMLElement | undefined) => btn?.querySelector('[data-icon="server"]');

const servers = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="server-rail-server"]'));

describe("ServerRail", () => {
  beforeEach(() => {
    localStorage.clear();
    setSidebarMode("channels");
  });
  afterEach(() => {
    for (const r of mounted.splice(0)) r.destroy?.();
    document.body.innerHTML = "";
    dmStore.setState(() => ({ channels: [] }));
    resetVoiceStore();
    setServerName(null);
  });

  it("clicking the connected server goes back to its channels", async () => {
    const onShowServer = vi.fn();
    const { switchServer } = await mountRail({ onShowServer });
    setSidebarMode("dms");
    servers()[0]!.click();
    expect(onShowServer).toHaveBeenCalledTimes(1);
    expect(switchServer).not.toHaveBeenCalled();
  });

  it("closes its open dialog when the rail is destroyed", async () => {
    const { rail } = await mountRail();
    document.querySelector<HTMLElement>('[data-testid="server-rail-join"]')?.click();
    expect(document.querySelector('[data-testid="server-rail-join-dialog"]')).not.toBeNull();
    rail.destroy?.();
    expect(document.querySelector('[data-testid="server-rail-join-dialog"]')).toBeNull();
  });

  it("shows the unread DM total on Home and hides it at zero", async () => {
    await mountRail();
    const badge = document.querySelector<HTMLElement>('[data-testid="server-rail-home-badge"]')!;
    const home = document.querySelector<HTMLElement>('[data-testid="server-rail-home"]')!;
    expect(badge.hidden).toBe(true);
    expect(home.getAttribute("aria-label")).toBe("Home");
    setDmChannels([dm(1, 2), dm(2, 3)]);
    dmStore.flush();
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("5");
    expect(home.getAttribute("aria-label")).toBe("Home, 5 unread direct messages");
    setDmChannels([dm(1, 0)]);
    dmStore.flush();
    expect(badge.hidden).toBe(true);
  });

  it("badges Home for a request that arrives in another view, until the last is handled", async () => {
    resetMessageRequests();
    await mountRail({ withRequests: true });
    const badge = document.querySelector<HTMLElement>('[data-testid="server-rail-home-badge"]')!;
    const home = document.querySelector<HTMLElement>('[data-testid="server-rail-home"]')!;
    expect(badge.hidden).toBe(true);

    applyFrame(request(1), true);
    messageRequestsStore.flush();
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe("1");
    expect(home.getAttribute("aria-label")).toBe("Home, 1 message request waiting");

    // One badge for both: unread DMs and waiting requests add up, the name splits them.
    setDmChannels([dm(1, 2)]);
    dmStore.flush();
    expect(document.querySelectorAll('[data-testid="server-rail-home-badge"]')).toHaveLength(1);
    expect(badge.textContent).toBe("3");
    expect(home.getAttribute("aria-label")).toBe("Home, 2 unread, 1 message request waiting");
    setDmChannels([dm(1, 0)]);
    dmStore.flush();

    // Accepted, declined or blocked: the frame takes it out of pending.
    applyFrame(request(1), false);
    messageRequestsStore.flush();
    expect(badge.hidden).toBe(true);
    expect(home.getAttribute("aria-label")).toBe("Home");

    // Sign-out or server switch empties the inbox, and the badge with it.
    applyFrame(request(2), true);
    applyFrame(request(3), true);
    messageRequestsStore.flush();
    expect(home.getAttribute("aria-label")).toBe("Home, 2 message requests waiting");
    resetMessageRequests();
    messageRequestsStore.flush();
    expect(badge.hidden).toBe(true);
  });

  it("lists only DMs with unread messages under Home, newest first, and opens one", async () => {
    const onOpenDm = vi.fn();
    await mountRail({ onOpenDm });
    const older = { ...dm(1, 2), lastMessageAt: "2026-10-28T10:00:00Z" };
    const newer = { ...dm(2, 1), lastMessageAt: "2026-10-28T11:00:00Z" };
    setDmChannels([older, dm(3, 0), newer]);
    dmStore.flush();
    const icons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="server-rail-dm"]'),
    );
    expect(icons.map((b) => b.dataset["channelId"])).toEqual(["2", "1"]);
    expect(icons[1]!.getAttribute("aria-label")).toBe("u1, 2 unread messages");
    icons[0]!.click();
    expect(onOpenDm).toHaveBeenCalledWith(expect.objectContaining({ channelId: 2 }));
    setDmChannels([
      { ...older, unreadCount: 0 },
      { ...newer, unreadCount: 0 },
    ]);
    dmStore.flush();
    expect(document.querySelectorAll('[data-testid="server-rail-dm"]')).toHaveLength(0);
  });

  it("keeps the DM of your call first under Home with a call badge until the call ends", async () => {
    const onOpenDm = vi.fn();
    await mountRail({ onOpenDm });
    const unread = { ...dm(1, 2), lastMessageAt: "2026-10-28T11:00:00Z" };
    setDmChannels([unread, dm(2, 0)]);
    dmStore.flush();
    joinVoiceChannel(2);
    voiceStore.flush();

    const call = document.querySelector<HTMLButtonElement>('[data-testid="server-rail-dm-call"]')!;
    expect(call.dataset["channelId"]).toBe("2");
    expect(call.getAttribute("aria-label")).toBe("In a call with u2");
    expect(call.parentElement?.querySelector(".server-rail-call-badge")).not.toBeNull();
    const icons = Array.from(
      document.querySelectorAll<HTMLElement>(".server-rail-dms [data-channel-id]"),
    );
    expect(icons.map((b) => b.dataset["channelId"])).toEqual(["2", "1"]);
    call.click();
    expect(onOpenDm).toHaveBeenCalledWith(expect.objectContaining({ channelId: 2 }));

    leaveVoiceChannel();
    voiceStore.flush();
    expect(document.querySelector('[data-testid="server-rail-dm-call"]')).toBeNull();
    expect(
      Array.from(document.querySelectorAll<HTMLElement>(".server-rail-dms [data-channel-id]")).map(
        (b) => b.dataset["channelId"],
      ),
    ).toEqual(["1"]);
  });

  it("shows the call DM once, with its unread count in the label", async () => {
    await mountRail();
    setDmChannels([dm(3, 4)]);
    dmStore.flush();
    joinVoiceChannel(3);
    voiceStore.flush();
    expect(document.querySelectorAll('.server-rail-dms [data-channel-id="3"]')).toHaveLength(1);
    expect(
      document.querySelector('[data-testid="server-rail-dm-call"]')?.getAttribute("aria-label"),
    ).toBe("In a call with u3, 4 unread messages");
  });

  it("shows no call icon for a call outside the known DMs until the DM list has it", async () => {
    await mountRail();
    joinVoiceChannel(9);
    voiceStore.flush();
    expect(document.querySelector('[data-testid="server-rail-dm-call"]')).toBeNull();
    setDmChannels([dm(9, 0)]);
    dmStore.flush();
    expect(document.querySelector('[data-testid="server-rail-dm-call"]')).not.toBeNull();
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

  describe("server name on the connected server's icon", () => {
    it("shows the name's initials once the name arrives after mount", async () => {
      await mountRail({
        profiles: [profile("127.0.0.1", "127.0.0.1:8443")],
        currentHost: "127.0.0.1:8443",
        currentName: null,
      });
      expect(servers()[0]?.textContent).toBe("");
      expect(glyph(servers()[0])).not.toBeNull();
      setServerName("Game Night Crew");
      expect(servers()[0]?.textContent).toBe("GN");
      expect(glyph(servers()[0])).toBeNull();
      expect(servers()[0]?.getAttribute("aria-label")).toContain("Game Night Crew");
      expect(servers()[0]?.title).toContain("Game Night Crew");
      setServerName("Board Game Club");
      expect(servers()[0]?.textContent).toBe("BG");
    });

    it("drops the old name on logout and does not carry it to the next server", async () => {
      const { rail } = await mountRail({ currentHost: "10.0.0.5", currentName: "Game Night Crew" });
      expect(servers()[0]?.textContent).toBe("GN");
      clearAuth();
      authStore.flush();
      expect(servers()[0]?.textContent).toBe("");
      expect(glyph(servers()[0])).not.toBeNull();
      expect(servers()[0]?.getAttribute("aria-label")).toContain("10.0.0.5");
      rail.destroy?.();
      await mountRail({ currentHost: "chat.example.com", currentName: null });
      expect(servers()[0]?.textContent).toBe("CH");
      setServerName("Bravo");
      expect(servers()[0]?.textContent).toBe("BR");
    });

    it("keeps a profile name the user chose, and never shows another server's live name", async () => {
      await mountRail({
        profiles: [profile("My LAN", "a.example"), profile("192.168.1.9", "192.168.1.9")],
        currentHost: "a.example",
        currentName: "Game Night Crew",
      });
      expect(servers().map((b) => b.textContent)).toEqual(["ML", ""]);
      expect(glyph(servers()[1])).not.toBeNull();
    });
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

  it("without the question, switches once even on a double click, and ignores add afterwards", async () => {
    localStorage.setItem("owncord:settings:confirmServerSwitch", "false");
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

  describe("switch question", () => {
    const dialog = () => document.querySelector('[data-testid="server-switch-dialog"]');
    const click = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
    const mountTwo = () =>
      mountRail({ profiles: [profile("Beta", "b.example"), profile("Alpha", "a.example")] });
    const beta = () => servers().find((b) => b.dataset["host"] === "b.example")!;

    it("asks before switching and switches on Switch", async () => {
      const { switchServer } = await mountTwo();
      beta().click();
      expect(dialog()?.textContent).toContain("Switch to Beta?");
      expect(switchServer).not.toHaveBeenCalled();
      click("server-switch-confirm");
      expect(switchServer).toHaveBeenCalledExactlyOnceWith("b.example");
      expect(dialog()).toBeNull();
    });

    it("Cancel stays, and leaves the setting alone even with the box ticked", async () => {
      const { switchServer } = await mountTwo();
      beta().click();
      click("server-switch-dont-ask");
      click("server-switch-cancel");
      expect(dialog()).toBeNull();
      expect(switchServer).not.toHaveBeenCalled();
      expect(localStorage.getItem("owncord:settings:confirmServerSwitch")).toBeNull();
    });

    it("a double click opens one question and switches once", async () => {
      const { switchServer } = await mountTwo();
      beta().click();
      beta().click();
      expect(document.querySelectorAll('[data-testid="server-switch-dialog"]')).toHaveLength(1);
      const confirm = document.querySelector<HTMLElement>('[data-testid="server-switch-confirm"]')!;
      confirm.click();
      confirm.click();
      expect(switchServer).toHaveBeenCalledTimes(1);
    });

    it("Don't ask again is saved on Switch and the next click switches straight away", async () => {
      const first = await mountTwo();
      beta().click();
      click("server-switch-dont-ask");
      click("server-switch-confirm");
      expect(localStorage.getItem("owncord:settings:confirmServerSwitch")).toBe("false");
      first.rail.destroy?.();

      const second = await mountTwo();
      beta().click();
      expect(dialog()).toBeNull();
      expect(second.switchServer).toHaveBeenCalledExactlyOnceWith("b.example");
    });

    it("closes without switching when the rail goes away with the question open", async () => {
      const { rail, switchServer } = await mountTwo();
      beta().click();
      const confirm = document.querySelector<HTMLElement>('[data-testid="server-switch-confirm"]')!;
      rail.destroy?.();
      expect(dialog()).toBeNull();
      confirm.click();
      expect(switchServer).not.toHaveBeenCalled();
    });

    it("asks again after Cancel", async () => {
      await mountTwo();
      beta().click();
      click("server-switch-cancel");
      beta().click();
      expect(dialog()).not.toBeNull();
    });
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

  describe("when the saved servers could not be read", () => {
    const saved = [
      {
        kind: "folder",
        id: "f1",
        name: "Work",
        color: "#fff",
        collapsed: false,
        hosts: ["a.example", "b.example"],
      },
      { kind: "server", host: "c.example" },
    ];

    it("keeps the stored folders and order through a layout action", async () => {
      localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify(saved));
      await mountRail({ loadServers: () => Promise.reject(new Error("store down")) });

      document.querySelector<HTMLElement>('[data-testid="server-rail-folder-toggle"]')!.click();

      expect(JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "null")).toEqual(saved);
    });

    it("reads the servers again on the next layout action and then applies it", async () => {
      localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify(saved));
      const loadServers = vi
        .fn<() => Promise<ReturnType<typeof profile>[]>>()
        .mockRejectedValueOnce(new Error("store down"))
        .mockResolvedValue([
          profile("Alpha", "a.example"),
          profile("Beta", "b.example"),
          profile("Gamma", "c.example"),
        ]);
      await mountRail({ loadServers });

      document.querySelector<HTMLElement>('[data-testid="server-rail-folder-toggle"]')!.click();
      for (let i = 0; i < 3; i++) await Promise.resolve();

      expect(loadServers).toHaveBeenCalledTimes(2);
      const stored = JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "[]") as Array<{
        collapsed?: boolean;
      }>;
      expect(stored[0]?.collapsed).toBe(true);
    });

    it("saves layout actions once the servers have loaded", async () => {
      localStorage.setItem(RAIL_LAYOUT_KEY, JSON.stringify(saved));
      await mountRail({
        profiles: [
          profile("Alpha", "a.example"),
          profile("Beta", "b.example"),
          profile("Gamma", "c.example"),
        ],
      });

      document.querySelector<HTMLElement>('[data-testid="server-rail-folder-toggle"]')!.click();

      const stored = JSON.parse(localStorage.getItem(RAIL_LAYOUT_KEY) ?? "[]") as Array<{
        collapsed?: boolean;
      }>;
      expect(stored[0]?.collapsed).toBe(true);
      expect(stored).toHaveLength(2);
    });
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
    const shell = readFileSync("src/pages/main-page/pageMountShell.ts", "utf8");
    expect(shell).toMatch(/if \(!__OWNCORD_WEB__\) \{[\s\S]{0,400}mountServerRail\(/);
    const loader = readFileSync("src/features/server-rail/mountServerRail.ts", "utf8");
    expect(loader).toMatch(/import\("\.\/ServerRail"\)/);
    expect(loader.match(/createServerRail/g)?.length).toBe(2);
  });
});
