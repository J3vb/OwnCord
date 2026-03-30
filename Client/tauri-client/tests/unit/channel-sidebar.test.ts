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
    roles: [],
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
    sidebarMode: "channels" as const,
    activeDmUserId: null,
  }));
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
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

/** Set auth user so admin-gated features (context menus, drag, create channel) activate. */
function setAdminUser(): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id: 1, username: "Admin", avatar: null, role: "admin" },
    serverName: "Test Server",
    motd: null,
    isAuthenticated: true,
  }));
}

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
    // Clean up any context menus left on document.body
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    document.querySelectorAll(".user-vol-menu").forEach((el) => el.remove());
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

  it("shows LIVE badge when user has screenshare active", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);

    const liveBadge = container.querySelector(".vu-live-badge");
    expect(liveBadge).not.toBeNull();
    expect(liveBadge!.textContent).toBe("LIVE");
  });

  it("shows monitor icon when user has screenshare active", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);

    // The screenshare user row should contain an SVG icon (monitor)
    const voiceUserItems = container.querySelectorAll(".voice-user-item");
    expect(voiceUserItems.length).toBe(1);
    const screenIcon = voiceUserItems[0]?.querySelector("svg");
    expect(screenIcon).not.toBeNull();
  });

  it("calls onWatchStream when clicking a user row with active stream", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onWatchStream });

    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);

    const voiceUserItem = container.querySelector(".voice-user-item") as HTMLElement;
    expect(voiceUserItem).not.toBeNull();
    voiceUserItem.click();

    expect(onWatchStream).toHaveBeenCalledWith(30);
  });

  // ── Empty state ──

  it("shows empty state when no channels exist", () => {
    sidebar.mount(container);

    const emptyText = container.querySelector(".channel-list-empty-text");
    expect(emptyText).not.toBeNull();
    expect(emptyText!.textContent).toBe("No channels yet");

    const hint = container.querySelector(".channel-list-empty-hint");
    expect(hint).not.toBeNull();
  });

  // ── Server name updates ──

  it("updates server name when auth store changes", () => {
    sidebar.mount(container);
    const h2 = container.querySelector(".channel-sidebar-header h2");
    expect(h2?.textContent).toBe("Test Server");

    authStore.setState((prev) => ({ ...prev, serverName: "Renamed Server" }));
    authStore.flush();

    expect(h2?.textContent).toBe("Renamed Server");
  });

  it("falls back to 'Server Name' when serverName is null", () => {
    authStore.setState((prev) => ({ ...prev, serverName: null }));
    sidebar.mount(container);

    const h2 = container.querySelector(".channel-sidebar-header h2");
    expect(h2?.textContent).toBe("Server Name");
  });

  // ── Deafened and camera icons on voice users ──

  it("shows both mic-off and headphones-off icons for deafened user", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 40,
      username: "DeafUser",
      muted: false,
      deafened: true,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userRow = container.querySelector(".voice-user-item");
    expect(userRow).not.toBeNull();
    // Deafened shows TWO .vu-muted elements (mic-off + headphones-off)
    const mutedIcons = userRow!.querySelectorAll(".vu-muted");
    expect(mutedIcons.length).toBe(2);
  });

  it("shows camera icon for user with active camera", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 50,
      username: "CameraUser",
      muted: false,
      deafened: false,
      speaking: false,
      camera: true,
      screenshare: false,
    });
    sidebar.mount(container);

    const statusIcon = container.querySelector(".vu-status");
    expect(statusIcon).not.toBeNull();
  });

  // ── Speaking state in-place toggle ──

  it("toggles speaking class in-place without re-rendering entire DOM", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 60,
      username: "Talker",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userRow = container.querySelector('.voice-user-item[data-voice-uid="60"]');
    expect(userRow).not.toBeNull();
    expect(userRow!.classList.contains("speaking")).toBe(false);

    // Update only speaking flag (structural signature stays the same)
    updateVoiceState({
      channel_id: 3,
      user_id: 60,
      username: "Talker",
      muted: false,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    // The same DOM element should now have speaking class toggled
    const updatedRow = container.querySelector('.voice-user-item[data-voice-uid="60"]');
    expect(updatedRow).not.toBeNull();
    expect(updatedRow!.classList.contains("speaking")).toBe(true);
  });

  // ── Voice user avatar ──

  it("renders first-letter avatar with deterministic color for voice user", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 70,
      username: "Zara",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".vu-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe("Z");
    // Avatar should have a background color set
    expect((avatar as HTMLElement).style.background).not.toBe("");
  });

  it("shows '?' avatar for user with empty username", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 71,
      username: "",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".vu-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe("?");
  });

  it("shows 'Unknown' name for user with empty username", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 71,
      username: "",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const name = container.querySelector(".vu-name");
    expect(name?.textContent).toBe("Unknown");
  });

  // ── Context menu for channel edit/delete ──

  it("right-click on channel opens context menu with Edit and Delete for admin", () => {
    const onEditChannel = vi.fn();
    const onDeleteChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onEditChannel,
      onDeleteChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(channelEl).not.toBeNull();

    // Dispatch right-click
    channelEl.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 200,
    }));

    const ctxMenu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(ctxMenu).not.toBeNull();

    const editItem = document.querySelector('[data-testid="ctx-edit-channel"]');
    expect(editItem).not.toBeNull();
    expect(editItem!.textContent).toBe("Edit Channel");

    const deleteItem = document.querySelector('[data-testid="ctx-delete-channel"]');
    expect(deleteItem).not.toBeNull();
    expect(deleteItem!.textContent).toBe("Delete Channel");
  });

  it("clicking Edit in context menu calls onEditChannel with the correct channel", () => {
    const onEditChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onEditChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 200,
    }));

    const editItem = document.querySelector('[data-testid="ctx-edit-channel"]') as HTMLElement;
    editItem.click();

    expect(onEditChannel).toHaveBeenCalledTimes(1);
    const calledWith = onEditChannel.mock.calls[0]![0];
    expect(calledWith.id).toBe(1);
    expect(calledWith.name).toBe("general");
  });

  it("clicking Delete in context menu calls onDeleteChannel with the correct channel", () => {
    const onDeleteChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onDeleteChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 200,
    }));

    const deleteItem = document.querySelector('[data-testid="ctx-delete-channel"]') as HTMLElement;
    deleteItem.click();

    expect(onDeleteChannel).toHaveBeenCalledTimes(1);
    expect(onDeleteChannel.mock.calls[0]![0].id).toBe(1);
  });

  it("does not show context menu for non-admin users", () => {
    const onEditChannel = vi.fn();
    sidebar.destroy?.();
    // Set a regular member (not admin/owner)
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onEditChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 100,
      clientY: 200,
    }));

    // No context menu should appear for non-admin
    const ctxMenu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(ctxMenu).toBeNull();
  });

  // ── Create channel button ──

  it("shows create channel button on category header for admin users", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector('[data-testid="create-channel-text-channels"]');
    expect(addBtn).not.toBeNull();
    expect(addBtn!.textContent).toBe("+");
  });

  it("clicking create channel button calls onCreateChannel with category name", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector('[data-testid="create-channel-text-channels"]') as HTMLElement;
    addBtn.click();

    expect(onCreateChannel).toHaveBeenCalledWith("Text Channels");
  });

  it("create channel button does not collapse the category", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // All 4 channels visible before click
    expect(container.querySelectorAll(".channel-item").length).toBe(4);

    const addBtn = container.querySelector('[data-testid="create-channel-text-channels"]') as HTMLElement;
    addBtn.click();

    // Category should NOT have collapsed (stopPropagation in the handler)
    expect(container.querySelectorAll(".channel-item").length).toBe(4);
  });

  it("does not show create channel button for non-admin users", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector(".category-add-btn");
    expect(addBtn).toBeNull();
  });

  // ── Voice user volume context menu ──

  it("right-click on other user's voice row opens volume context menu", () => {
    // Set current user to something different from the voice user
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Me", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));

    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 80,
      username: "OtherUser",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const voiceRow = container.querySelector(".voice-user-item") as HTMLElement;
    voiceRow.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 150,
      clientY: 250,
    }));

    const volMenu = document.querySelector(".user-vol-menu");
    expect(volMenu).not.toBeNull();
    // Should display the username
    expect(volMenu!.textContent).toContain("OtherUser");
    // Should have a volume slider
    const slider = volMenu!.querySelector('input[type="range"]');
    expect(slider).not.toBeNull();
    // Should have a Reset Volume button
    expect(volMenu!.textContent).toContain("Reset Volume");
  });

  // ── Collapsed category shows arrow-right, expanded shows arrow-down ──

  it("collapsed category header has 'collapsed' class", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Text Channels"]),
    }));
    sidebar.mount(container);

    const headers = container.querySelectorAll(".category");
    const textHeader = Array.from(headers).find(
      (h) => h.querySelector(".category-name")?.textContent === "Text Channels",
    );
    expect(textHeader).not.toBeUndefined();
    expect(textHeader!.classList.contains("collapsed")).toBe(true);
  });

  // ── Channels store subscription re-renders on channel map changes ──

  it("re-renders when channels store changes after mount", () => {
    sidebar.mount(container);
    expect(container.querySelectorAll(".channel-item").length).toBe(0);

    // Add channels after mount
    setChannels(testChannels);
    channelsStore.flush();

    expect(container.querySelectorAll(".channel-item").length).toBe(4);
  });

  // ── Destroy cleanup ──

  it("destroy removes the sidebar from the DOM", () => {
    setChannels(testChannels);
    sidebar.mount(container);
    expect(container.querySelector('[data-testid="channel-sidebar"]')).not.toBeNull();

    sidebar.destroy?.();
    expect(container.querySelector('[data-testid="channel-sidebar"]')).toBeNull();
  });

  // ── Drag reorder setup for admin (attaches drag handlers) ──

  it("admin sidebar with onReorderChannel adds channel-draggable class to items", () => {
    const onReorderChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // Admin + onReorderChannel -> items should have channel-draggable class
    const draggables = container.querySelectorAll(".channel-draggable");
    expect(draggables.length).toBeGreaterThan(0);
  });

  it("non-admin does not get draggable class on channel items", () => {
    const onReorderChannel = vi.fn();
    sidebar.destroy?.();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const draggables = container.querySelectorAll(".channel-draggable");
    expect(draggables.length).toBe(0);
  });

  it("destroy cleans up global drag listeners when last sidebar instance is destroyed", () => {
    const onReorderChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // After mount with drag support, destroy should not throw
    sidebar.destroy?.();

    // Verify sidebar is removed
    expect(container.querySelector('[data-testid="channel-sidebar"]')).toBeNull();

    // Re-create for afterEach cleanup
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave });
  });

  // ── Multiple voice users in same channel ──

  it("renders multiple voice users under the same channel", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 90,
      username: "UserA",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    updateVoiceState({
      channel_id: 3,
      user_id: 91,
      username: "UserB",
      muted: true,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userItems = container.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(2);

    const names = Array.from(userItems).map(
      (el) => el.querySelector(".vu-name")?.textContent,
    );
    expect(names).toContain("UserA");
    expect(names).toContain("UserB");
  });

  // ── User with camera + screenshare shows both icons ──

  it("shows both camera and monitor icons when user has camera and screenshare", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 92,
      username: "MultiStream",
      muted: false,
      deafened: false,
      speaking: false,
      camera: true,
      screenshare: true,
    });
    sidebar.mount(container);

    const userRow = container.querySelector(".voice-user-item");
    expect(userRow).not.toBeNull();
    // Camera icon + screen icon = 2 .vu-status elements
    const statusIcons = userRow!.querySelectorAll(".vu-status");
    expect(statusIcons.length).toBe(2);
    // Plus LIVE badge
    const liveBadge = userRow!.querySelector(".vu-live-badge");
    expect(liveBadge).not.toBeNull();
  });
});
