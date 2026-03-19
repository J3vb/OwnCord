import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import {
  channelsStore,
  setChannels,
  setActiveChannel,
} from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore, toggleCategory } from "../../src/stores/ui.store";
import { voiceStore, updateVoiceState } from "../../src/stores/voice.store";
import { membersStore } from "../../src/stores/members.store";
import type { ReadyChannel } from "../../src/lib/types";

function resetStores(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
  }));
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: "Test Server",
    motd: null,
    isAuthenticated: false,
  }));
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    transientError: null,
    persistentError: null,
    collapsedCategories: new Set<string>(),
  }));
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

const testChannels: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 2,
    last_message_id: 100,
  },
  {
    id: 2,
    name: "random",
    type: "text",
    category: "Text Channels",
    position: 1,
    unread_count: 0,
    last_message_id: 50,
  },
  {
    id: 3,
    name: "voice-lobby",
    type: "voice",
    category: "Voice Channels",
    position: 0,
  },
  {
    id: 4,
    name: "announcements",
    type: "announcement",
    category: "Info",
    position: 0,
    unread_count: 5,
    last_message_id: 200,
  },
];

describe("ChannelSidebar", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: ReturnType<typeof vi.fn>;
  let onVoiceLeave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn();
    onVoiceLeave = vi.fn();
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
  });

  it("renders channel list from store", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const items = container.querySelectorAll(".channel-item");
    expect(items.length).toBe(4);

    const names = Array.from(
      container.querySelectorAll(".ch-name"),
    ).map((el) => el.textContent);
    expect(names).toContain("general");
    expect(names).toContain("random");
    expect(names).toContain("voice-lobby");
    expect(names).toContain("announcements");
  });

  it("groups channels by category", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const categories = container.querySelectorAll(".category");
    const categoryNames = Array.from(categories).map(
      (el) => el.querySelector(".category-name")?.textContent,
    );

    expect(categoryNames).toContain("Text Channels");
    expect(categoryNames).toContain("Voice Channels");
    expect(categoryNames).toContain("Info");
  });

  it("click channel sets active and clears unread", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Channel 1 (general) has unread_count of 2
    const ch1Before = channelsStore.getState().channels.get(1);
    expect(ch1Before?.unreadCount).toBe(2);

    const firstItem = container.querySelector(
      '[data-channel-id="1"]',
    ) as HTMLElement;
    expect(firstItem).not.toBeNull();
    firstItem.click();

    const state = channelsStore.getState();
    expect(state.activeChannelId).toBe(1);
    expect(state.channels.get(1)?.unreadCount).toBe(0);
  });

  it("category collapse toggles visibility", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Text Channels category should have 2 channels visible
    const textChannelsBefore = container.querySelectorAll(
      '.channel-item',
    );
    expect(textChannelsBefore.length).toBe(4);

    // Click the "Text Channels" category header to collapse
    const headers = container.querySelectorAll(".category");
    const textHeader = Array.from(headers).find(
      (h) => h.querySelector(".category-name")?.textContent === "Text Channels",
    ) as HTMLElement;
    expect(textHeader).not.toBeUndefined();
    textHeader.click();
    uiStore.flush();

    // After collapse, "Text Channels" channels should be hidden
    // The sidebar re-renders on uiStore change, so channels under
    // collapsed category are not in the DOM
    const itemsAfter = container.querySelectorAll(".channel-item");
    expect(itemsAfter.length).toBe(2); // only Voice + Info channels remain

    // Expand again
    const headersAfter = container.querySelectorAll(".category");
    const textHeaderAfter = Array.from(headersAfter).find(
      (h) => h.querySelector(".category-name")?.textContent === "Text Channels",
    ) as HTMLElement;
    textHeaderAfter.click();
    uiStore.flush();

    const itemsExpanded = container.querySelectorAll(".channel-item");
    expect(itemsExpanded.length).toBe(4);
  });

  it("displays server name from auth store", () => {
    sidebar.mount(container);

    const serverName = container.querySelector(".channel-sidebar-header h2");
    expect(serverName?.textContent).toBe("Test Server");
  });

  it("shows unread badge for channels with unread messages", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const badges = container.querySelectorAll(".unread-badge");
    expect(badges.length).toBe(2); // general (2) and announcements (5)

    const badgeTexts = Array.from(badges).map((b) => b.textContent);
    expect(badgeTexts).toContain("2");
    expect(badgeTexts).toContain("5");
  });

  it("marks active channel with active class", () => {
    setChannels(testChannels);
    setActiveChannel(2);
    sidebar.mount(container);

    const activeItem = container.querySelector(
      '[data-channel-id="2"]',
    );
    expect(activeItem?.classList.contains("active")).toBe(true);
  });

  it("shows voice icon for voice channels", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const voiceItem = container.querySelector(
      '[data-channel-id="3"]',
    );
    const icon = voiceItem?.querySelector(".ch-icon");
    expect(icon).not.toBeNull();
  });

  it("clicking voice channel calls onVoiceJoin instead of setActiveChannel", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const voiceItem = container.querySelector(
      '[data-channel-id="3"]',
    ) as HTMLElement;
    voiceItem.click();

    // Should NOT set active channel
    expect(channelsStore.getState().activeChannelId).toBeNull();
    // Should call onVoiceJoin with channel id
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("clicking text channel still sets active channel normally", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const textItem = container.querySelector(
      '[data-channel-id="1"]',
    ) as HTMLElement;
    textItem.click();

    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("clicking joined voice channel calls onVoiceLeave", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const voiceItem = container.querySelector(
      '[data-channel-id="3"]',
    ) as HTMLElement;
    voiceItem.click();

    expect(onVoiceLeave).toHaveBeenCalled();
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("shows connected voice users under voice channel", () => {
    setChannels(testChannels);
    // Add a member so username resolves
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([[10, { id: 10, username: "Alice", avatar: null, role: "member", status: "online" as const }]]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 10,
      username: "Alice",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const voiceUsersList = container.querySelector(".voice-users-list");
    expect(voiceUsersList).not.toBeNull();

    const userItems = container.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(1);

    const userName = userItems[0]?.querySelector(".vu-name");
    expect(userName?.textContent).toBe("Alice");
  });

  it("highlights voice channel as active when user is joined", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const voiceItem = container.querySelector(
      '[data-channel-id="3"]',
    );
    expect(voiceItem?.classList.contains("active")).toBe(true);
  });

  it("re-renders when voice store changes", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Initially no voice users
    let voiceUsers = container.querySelectorAll(".voice-user-item");
    expect(voiceUsers.length).toBe(0);

    // Add a voice user
    updateVoiceState({
      channel_id: 3,
      user_id: 20,
      username: "Bob",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    voiceUsers = container.querySelectorAll(".voice-user-item");
    expect(voiceUsers.length).toBe(1);

    // Should show muted icon
    const mutedIcon = voiceUsers[0]?.querySelector(".vu-muted");
    expect(mutedIcon).not.toBeNull();
  });
});
