import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock livekitSession (required by streamPreview). rePinPeerIdentity is hoisted
// so the mock factory can reference it and tests can assert re-pin was invoked.
const { mockRePinPeerIdentity } = vi.hoisted(() => ({
  mockRePinPeerIdentity: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@lib/livekitSession", () => ({
  setUserVolume: vi.fn(),
  getUserVolume: vi.fn(() => 1),
  getRemoteVideoStream: vi.fn(() => null),
  rePinPeerIdentity: mockRePinPeerIdentity,
}));

// Mock streamPreview to isolate sidebar tests from preview DOM logic
const mockAttachStreamPreview = vi.fn();
const mockAttachScrollCollapse = vi.fn();
vi.mock("@lib/streamPreview", () => ({
  attachStreamPreview: (...args: unknown[]) => mockAttachStreamPreview(...args),
  attachScrollCollapse: (...args: unknown[]) => mockAttachScrollCollapse(...args),
}));

// Stub the identity-key crypto so the mismatch modal's fingerprint compute is
// deterministic in jsdom (real WebCrypto key import needs a valid SPKI blob).
vi.mock("@lib/e2eeCrypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/e2eeCrypto")>();
  return {
    ...actual,
    importIdentityPublicKey: vi.fn(() => Promise.resolve({} as CryptoKey)),
    computeKeyFingerprint: vi.fn(() => Promise.resolve("FEED FACE 1234 5678")),
  };
});

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import {
  channelsStore,
  setChannels,
  setActiveChannel,
  setRoles,
  type Channel,
} from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore, toggleCategory } from "../../src/stores/ui.store";
import { voiceStore, updateVoiceState } from "../../src/stores/voice.store";
import type { PeerVerification } from "../../src/stores/voice.store";
import { membersStore } from "../../src/stores/members.store";
import { Permission, type ReadyChannel, type VoiceStatePayload } from "../../src/lib/types";
import { computeKeyFingerprint } from "@lib/e2eeCrypto";

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
    // Default to a live socket: the voice join/leave affordance is only usable
    // when connected. Frozen-state behavior is exercised explicitly below.
    connectionStatus: "connected" as const,
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
    voiceStatus: "idle",
    peerVerifications: new Map(),
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

/** Add a connected voice user to a channel (via the same store path the WS uses). */
function addVoiceUser(channelId: number, userId: number, username: string): void {
  updateVoiceState({
    channel_id: channelId,
    user_id: userId,
    username,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  });
}

