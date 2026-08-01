import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  attachChannelContextMenu,
  CHANNEL_MUTE_CHANGED,
} from "@components/channel-sidebar/context-menu";
import { buildNotificationsTab } from "@components/settings/NotificationsTab";
import { isChannelMuted, muteChannel, invalidateMuteCache } from "@lib/channel-mutes";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import type { Channel } from "@stores/channels.store";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 5,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    topic: "",
    nsfw: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...overrides,
  };
}

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  localStorage.clear();
  invalidateMuteCache();
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
});

function openMenu(ch: Channel): HTMLElement {
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(el, ch, ac.signal);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
  return el;
}

describe("channel context menu — mute", () => {
  it("offers Mute Channel for a text channel", () => {
    openMenu(channel());
    const item = document.querySelector('[data-testid="ctx-mute-channel"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toBe("Mute Channel");
  });

  it("says Unmute Channel when already muted", () => {
    muteChannel(5);
    openMenu(channel());
    expect(document.querySelector('[data-testid="ctx-mute-channel"]')!.textContent).toBe(
      "Unmute Channel",
    );
  });

  it("toggles the mute on click", () => {
    openMenu(channel());
    (document.querySelector('[data-testid="ctx-mute-channel"]') as HTMLElement).click();
    expect(isChannelMuted(5)).toBe(true);
  });

  it("bubbles a mute-changed event so the sidebar can redraw", () => {
    const el = openMenu(channel());
    const seen: number[] = [];
    el.addEventListener(CHANNEL_MUTE_CHANGED, (e) => {
      seen.push((e as CustomEvent<{ channelId: number }>).detail.channelId);
    });

    (document.querySelector('[data-testid="ctx-mute-channel"]') as HTMLElement).click();
    expect(seen).toEqual([5]);
  });

  // A voice channel produces no notifications, so a mute there would be an
  // affordance that cannot do anything.
  it("does not offer Mute for a voice channel", () => {
    openMenu(channel({ id: 6, type: "voice" }));
    expect(document.querySelector('[data-testid="ctx-mute-channel"]')).toBeNull();
  });

  it("offers Mute for a DM channel", () => {
    openMenu(channel({ id: 7, type: "dm" }));
    expect(document.querySelector('[data-testid="ctx-mute-channel"]')).not.toBeNull();
  });
});

describe("NotificationsTab — muted channel list", () => {
  it("says nothing is muted when nothing is", () => {
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-empty"]')).not.toBeNull();
  });

  it("names a muted guild channel with a hash", () => {
    channelsStore.setState((prev) => {
      const next = new Map(prev.channels);
      next.set(5, channel({ id: 5, name: "general" }));
      return { ...prev, channels: next };
    });
    muteChannel(5);

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-channel-list"]')!.textContent).toContain(
      "#general",
    );
  });

  it("names a muted DM with an at-sign and its display name", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 9,
          recipient: { id: 2, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 2, username: "bob", avatar: "", status: "online" }],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    muteChannel(9);

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-channel-list"]')!.textContent).toContain("@bob");
  });

  // A mute can outlive the channel it names (deleted channel, left group). It
  // is still listed, because otherwise there is no way to clear it.
  it("still lists a mute for a channel it cannot name", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    dmStore.setState(() => ({ channels: [] }));
    muteChannel(4242);

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-channel-list"]')!.textContent).toContain(
      "Channel 4242",
    );
  });

  it("unmutes from the list and removes the row", () => {
    muteChannel(5);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);

    (tab.querySelector('[data-testid="unmute-5"]') as HTMLElement).click();
    expect(isChannelMuted(5)).toBe(false);
    expect(tab.querySelector('[data-testid="unmute-5"]')).toBeNull();
    expect(tab.querySelector('[data-testid="muted-empty"]')).not.toBeNull();
  });

  it("lists several mutes in ascending order", () => {
    muteChannel(9);
    muteChannel(2);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);

    const rows = [...tab.querySelectorAll(".settings-muted-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Channel 2");
    expect(rows[1]!.textContent).toContain("Channel 9");
  });
});
