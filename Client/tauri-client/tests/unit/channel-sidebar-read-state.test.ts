/**
 * Explicit mark-as-read affordances in the channel sidebar: the per-channel
 * "Mark as Read" context-menu entry and the server-header "Mark All as Read".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({ rePinPeerIdentity: vi.fn() }));
vi.mock("@lib/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { membersStore } from "../../src/stores/members.store";
import { setMarkReadSender } from "@lib/read-state";
import type { ReadyChannel } from "../../src/lib/types";

const CHANNELS: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 3,
    mention_count: 1,
  },
  { id: 2, name: "random", type: "text", category: "Text Channels", position: 1, unread_count: 0 },
  { id: 3, name: "lobby", type: "voice", category: "Voice Channels", position: 0 },
];

describe("ChannelSidebar — mark as read", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let sent: number[];

  beforeEach(() => {
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
    dmStore.setState(() => ({ channels: [] }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
    voiceStore.setState((prev) => ({ ...prev, voiceStates: new Map() }));
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));

    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onVoiceLeave: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    setMarkReadSender(null);
  });

  function openCtxMenu(channelId: number): HTMLElement | null {
    const el = container.querySelector(`[data-channel-id="${channelId}"]`) as HTMLElement;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    return document.querySelector('[data-testid="channel-context-menu"]');
  }

  it("marks a channel read from the context menu without activating it", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const menu = openCtxMenu(1);
    const item = menu?.querySelector('[data-testid="ctx-mark-read"]') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.classList.contains("disabled")).toBe(false);

    item.click();

    expect(sent).toEqual([1]);
    const ch = channelsStore.getState().channels.get(1);
    expect(ch?.unreadCount).toBe(0);
    expect(ch?.mentionCount).toBe(0);
    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("disables Mark as Read for a channel with nothing unread", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const menu = openCtxMenu(2);
    const item = menu?.querySelector('[data-testid="ctx-mark-read"]') as HTMLElement;
    expect(item.classList.contains("disabled")).toBe(true);

    item.click();
    expect(sent).toEqual([]);
  });

  it("omits Mark as Read for a voice channel, which holds no messages", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    const el = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    const menu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(menu?.querySelector('[data-testid="ctx-mark-read"]') ?? null).toBeNull();
  });
});

describe("ChannelSidebar — mark all as read", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let sent: number[];

  beforeEach(() => {
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
    dmStore.setState(() => ({ channels: [] }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
    voiceStore.setState((prev) => ({ ...prev, voiceStates: new Map() }));
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onVoiceLeave: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    setMarkReadSender(null);
  });

  function button(): HTMLElement {
    return container.querySelector('[data-testid="mark-all-read"]') as HTMLElement;
  }

  it("hides the button while nothing is unread", () => {
    setChannels([CHANNELS[1]!]);
    sidebar.mount(container);

    expect(button()).not.toBeNull();
    expect(button().classList.contains("visible")).toBe(false);
  });

  it("shows the button once a channel goes unread", () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    expect(button().classList.contains("visible")).toBe(true);
  });

  it("shows the button for a DM-only unread, whose badge lives in dm.store", async () => {
    setChannels([CHANNELS[1]!]);
    sidebar.mount(container);
    expect(button().classList.contains("visible")).toBe(false);

    dmStore.setState(() => ({
      channels: [
        {
          channelId: 50,
          recipient: { id: 9, username: "alice", avatar: "", status: "online" },
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 2,
          mentionCount: 0,
        },
      ],
    }));

    // Store notifications are batched on a microtask.
    await vi.waitFor(() => {
      expect(button().classList.contains("visible")).toBe(true);
    });
  });

  it("clears every badge and hides itself when clicked", async () => {
    setChannels(CHANNELS);
    sidebar.mount(container);

    button().click();

    expect(sent).toEqual([1]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    await vi.waitFor(() => {
      expect(button().classList.contains("visible")).toBe(false);
    });
  });
});