/** Record a peer's E2EE identity verification result in the voice store. */
function setPeerVerif(
  userId: number,
  status: PeerVerification["status"],
  safetyNumber: string | null = null,
): void {
  voiceStore.setState((prev) => {
    const peerVerifications = new Map(prev.peerVerifications ?? []);
    peerVerifications.set(userId, { userId, status, safetyNumber });
    return { ...prev, peerVerifications };
  });
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

/** Fresh spies for the four voice moderation callbacks. */
function voiceModCallbacks() {
  return {
    onServerMute: vi.fn(),
    onServerDeafen: vi.fn(),
    onMove: vi.fn(),
    onDisconnect: vi.fn(),
  };
}

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

    const names = Array.from(container.querySelectorAll(".ch-name")).map((el) => el.textContent);
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

  // Categories are free text: a voice channel groups under whatever it carries,
  // and shares a category with text channels rather than being pulled into a
  // hardcoded voice section.
  it("groups a voice channel under an arbitrary shared category", () => {
    setChannels([
      { id: 1, name: "chat", type: "text", category: "Gaming", position: 0 },
      { id: 2, name: "lounge", type: "voice", category: "Gaming", position: 1 },
    ]);
    sidebar.mount(container);

    const headers = Array.from(container.querySelectorAll(".category"));
    const names = headers.map((el) => el.querySelector(".category-name")?.textContent);
    expect(names).toEqual(["Gaming"]);

    const group = headers[0]?.parentElement;
    const rendered = Array.from(group?.querySelectorAll(".ch-name") ?? []).map(
      (el) => el.textContent,
    );
    expect(rendered).toEqual(["chat", "lounge"]);
  });

  it("puts only uncategorized voice channels in the fallback Voice group", () => {
    setChannels([
      { id: 1, name: "loose-text", type: "text", category: null, position: 0 },
      { id: 2, name: "loose-voice", type: "voice", category: null, position: 1 },
    ]);
    sidebar.mount(container);

    const names = Array.from(container.querySelectorAll(".category-name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Voice"]);

    // The uncategorized TEXT channel still renders, headerless.
    const allNames = Array.from(container.querySelectorAll(".ch-name")).map((el) => el.textContent);
    expect(allNames).toContain("loose-text");
    expect(allNames).toContain("loose-voice");
  });

  it("click channel sets active and clears unread", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Channel 1 (general) has unread_count of 2
    const ch1Before = channelsStore.getState().channels.get(1);
    expect(ch1Before?.unreadCount).toBe(2);

    const firstItem = container.querySelector('[data-channel-id="1"]') as HTMLElement;
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
    const textChannelsBefore = container.querySelectorAll(".channel-item");
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

  it("shows the red mention badge instead of the unread badge", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 2 }, testChannels[1]!]);
    sidebar.mount(container);

    const item = container.querySelector('[data-channel-id="1"]')!;
    expect(item.classList.contains("mentioned")).toBe(true);
    const mentionBadge = item.querySelector(".mention-badge");
    expect(mentionBadge?.textContent).toBe("2");
    // The mention badge wins outright — no double badge on one row.
    expect(item.querySelector(".unread-badge")).toBeNull();
  });

  it("falls back to the unread badge when there are no mentions", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 0 }]);
    sidebar.mount(container);

    const item = container.querySelector('[data-channel-id="1"]')!;
    expect(item.classList.contains("mentioned")).toBe(false);
    expect(item.querySelector(".mention-badge")).toBeNull();
    expect(item.querySelector(".unread-badge")?.textContent).toBe("7");
  });

  it("clears the mention badge when the channel is activated", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 2 }]);
    sidebar.mount(container);

    (container.querySelector('[data-channel-id="1"]') as HTMLElement).click();
    channelsStore.flush();

    expect(channelsStore.getState().channels.get(1)?.mentionCount).toBe(0);
    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(container.querySelector(".mention-badge")).toBeNull();
  });

  it("marks active channel with active class", () => {
    setChannels(testChannels);
    setActiveChannel(2);
    sidebar.mount(container);

    const activeItem = container.querySelector('[data-channel-id="2"]');
    expect(activeItem?.classList.contains("active")).toBe(true);
  });

  it("shows voice icon for voice channels", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]');
    const icon = voiceItem?.querySelector(".ch-icon");
    expect(icon).not.toBeNull();
  });

  it("clicking voice channel calls onVoiceJoin instead of setActiveChannel", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceItem.click();

    // Should NOT set active channel
    expect(channelsStore.getState().activeChannelId).toBeNull();
    // Should call onVoiceJoin with channel id
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("clicking text channel still sets active channel normally", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const textItem = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    textItem.click();

    expect(channelsStore.getState().activeChannelId).toBe(1);
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("clicking joined voice channel calls onVoiceLeave", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceItem.click();

    expect(onVoiceLeave).toHaveBeenCalled();
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  // ── Voice join/leave freeze while the WS socket is not connected (§3) ──

  it("disables voice channel join with a 'Reconnecting…' reason while reconnecting", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);
    expect(voiceItem.getAttribute("aria-disabled")).toBe("true");
    expect(voiceItem.title).toBe("Reconnecting…");

    // Frozen: the click must not fire the join callback.
    voiceItem.click();
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("disables voice channel join with a 'Not connected' reason while disconnected", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);
    expect(voiceItem.title).toBe("Not connected");

    voiceItem.click();
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("frozen voice channel does not fire onVoiceLeave even when joined", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);

    voiceItem.click();
    expect(onVoiceLeave).not.toHaveBeenCalled();
  });

  it("re-enables voice channel join when the connection returns to connected", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    // Initially frozen.
    let voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);

    // Connection restored — the sidebar re-renders and unfreezes the row.
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    uiStore.flush();

    voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(false);
    expect(voiceItem.hasAttribute("aria-disabled")).toBe(false);

    voiceItem.click();
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("shows connected voice users under voice channel", () => {
    setChannels(testChannels);
    // Add a member so username resolves
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          10,
          { id: 10, username: "Alice", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
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

    const voiceItem = container.querySelector('[data-channel-id="3"]');
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

    // User has screenshare: true, so tileId = userId + SCREENSHARE_TILE_ID_OFFSET
    expect(onWatchStream).toHaveBeenCalledWith(30 + 1_000_000);
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

  it("speaking patch keeps the exact row element (cached map, no rebuild)", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 61,
      username: "Talker2",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const rowBefore = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowBefore).not.toBeNull();

    // speaking-only flip → patched via the cached row map, not re-rendered
    updateVoiceState({
      channel_id: 3,
      user_id: 61,
      username: "Talker2",
      muted: false,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    const rowAfter = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowAfter).toBe(rowBefore); // same element instance
    expect(rowAfter!.classList.contains("speaking")).toBe(true);

    // …and a structural change (mute) still re-renders with a fresh row.
    updateVoiceState({
      channel_id: 3,
      user_id: 61,
      username: "Talker2",
      muted: true,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    const rowRebuilt = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowRebuilt).not.toBe(rowBefore);
    expect(rowRebuilt!.querySelector(".vu-muted")).not.toBeNull();
    // The rebuilt row keeps the speaking class (patch runs after re-render).
    expect(rowRebuilt!.classList.contains("speaking")).toBe(true);
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
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

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
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

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
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

    const deleteItem = document.querySelector('[data-testid="ctx-delete-channel"]') as HTMLElement;
    deleteItem.click();

    expect(onDeleteChannel).toHaveBeenCalledTimes(1);
    expect(onDeleteChannel.mock.calls[0]![0].id).toBe(1);
  });

  // Mark as Read is offered to everyone (it touches only the caller's own read
  // state), so a non-admin now gets a menu — just without the admin entries.
  it("shows only Mark as Read in the context menu for non-admin users", () => {
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
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

    const ctxMenu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(ctxMenu).not.toBeNull();
    expect(ctxMenu?.querySelector('[data-testid="ctx-mark-read"]')).not.toBeNull();
    expect(ctxMenu?.querySelector('[data-testid="ctx-edit-channel"]')).toBeNull();
    expect(ctxMenu?.querySelector('[data-testid="ctx-delete-channel"]')).toBeNull();
    expect(onEditChannel).not.toHaveBeenCalled();
  });

  // ── Purge messages context-menu item ──

  /** Right-click channel 1 and return the opened context menu. */
  function openChannelCtxMenu(): HTMLElement | null {
    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    return document.querySelector('[data-testid="channel-context-menu"]');
  }

  it("shows Purge Messages for a role holding MANAGE_MESSAGES", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_MESSAGES }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 3, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onPurgeChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    // A moderator is not owner/admin, so the menu exists only because of purge.
    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-edit-channel"]')).toBeNull();
  });

  it("hides Purge Messages for a role without MANAGE_MESSAGES", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onVoiceLeave,
      onEditChannel: vi.fn(),
      onPurgeChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
  });

  it("purge prompt clamps the count and calls onPurgeChannel with the channel", async () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onPurgeChannel });

    setChannels(testChannels);
    sidebar.mount(container);
    openChannelCtxMenu();

    const trigger = document.querySelector('[data-testid="ctx-purge-messages"]') as HTMLElement;
    trigger.click();

    const input = document.querySelector('[data-testid="purge-count-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "5000";
    (document.querySelector('[data-testid="purge-confirm"]') as HTMLElement).click();

    await vi.waitFor(() => {
      expect(onPurgeChannel).toHaveBeenCalledTimes(1);
    });
    expect(onPurgeChannel.mock.calls[0]![0]).toMatchObject({ id: 1, name: "general" });
    expect(onPurgeChannel.mock.calls[0]![1]).toBe(100);
  });

  it("does not offer purge on a voice channel", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onPurgeChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    const voiceEl = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));

    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
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

    const addBtn = container.querySelector(
      '[data-testid="create-channel-text-channels"]',
    ) as HTMLElement;
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

    const addBtn = container.querySelector(
      '[data-testid="create-channel-text-channels"]',
    ) as HTMLElement;
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

  // The button used to be gated on the role NAME, so a Moderator holding
  // MANAGE_CHANNELS — which the server now honors on /admin/api/channels — saw
  // no way to create one.
  it("shows create channel button for a role holding MANAGE_CHANNELS", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 3, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(container.querySelector(".category-add-btn")).not.toBeNull();
  });

  it("hides create channel button for a server role without MANAGE_CHANNELS", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    // A role the server DID send, holding no channel bit: the name fallback
    // must not apply, even for a role called "admin".
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.SEND_MESSAGES }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Admin", avatar: null, role: "admin" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(container.querySelector(".category-add-btn")).toBeNull();
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
    voiceRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 150,
        clientY: 250,
      }),
    );

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

  // ── Voice moderation context menu (MUTE_MEMBERS) ──

  /** Signs in as a user whose role holds exactly `permissions`, puts one other
   *  user in the voice channel, mounts the sidebar and right-clicks their row.
   *  Returns the open menu element (or null). */
  function openVoiceMenuAs(
    permissions: number,
    voiceUser: Partial<VoiceStatePayload> = {},
    onVoiceModerate?: Parameters<typeof createChannelSidebar>[0]["onVoiceModerate"],
    channels: ReadyChannel[] = testChannels,
  ): HTMLElement | null {
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onVoiceModerate });

    setChannels(channels);
    updateVoiceState({
      channel_id: 3,
      user_id: 80,
      username: "Target",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      ...voiceUser,
    });
    sidebar.mount(container);

    const voiceRow = container.querySelector(".voice-user-item") as HTMLElement;
    voiceRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    return document.querySelector(".user-vol-menu");
  }

  it("hides the moderation section for a role without MUTE_MEMBERS", () => {
    const menu = openVoiceMenuAs(Permission.MANAGE_CHANNELS, {}, voiceModCallbacks());
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    // The volume controls stay available to everyone.
    expect(menu!.textContent).toContain("Reset Volume");
  });

  it("hides the moderation section when the page wired no callbacks", () => {
    const menu = openVoiceMenuAs(Permission.MUTE_MEMBERS);
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
  });

  it("shows the moderation section for a role holding MUTE_MEMBERS", () => {
    const menu = openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, voiceModCallbacks());
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')!.textContent).toBe("Server Mute");
    expect(menu!.querySelector('[data-action="server-deafen"]')!.textContent).toBe("Server Deafen");
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).not.toBeNull();
  });

  it("shows the moderation section for an ADMINISTRATOR role", () => {
    const menu = openVoiceMenuAs(Permission.ADMINISTRATOR, {}, voiceModCallbacks());
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("labels the toggles by the target's current server-imposed state", () => {
    const menu = openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      { muted: true, deafened: true, server_muted: true, server_deafened: true },
      voiceModCallbacks(),
    );
    expect(menu!.querySelector('[data-action="server-mute"]')!.textContent).toBe("Server Unmute");
    expect(menu!.querySelector('[data-action="server-deafen"]')!.textContent).toBe(
      "Server Undeafen",
    );
  });

  it("sends server mute with the channel and target, and disconnect with the target", () => {
    const cb = voiceModCallbacks();
    const menu = openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);

    (menu!.querySelector('[data-action="server-mute"]') as HTMLElement).click();
    expect(cb.onServerMute).toHaveBeenCalledWith(3, 80, true);

    const menu2 = openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);
    (menu2!.querySelector('[data-action="voice-disconnect"]') as HTMLElement).click();
    expect(cb.onDisconnect).toHaveBeenCalledWith(80);
  });

  it("offers only the other voice channels as move targets", () => {
    const cb = voiceModCallbacks();
    const menu = openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);

    const moveItems = menu!.querySelectorAll("[data-move-channel]");
    // testChannels has one voice channel (id 3) — the one the target is in.
    expect(moveItems.length).toBe(0);

    const menu2 = openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb, [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ]);
    const moveItems2 = menu2!.querySelectorAll("[data-move-channel]");
    expect(moveItems2.length).toBe(1);
    expect((moveItems2[0] as HTMLElement).dataset.moveChannel).toBe("5");

    (moveItems2[0] as HTMLElement).click();
    expect(cb.onMove).toHaveBeenCalledWith(80, 5);
  });

  it("marks a server-muted participant distinctly from a self-muted one", () => {
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onVoiceLeave });
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 81,
      username: "Selfmuted",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);
    expect(container.querySelector(".vu-muted.vu-server-muted")).toBeNull();

    updateVoiceState({
      channel_id: 3,
      user_id: 81,
      username: "Selfmuted",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });
    voiceStore.flush();

    const icon = container.querySelector(".vu-muted.vu-server-muted") as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.title).toBe("Muted by a moderator");
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

    const names = Array.from(userItems).map((el) => el.querySelector(".vu-name")?.textContent);
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

  // T1: Screenshare click → offset tileId
  it("passes screenshare tile offset when clicking screensharing user", () => {
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onWatchStream });
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              99,
              {
                userId: 99,
                username: "Streamer",
                speaking: false,
                muted: false,
                deafened: false,
                camera: false,
                screenshare: true,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebarWithWatch.mount(container);

    const userRow = container.querySelector<HTMLElement>(".voice-user-item");
    expect(userRow).not.toBeNull();
    userRow!.click();

    expect(onWatchStream).toHaveBeenCalledWith(99 + 1_000_000);
    sidebarWithWatch.destroy?.();
  });

  // T2: Camera-only click → raw userId
  it("passes raw userId when clicking camera-only user", () => {
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onWatchStream });
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              99,
              {
                userId: 99,
                username: "Cammer",
                speaking: false,
                muted: false,
                deafened: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebarWithWatch.mount(container);

    const userRow = container.querySelector<HTMLElement>(".voice-user-item");
    expect(userRow).not.toBeNull();
    userRow!.click();

    expect(onWatchStream).toHaveBeenCalledWith(99);
    sidebarWithWatch.destroy?.();
  });

  // T12: Self-user → no preview attached
  it("does not attach stream preview for self user", () => {
    mockAttachStreamPreview.mockClear();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 42, username: "Me", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              42,
              {
                userId: 42,
                username: "Me",
                speaking: false,
                muted: false,
                deafened: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebar.mount(container);

    // Should not have called attachStreamPreview for self
    expect(mockAttachStreamPreview).not.toHaveBeenCalled();
  });

  // T20: Constant shared — sidebar uses SCREENSHARE_TILE_ID_OFFSET from constants
  it("uses shared SCREENSHARE_TILE_ID_OFFSET constant", async () => {
    // Verify the constant is imported and used by checking the offset value
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onVoiceLeave, onWatchStream });
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              1,
              {
                userId: 1,
                username: "User",
                speaking: false,
                muted: false,
                deafened: false,
                camera: false,
                screenshare: true,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebarWithWatch.mount(container);

    container.querySelector<HTMLElement>(".voice-user-item")?.click();
    // 1 + 1_000_000 = 1_000_001 — proves the shared constant is used
    expect(onWatchStream).toHaveBeenCalledWith(1_000_001);
    sidebarWithWatch.destroy?.();
  });

  // T14: attachScrollCollapse is called for voice users containers
  it("attaches scroll collapse to voice-users-list containers", () => {
    mockAttachScrollCollapse.mockClear();
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              99,
              {
                userId: 99,
                username: "User",
                speaking: false,
                muted: false,
                deafened: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebar.mount(container);

    expect(mockAttachScrollCollapse).toHaveBeenCalled();
  });
});

