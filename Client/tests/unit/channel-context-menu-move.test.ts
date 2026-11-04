import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachChannelContextMenu } from "@components/channel-sidebar/contextMenu";
import type { ChannelReorderData } from "@components/ChannelSidebar";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { setDeveloperMode } from "../helpers/message-actions-fixtures";
import type { ChannelAccess } from "../../src/features/channels/channelRow.view";
import type { Channel } from "@stores/channels.store";
import { signInAs } from "../helpers/storeSeeds";
import { makeChannel } from "../helpers/channelFactory";
import { contextMenuAt4, useChannelMenuHost } from "../helpers/channelMenuHost";

const channel = (id: number, position: number): Channel =>
  makeChannel({ id, name: `ch-${id}`, position });

let container: HTMLDivElement;
let ac: AbortController;
useChannelMenuHost((c, a) => {
  container = c;
  ac = a;
});

beforeEach(() => {
  signInAs(
    { id: 1, username: "tester", avatar: null, role: "owner" },
    { token: "t", serverName: "s", motd: "" },
  );
});

function openMove(
  rows: readonly Channel[],
  target: Channel,
  onReorder: (reorders: readonly ChannelReorderData[]) => void,
): void {
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(rows.map((c) => [c.id, c])),
    activeChannelId: null,
    roles: [],
  }));
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(
    el,
    target,
    ac.signal,
    ac.signal,
    undefined,
    undefined,
    undefined,
    rows,
    onReorder,
  );
  contextMenuAt4(el);
}

describe("channel context menu - Move Up / Move Down", () => {
  it("emits entries that carry each channel's previous position", () => {
    const rows = [channel(1, 0), channel(2, 3), channel(3, 6)];
    const onReorder = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
    openMove(rows, rows[1]!, onReorder);

    (document.querySelector('[data-testid="ctx-move-up"]') as HTMLElement).click();

    expect(onReorder).toHaveBeenCalledWith([
      { channelId: 2, newPosition: 0, previousPosition: 3 },
      { channelId: 1, newPosition: 3, previousPosition: 0 },
    ]);
    expect(channelsStore.getState().channels.get(2)?.position).toBe(0);
  });

  it("records the pre-nudge position when tied positions are nudged apart", () => {
    const rows = [channel(1, 0), channel(2, 0)];
    const onReorder = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
    openMove(rows, rows[0]!, onReorder);

    (document.querySelector('[data-testid="ctx-move-down"]') as HTMLElement).click();

    expect(onReorder).toHaveBeenCalledWith([
      { channelId: 1, newPosition: 1, previousPosition: 0 },
      { channelId: 2, newPosition: 0, previousPosition: 0 },
    ]);
  });
});

describe("channel context menu - injected access", () => {
  const ids = [
    "ctx-edit-channel",
    "ctx-delete-channel",
    "ctx-move-up",
    "ctx-move-down",
    "ctx-invite-people",
  ] as const;

  /** Open a menu for a row whose caller-supplied access differs from the store's. */
  function openWith(role: string, access: ChannelAccess | undefined): Set<string> {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "tester", avatar: null, role },
    }));
    const rows = [channel(1, 0), channel(2, 1)];
    channelsStore.setState(() => ({
      categories: [],
      channels: new Map(rows.map((c) => [c.id, c])),
      activeChannelId: null,
      roles: [],
    }));
    const el = document.createElement("div");
    container.appendChild(el);
    attachChannelContextMenu(
      el,
      rows[0]!,
      ac.signal,
      ac.signal,
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
      rows,
      vi.fn(),
      vi.fn(),
      access,
    );
    contextMenuAt4(el);
    const shown = new Set<string>();
    for (const id of ids) {
      if (document.querySelector(`[data-testid="${id}"]`) !== null) shown.add(id);
    }
    if (document.querySelector('[data-testid="ctx-purge-messages"]') !== null) shown.add("purge");
    return shown;
  }

  it("injected access decides Edit, Delete, Move, Purge and Invite", () => {
    // The store's role is a plain member, so without access nothing is offered.
    const bare = openWith("member", undefined);
    expect(bare.has("ctx-edit-channel")).toBe(false);
    expect(bare.has("purge")).toBe(false);
    document.querySelectorAll(".channel-ctx-menu").forEach((m) => m.remove());

    const granted = openWith("member", {
      manageChannels: true,
      manageMessages: true,
      manageInvites: true,
    });
    for (const id of ids) expect(granted.has(id), id).toBe(true);
    expect(granted.has("purge")).toBe(true);
    document.querySelectorAll(".channel-ctx-menu").forEach((m) => m.remove());

    // The store's role is the owner, so without access everything is offered;
    // the injected denial wins.
    const denied = openWith("owner", {
      manageChannels: false,
      manageMessages: false,
      manageInvites: false,
    });
    for (const id of ids) expect(denied.has(id), id).toBe(false);
    expect(denied.has("purge")).toBe(false);
  });
});

describe("channel context menu - Developer Mode Copy Channel ID", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => setDeveloperMode(false));

  function open(target: Channel): void {
    const el = document.createElement("div");
    container.appendChild(el);
    attachChannelContextMenu(el, target, ac.signal, ac.signal);
    contextMenuAt4(el);
  }
  const item = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid="ctx-copy-channel-id"]');

  it("offers the item when Developer Mode is on and copies the id", () => {
    setDeveloperMode(true);
    open(channel(42, 0));
    expect(item()?.textContent).toBe("Copy Channel ID");
    item()!.click();
    expect(writeText).toHaveBeenCalledWith("42");
  });

  it("leaves it out when Developer Mode is off", () => {
    setDeveloperMode(false);
    open(channel(42, 0));
    expect(item()).toBeNull();
  });

  it("a voice channel's menu holds only Open chat for a non-manager, plus Copy Channel ID in Developer Mode", () => {
    authStore.setState((s) => ({
      ...s,
      user: { id: 1, username: "t", avatar: null, role: "member" },
    }));
    const voice = { ...channel(7, 0), type: "voice" as const };
    open(voice);
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
    expect(item()).toBeNull();
    expect(document.querySelectorAll(".channel-ctx-menu .context-menu-item")).toHaveLength(1);
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    setDeveloperMode(true);
    open(voice);
    expect(item()).not.toBeNull();
  });

  it("opens the menu from Shift+F10 and the Menu key on a voice row (Open chat)", () => {
    authStore.setState((s) => ({
      ...s,
      user: { id: 1, username: "t", avatar: null, role: "member" },
    }));
    setDeveloperMode(false);
    const el = document.createElement("div");
    container.appendChild(el);
    attachChannelContextMenu(
      el,
      { ...channel(7, 0), type: "voice" as const },
      ac.signal,
      ac.signal,
    );
    const key = new KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-testid="ctx-open-chat"]')).not.toBeNull();
    expect(item()).toBeNull();
  });
});
