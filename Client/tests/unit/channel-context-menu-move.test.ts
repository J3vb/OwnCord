import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachChannelContextMenu } from "@components/channel-sidebar/context-menu";
import type { ChannelReorderData } from "@components/ChannelSidebar";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { setDeveloperMode } from "../helpers/message-actions-fixtures";
import type { Channel } from "@stores/channels.store";

function channel(id: number, position: number): Channel {
  return {
    id,
    name: `ch-${id}`,
    type: "text",
    category: null,
    position,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    topic: "",
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "tester", avatar: null, role: "owner" },
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
});

function openMove(
  rows: readonly Channel[],
  target: Channel,
  onReorder: (reorders: readonly ChannelReorderData[]) => void,
): void {
  channelsStore.setState(() => ({
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
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
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
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
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

  it("opens a menu on a voice channel for a non-manager only in Developer Mode", () => {
    authStore.setState((s) => ({
      ...s,
      user: { id: 1, username: "t", avatar: null, role: "member" },
    }));
    const voice = { ...channel(7, 0), type: "voice" as const };
    open(voice);
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();
    setDeveloperMode(true);
    open(voice);
    expect(item()).not.toBeNull();
  });

  it("leaves Shift+F10 and the Menu key alone on a row with no menu", () => {
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
    const keys = [
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
    ];
    for (const key of keys) el.dispatchEvent(key);
    expect(keys.map((k) => k.defaultPrevented)).toEqual([false, false]);
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();

    setDeveloperMode(true);
    const again = new KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(true);
    expect(item()).not.toBeNull();
  });
});