// ── E2EE identity verification badge on voice user rows (F3 TOFU) ──

describe("ChannelSidebar voice identity badge", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  const VOICE_CH = 3; // "voice-lobby" in testChannels

  beforeEach(() => {
    resetStores();
    setChannels(testChannels);
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onVoiceLeave: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
    mockRePinPeerIdentity.mockClear();
  });

  function badgeFor(userId: number): HTMLElement | null {
    return container.querySelector(`.voice-user-item[data-voice-uid="${userId}"] .vu-verify`);
  }

  it("shows a verified badge carrying the safety number in its title", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "verified", "AB12 CD34 EF56 7890");
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("verified")).toBe(true);
    expect(badge!.getAttribute("title")).toContain("AB12 CD34 EF56 7890");
  });

  it("shows an unverified badge for a legacy peer", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("unverified")).toBe(true);
  });

  it("shows a mismatch badge for a peer whose identity key changed", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("mismatch")).toBe(true);
  });

  it("shows a distinct 'could not check' badge when the pin store was unreadable (DC-08)", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unknown", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("unknown")).toBe(true);
    // Must not read as the legacy "no key published" state — the message is
    // about local storage failing, not about the peer.
    expect(badge!.classList.contains("unverified")).toBe(false);
    expect(badge!.getAttribute("title")).toContain("Could not check");
  });

  it("shows no badge when the peer's verification is unresolved", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    sidebar.mount(container);

    expect(badgeFor(10)).toBeNull();
  });

  it("re-renders the badge when a peer's verification changes after mount", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null);
    sidebar.mount(container);
    expect(badgeFor(10)!.classList.contains("unverified")).toBe(true);

    setPeerVerif(10, "verified", "AB12 CD34");
    voiceStore.flush();

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("verified")).toBe(true);
  });

  it("opens the identity-mismatch modal when the mismatch badge is clicked", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    // Opening is async (computes the changed key's fingerprint before mounting).
    (badgeFor(10) as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
    });
  });

  it("shows the changed key's fingerprint in the mismatch modal for out-of-band verification", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    // The peer must have a published identity key for its fingerprint to be shown.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "Alice",
        avatar: null,
        role: "member",
        status: "online",
        identityPublicKey: "alice-published-key-b64",
      });
      return { ...prev, members };
    });
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    await vi.waitFor(() => {
      const fp = document.body.querySelector(".modal-overlay .cert-fingerprint");
      expect(fp?.textContent).toBe("FEED FACE 1234 5678");
    });
  });

  it("re-pins the displayed key when the mismatch modal's Trust button is clicked", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    // The peer must have a published key so its fingerprint is shown and there
    // is a concrete verified key to re-pin.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "Alice",
        avatar: null,
        role: "member",
        status: "online",
        identityPublicKey: "alice-published-key-b64",
      });
      return { ...prev, members };
    });
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await vi.waitFor(() => {
      const btn = document.body.querySelector(".modal-overlay .btn-danger") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      return btn;
    });
    trustBtn.click();

    // Pins the exact key whose fingerprint was displayed, not a bare userId.
    expect(mockRePinPeerIdentity).toHaveBeenCalledWith(10, "alice-published-key-b64");
    expect(document.body.querySelector(".modal-overlay")).toBeNull();
  });

  it("does not re-pin when the fingerprint could not be computed (no blind accept)", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "Alice",
        avatar: null,
        role: "member",
        status: "online",
        identityPublicKey: "alice-published-key-b64",
      });
      return { ...prev, members };
    });
    setPeerVerif(10, "mismatch", null);
    // The changed key's fingerprint cannot be computed → the modal shows no
    // fingerprint, so Trust must not pin a key the user never got to verify.
    (computeKeyFingerprint as any).mockRejectedValueOnce(new Error("bad key"));
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await vi.waitFor(() => {
      const btn = document.body.querySelector(".modal-overlay .btn-danger") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      return btn;
    });
    trustBtn.click();

    expect(mockRePinPeerIdentity).not.toHaveBeenCalled();
    expect(document.body.querySelector(".modal-overlay")).toBeNull();
  });

  it("closes an open mismatch modal on sidebar destroy", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
    });

    sidebar.destroy?.();
    expect(document.body.querySelector(".modal-overlay")).toBeNull();
  });
});

// ── Channel feature flags in the sidebar ──
//
// nsfw and voice_max_users reach the sidebar through the channel store, so
// these mount a fresh sidebar per case rather than reusing another suite's
// fixture (which seeds voice users and identity state the readouts would pick
// up).
describe("ChannelSidebar channel feature flags", () => {
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
  describe("NSFW indicator", () => {
    it("marks a flagged text channel", () => {
      setChannels([
        { id: 1, name: "spicy", type: "text", category: "Text Channels", position: 0, nsfw: true },
        { id: 2, name: "general", type: "text", category: "Text Channels", position: 1 },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-nsfw-1']")).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-nsfw-2']")).toBeNull();
    });

    it("marks a flagged voice channel too", () => {
      setChannels([
        { id: 5, name: "lounge", type: "voice", category: "Voice", position: 0, nsfw: true },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-nsfw-5']")).not.toBeNull();
    });

    // The marker is information, not a state — it must not colonise the "#"
    // glyph or the name, which already encode unread/mention/active.
    it("leaves the channel name intact", () => {
      setChannels([
        { id: 1, name: "spicy", type: "text", category: "Text Channels", position: 0, nsfw: true },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-1'] .ch-name")?.textContent).toBe(
        "spicy",
      );
    });
  });

  describe("voice capacity readout", () => {
    it("shows connected/limit when the channel has a user limit", () => {
      setChannels([
        {
          id: 5,
          name: "lounge",
          type: "voice",
          category: "Voice",
          position: 0,
          voice_max_users: 5,
        },
      ]);
      addVoiceUser(5, 10, "Alice");
      addVoiceUser(5, 11, "Bob");
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-5']")?.textContent).toBe(
        "2/5",
      );
    });

    it("shows 0/limit for an empty limited channel", () => {
      setChannels([
        {
          id: 5,
          name: "lounge",
          type: "voice",
          category: "Voice",
          position: 0,
          voice_max_users: 3,
        },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-5']")?.textContent).toBe(
        "0/3",
      );
    });

    // "3/0" would read as a bug, and the participant rows underneath already
    // show the count.
    it("shows nothing when the channel is unlimited", () => {
      setChannels([{ id: 5, name: "lounge", type: "voice", category: "Voice", position: 0 }]);
      addVoiceUser(5, 10, "Alice");
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-5']")).toBeNull();
    });

    it("is not rendered for a text channel", () => {
      setChannels([
        { id: 1, name: "general", type: "text", category: "Text Channels", position: 0 },
      ]);
      sidebar.mount(container);

      expect(container.querySelector("[data-testid='channel-capacity-1']")).toBeNull();
    });

    // The client never blocks the join: its participant list can lag, and a
    // refusal it invented would be uncorrectable. The server answers with
    // CHANNEL_FULL.
    it("still joins on click when the channel looks full", () => {
      setChannels([
        {
          id: 5,
          name: "lounge",
          type: "voice",
          category: "Voice",
          position: 0,
          voice_max_users: 1,
        },
      ]);
      addVoiceUser(5, 10, "Alice");
      sidebar.mount(container);

      (container.querySelector("[data-testid='channel-5']") as HTMLElement).click();

      expect(onVoiceJoin).toHaveBeenCalledWith(5);
    });
  });
});

// ── Channel context menu: Edit/Delete follow MANAGE_CHANNELS ──
//
// These items used to be gated on the role NAME ("owner"/"admin"), so a custom
// role the server would happily let edit a channel saw no way to, and a role
// merely *called* "admin" with no channel bit saw items every click would be
// refused for.
describe("ChannelSidebar channel context menu permissions", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  function mountAs(roleName: string, permissions: number): HTMLElement | null {
    setRoles([{ id: 9, name: roleName, color: null, permissions }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 9, username: "U", avatar: null, role: roleName },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onVoiceLeave: vi.fn(),
      onEditChannel: vi.fn(),
      onDeleteChannel: vi.fn(),
    });
    setChannels([{ id: 1, name: "general", type: "text", category: "Text Channels", position: 0 }]);
    sidebar.mount(container);

    (container.querySelector('[data-channel-id="1"]') as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    return document.querySelector('[data-testid="channel-context-menu"]');
  }

  it("offers Edit and Delete to a custom role holding MANAGE_CHANNELS", () => {
    const menu = mountAs("Curator", Permission.MANAGE_CHANNELS);
    expect(menu?.querySelector('[data-testid="ctx-edit-channel"]')).not.toBeNull();
    expect(menu?.querySelector('[data-testid="ctx-delete-channel"]')).not.toBeNull();
  });

  it("hides them from a role named 'admin' that lacks the bit", () => {
    const menu = mountAs("Admin", Permission.SEND_MESSAGES);
    expect(menu?.querySelector('[data-testid="ctx-edit-channel"]')).toBeNull();
    expect(menu?.querySelector('[data-testid="ctx-delete-channel"]')).toBeNull();
  });

  it("offers them to a role holding ADMINISTRATOR", () => {
    const menu = mountAs("Owner", Permission.ADMINISTRATOR);
    expect(menu?.querySelector('[data-testid="ctx-edit-channel"]')).not.toBeNull();
  });
});
