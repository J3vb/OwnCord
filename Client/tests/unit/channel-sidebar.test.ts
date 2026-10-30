import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { cascadedDeclaration, varToken } from "../helpers/app-css";

// Mock livekitSession. rePinPeerIdentity is hoisted
// so the mock factory can reference it and tests can assert re-pin was invoked.
const { mockRePinPeerIdentity, mockGetUserLocalMute } = vi.hoisted(() => ({
  mockRePinPeerIdentity: vi.fn(() => Promise.resolve(true)),
  mockGetUserLocalMute: vi.fn((_userId: number) => false),
}));
vi.mock("@lib/voice/livekitSession", () => ({
  setUserVolume: vi.fn(),
  getUserVolume: vi.fn(() => 1),
  getUserLocalMute: (userId: number) => mockGetUserLocalMute(userId),
  rePinPeerIdentity: mockRePinPeerIdentity,
  peerAnnouncedIdentityKey: vi.fn(() => null),
}));

const { mockShowToast } = vi.hoisted(() => ({ mockShowToast: vi.fn() }));
vi.mock("@lib/toast", () => ({
  showToast: mockShowToast,
  initToast: vi.fn(),
  teardownToast: vi.fn(),
}));

// Stub the identity-key crypto so the mismatch modal's fingerprint compute is
// deterministic in jsdom (real WebCrypto key import needs a valid SPKI blob).
vi.mock("@lib/net/e2eeCrypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/net/e2eeCrypto")>();
  return {
    ...actual,
    importIdentityPublicKey: vi.fn(() => Promise.resolve({} as CryptoKey)),
    computeKeyFingerprint: vi.fn(() => Promise.resolve("FEED FACE 1234 5678")),
  };
});

const { fetchImageAsObjectUrlMock } = vi.hoisted(() => ({
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

const { mockOpenUserProfilePopup } = vi.hoisted(() => ({
  mockOpenUserProfilePopup: vi.fn(() => () => undefined),
}));
vi.mock("../../src/features/profiles/openUserProfilePopup", () => ({
  openUserProfilePopup: mockOpenUserProfilePopup,
  closeUserProfilePopup: vi.fn(),
}));

import { createChannelSidebar, type ChannelReorderData } from "../../src/components/ChannelSidebar";
import {
  addChannel,
  channelsStore,
  incrementUnread,
  setChannels,
  setActiveChannel,
  setRoles,
  updateChannel,
  type Channel,
} from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { resetSafetyStore, safetyStore, setActiveTimeout } from "../../src/features/safety/store";
import {
  voiceStore,
  updateVoiceState,
  setSpeakers,
  removeVoiceUser,
} from "../../src/stores/voice.store";
import type { PeerVerification } from "../../src/stores/voice.store";
import { membersStore } from "../../src/stores/members.store";
import { Permission, type ReadyChannel, type VoiceStatePayload } from "../../src/lib/types";
import { computeKeyFingerprint } from "@lib/net/e2eeCrypto";
import { noteJoinFailed, noteJoinSucceeded } from "../../src/features/voice/joinBackoff";
import { expectConsole } from "../helpers/console";
import {
  CHANNEL_MUTE_CHANGED,
  getChannelMutesHost,
  muteChannel,
  unmuteChannel,
  invalidateMuteCache,
} from "@lib/prefs/channelMutes";
import { STORAGE_PREFIX } from "@lib/prefs/preferences";
import { setHideMutedChannels } from "@lib/prefs/hideMutedChannels";

function resetStores(): void {
  channelsStore.setState(() => ({
    categories: [],
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
    connectionDialFailed: false,
    transientError: null,
    sessionReplaced: false,
    persistentError: null,
    updateRequiredHost: null,
    collapsedCategories: new Set<string>(),
    sidebarMode: "channels" as const,
    activeDmUserId: null,
    activeView: null,
    settingsTab: null,
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
  sessionFingerprint: string | null = null,
): void {
  voiceStore.setState((prev) => {
    const peerVerifications = new Map(prev.peerVerifications ?? []);
    peerVerifications.set(userId, { userId, status, safetyNumber, sessionFingerprint });
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
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  beforeEach(() => {
    resetStores();
    mockOpenUserProfilePopup.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
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

  // ── B9-21: the channel list is a single Tab stop with arrow-key navigation ──
  describe("keyboard navigation", () => {
    it("exposes exactly one Tab stop and marks the active channel", () => {
      setChannels(testChannels);
      setActiveChannel(1);
      sidebar.mount(container);

      const tabbable = container.querySelectorAll(".channel-item[tabindex='0']");
      expect(tabbable.length).toBe(1);
      expect((tabbable[0] as HTMLElement).dataset.channelId).toBe("1");
      expect(tabbable[0]!.getAttribute("aria-current")).toBe("page");
    });

    it("ArrowDown moves focus and the Tab stop to the next row", () => {
      setChannels(testChannels);
      sidebar.mount(container);

      const first = container.querySelector(".channel-item") as HTMLElement;
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBe(first);
      expect(focused.dataset.channelId).toBe("2");
      expect(focused.getAttribute("tabindex")).toBe("0");
      expect(first.getAttribute("tabindex")).toBe("-1");
    });

    it("Enter on a focused row opens that channel", () => {
      setChannels(testChannels);
      sidebar.mount(container);

      const row = container.querySelector('[data-channel-id="2"]') as HTMLElement;
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(channelsStore.getState().activeChannelId).toBe(2);
    });
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
    // Voice + Info stay (their own categories); "general" is unread (2), so it
    // is the one row a collapsed Text Channels keeps (WP 2B-5).
    expect(itemsAfter.length).toBe(3);

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

  it("shows plain unread as bold name and pill only, with no number badge", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // general (2) and announcements (5) are unread: the `.unread` class carries
    // the bold name and the white pill; the count is not drawn.
    const unreadRows = container.querySelectorAll(".channel-item.unread");
    expect(unreadRows.length).toBe(2);
    expect(container.querySelectorAll(".unread-badge").length).toBe(0);
    expect(container.querySelector('[data-channel-id="1"]')?.textContent).not.toContain("2");
    // The pill and the bold name are CSS on `.unread`; pin both.
    expect(cascadedDeclaration(".channel-item.unread .ch-name", "font-weight")).toBeDefined();
    expect(cascadedDeclaration(".channel-item.unread::before", "background")).toBeDefined();
    // No stylesheet rule styles a server-channel count any more.
    expect(cascadedDeclaration(".channel-item .unread-badge", "background")).toBeUndefined();
  });

  it("keeps the red mention badge, with the count, on a mentioned row", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 2 }, testChannels[1]!]);
    sidebar.mount(container);

    const item = container.querySelector('[data-channel-id="1"]')!;
    expect(item.classList.contains("mentioned")).toBe(true);
    expect(item.querySelector(".mention-badge")?.textContent).toBe("2");
    expect(item.querySelector(".unread-badge")).toBeNull();
  });

  it("an unread row with no mentions has no mention badge and no count", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 7, mention_count: 0 }]);
    sidebar.mount(container);

    const item = container.querySelector('[data-channel-id="1"]')!;
    expect(item.classList.contains("unread")).toBe(true);
    expect(item.classList.contains("mentioned")).toBe(false);
    expect(item.querySelector(".mention-badge")).toBeNull();
    expect(item.querySelector(".unread-badge")).toBeNull();
  });

  describe("muted channels (N7)", () => {
    beforeEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });
    afterEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    it("a muted unread row has no .unread class and no badge", () => {
      setChannels([{ ...testChannels[0]!, unread_count: 5, mention_count: 0 }]);
      muteChannel(1);
      sidebar.mount(container);

      const item = container.querySelector('[data-channel-id="1"]')!;
      expect(item.classList.contains("muted")).toBe(true);
      expect(item.classList.contains("unread")).toBe(false);
      expect(item.querySelector(".unread-badge")).toBeNull();
      expect(item.querySelector(".mention-badge")).toBeNull();
      expect(item.hasAttribute("aria-description")).toBe(false);
    });

    it("names plain unread for screen readers, but not a mention", () => {
      setChannels([
        { ...testChannels[0]!, unread_count: 5, mention_count: 0 },
        { ...testChannels[1]!, unread_count: 5, mention_count: 1 },
      ]);
      sidebar.mount(container);

      const plain = container.querySelector(`[data-channel-id="${testChannels[0]!.id}"]`)!;
      const mentioned = container.querySelector(`[data-channel-id="${testChannels[1]!.id}"]`)!;
      expect(plain.getAttribute("aria-description")).toBe("Unread");
      expect(mentioned.hasAttribute("aria-description")).toBe(false);
    });

    it("a muted row with mentions still shows the mention", () => {
      setChannels([{ ...testChannels[0]!, unread_count: 5, mention_count: 2 }]);
      muteChannel(1);
      sidebar.mount(container);

      const item = container.querySelector('[data-channel-id="1"]')!;
      expect(item.classList.contains("unread")).toBe(true);
      expect(item.classList.contains("mentioned")).toBe(true);
      expect(item.querySelector(".mention-badge")?.textContent).toBe("2");
    });

    it("unmuting restores the unread look", () => {
      setChannels([{ ...testChannels[0]!, unread_count: 5, mention_count: 0 }]);
      muteChannel(1);
      sidebar.mount(container);
      unmuteChannel(1);
      channelsStore.flush();
      const item = container.querySelector('[data-channel-id="1"]')!;
      expect(item.classList.contains("unread")).toBe(true);
    });
  });

  it("leaves the mention badge uncapped", () => {
    setChannels([{ ...testChannels[0]!, unread_count: 0, mention_count: 137 }]);
    sidebar.mount(container);

    const badge = container.querySelector('[data-channel-id="1"] .mention-badge');
    expect(badge?.textContent).toBe("137");
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

  it("clicking the joined voice channel opens the call instead of leaving (V1)", () => {
    // Discord parity: a click on the channel you are in shows the call; only
    // the voice widget's Disconnect leaves. The sidebar has no leave callback.
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3, voiceStatus: "connected" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceItem.click();

    expect(onOpenCall).toHaveBeenCalledOnce();
    expect(onVoiceJoin).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(3);
  });

  it("a repeat click on the voice channel being joined does not leave it", () => {
    // Every click toggled, so clicking the row again while a join was still
    // joining/securing (a double-click, or retrying a slow join) sent
    // voice_leave before the SFU was ever reached: rapid clicks cycled
    // voice_join/voice_leave on the server several times a second.
    setChannels(testChannels);
    sidebar.mount(container);
    for (const voiceStatus of ["joining", "securing"] as const) {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3, voiceStatus }));
      voiceStore.flush();
      (container.querySelector('[data-channel-id="3"]') as HTMLElement).click();
      expect(onOpenCall).not.toHaveBeenCalled();
    }
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
    voiceStore.flush();
    (container.querySelector('[data-channel-id="3"]') as HTMLElement).click();
    expect(onOpenCall).toHaveBeenCalledOnce();
  });

  // ── V9: a collapsed category keeps the voice channel you are in ──

  it("a collapsed category still shows the joined voice channel (V9)", () => {
    setChannels([
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ]);
    // Nobody is in either channel, so only being joined can keep a row.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Voice Channels"]),
    }));
    sidebar.mount(container);

    expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
    expect(container.querySelector('[data-channel-id="5"]')).toBeNull();

    // Leaving hides it; joining the other channel shows that one instead.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();
    expect(container.querySelector('[data-channel-id="3"]')).toBeNull();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 5 }));
    voiceStore.flush();
    expect(container.querySelector('[data-channel-id="5"]')).not.toBeNull();
    expect(container.querySelector('[data-channel-id="3"]')).toBeNull();

    // Expanding restores every row.
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set<string>() }));
    uiStore.flush();
    expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
    expect(container.querySelector('[data-channel-id="5"]')).not.toBeNull();
  });

  it("a collapsed category hides an empty voice channel the user is not in (V9)", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Voice Channels"]),
    }));
    sidebar.mount(container);

    expect(container.querySelector('[data-channel-id="3"]')).toBeNull();
    expect(container.querySelector(".voice-user-item")).toBeNull();
  });

  // ── WP 2B-5: a collapsed category keeps the rows that matter ──

  // ── WP 3D-4d: Hide Muted Channels ──

  describe("Hide Muted Channels", () => {
    const text = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
      id,
      name: `text-${id}`,
      type: "text",
      category: "Text Channels",
      position: id,
      unread_count: 0,
      last_message_id: 1,
      ...extra,
    });
    const voice = (id: number): ReadyChannel => ({
      id,
      name: `voice-${id}`,
      type: "voice",
      category: "Voice Channels",
      position: id,
    });
    const rowIds = (): string[] =>
      Array.from(container.querySelectorAll<HTMLElement>(".channel-item")).map(
        (el) => el.dataset.channelId ?? "",
      );
    const flush = (): void => {
      channelsStore.flush();
      voiceStore.flush();
    };

    beforeEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    afterEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    it("shows muted rows while the preference is off", () => {
      setChannels([text(1), text(2)]);
      muteChannel(2);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2"]);
    });

    it("hides a muted channel while the preference is on, and keeps unmuted ones", () => {
      setChannels([text(1), text(2), text(3)]);
      muteChannel(2);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "3"]);
    });

    it("keeps the muted channel you are viewing", () => {
      setChannels([text(1), text(2)]);
      muteChannel(1);
      muteChannel(2);
      setHideMutedChannels(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
      sidebar.mount(container);
      expect(rowIds()).toEqual(["2"]);
    });

    it("keeps a muted channel with an unread mention, but not plain unread", () => {
      setChannels([
        text(1, { unread_count: 2, mention_count: 1 }),
        text(2, { unread_count: 5 }),
        text(3),
      ]);
      muteChannel(1);
      muteChannel(2);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "3"]);
    });

    it("keeps a muted voice channel that has people in it, and hides an empty one", () => {
      setChannels([text(1), voice(10), voice(11)]);
      muteChannel(10);
      muteChannel(11);
      addVoiceUser(10, 30, "alice");
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "10"]);
    });

    it("keeps the header of a category whose channels are all hidden", () => {
      setChannels([text(1), voice(10)]);
      muteChannel(1);
      setHideMutedChannels(true);
      sidebar.mount(container);
      const headers = Array.from(container.querySelectorAll<HTMLElement>(".category")).map(
        (el) => el.dataset.category,
      );
      expect(headers).toEqual(["Text Channels", "Voice Channels"]);
      expect(rowIds()).toEqual(["10"]);
      expect(
        container
          .querySelector('[data-category="Text Channels"]')
          ?.parentElement?.querySelector(".category-channels-container")?.children.length,
      ).toBe(0);
    });

    it("collapsing a category still works with the preference on", () => {
      setChannels([text(1), text(2, { unread_count: 3 })]);
      muteChannel(1);
      setHideMutedChannels(true);
      uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(["Text Channels"]) }));
      sidebar.mount(container);
      // Collapsed: only the unread unmuted row remains; the muted one stays hidden.
      expect(rowIds()).toEqual(["2"]);
    });

    it("redraws live when the preference is toggled", () => {
      setChannels([text(1), text(2)]);
      muteChannel(2);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2"]);

      setHideMutedChannels(true);
      expect(rowIds()).toEqual(["1"]);

      setHideMutedChannels(false);
      expect(rowIds()).toEqual(["1", "2"]);
    });

    it("redraws live when a channel is muted and unmuted", () => {
      setChannels([text(1), text(2)]);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2"]);

      muteChannel(2);
      expect(rowIds()).toEqual(["1"]);

      unmuteChannel(2);
      expect(rowIds()).toEqual(["1", "2"]);
    });

    it("a focused row that hides moves focus to the row that took its place", () => {
      setChannels([text(1), text(2), text(3)]);
      setHideMutedChannels(true);
      sidebar.mount(container);
      container.querySelector<HTMLElement>('[data-channel-id="2"]')!.focus();

      muteChannel(2);

      expect(rowIds()).toEqual(["1", "3"]);
      expect(document.activeElement).toBe(container.querySelector('[data-channel-id="3"]'));
    });

    it("the last focused row that hides moves focus to the row before it", () => {
      setChannels([text(1), text(2)]);
      setHideMutedChannels(true);
      sidebar.mount(container);
      container.querySelector<HTMLElement>('[data-channel-id="2"]')!.focus();

      muteChannel(2);

      expect(document.activeElement).toBe(container.querySelector('[data-channel-id="1"]'));
    });

    it("redraws live when you switch channels: the one you leave hides, the one you open shows", () => {
      setChannels([text(1), text(2)]);
      muteChannel(1);
      muteChannel(2);
      setHideMutedChannels(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);

      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
      flush();
      expect(rowIds()).toEqual(["2"]);
    });

    it("redraws live when a mention arrives or a voice user joins", () => {
      setChannels([text(1), text(2), voice(10)]);
      muteChannel(2);
      muteChannel(10);
      setHideMutedChannels(true);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.set(2, { ...channels.get(2)!, unreadCount: 1, mentionCount: 1 });
        return { ...prev, channels };
      });
      flush();
      expect(rowIds()).toEqual(["1", "2"]);

      addVoiceUser(10, 30, "alice");
      flush();
      expect(rowIds()).toEqual(["1", "2", "10"]);
    });

    it("ignores an unrelated preference change", () => {
      setChannels([text(1), text(2)]);
      muteChannel(2);
      setHideMutedChannels(true);
      sidebar.mount(container);
      const before = container.querySelector('[data-channel-id="1"]');

      window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "fontSize" } }));

      expect(container.querySelector('[data-channel-id="1"]')).toBe(before);
      expect(rowIds()).toEqual(["1"]);
    });
  });

  describe("collapsed category shows what matters", () => {
    const text = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
      id,
      name: `text-${id}`,
      type: "text",
      category: "Text Channels",
      position: id,
      unread_count: 0,
      last_message_id: 1,
      ...extra,
    });
    const collapse = (...names: string[]): void => {
      uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(names) }));
    };
    const rowIds = (): string[] =>
      Array.from(container.querySelectorAll<HTMLElement>(".channel-item")).map(
        (el) => el.dataset.channelId ?? "",
      );

    beforeEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    afterEach(() => {
      localStorage.clear();
      invalidateMuteCache();
    });

    it("a collapsed group with one unread channel renders exactly that row", () => {
      setChannels([text(1), text(2, { unread_count: 3 }), text(3)]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["2"]);
    });

    it("a mentioned muted channel shows; a plain-unread muted one hides and leaves no header marker", () => {
      setChannels([
        text(1, { unread_count: 2, mention_count: 1 }),
        text(2, { unread_count: 4 }),
        text(3),
      ]);
      muteChannel(1);
      muteChannel(2);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);
      // The hidden muted row looks read, so the header carries no dot (3D-2b).
      expect(container.querySelector(".category-unread-dot")).toBeNull();
      expect(container.querySelector(".channel-item.unread")).not.toBeNull();
      expect(container.querySelector('[data-channel-id="2"]')).toBeNull();
    });

    it("a mentioned muted channel alone still shows", () => {
      setChannels([text(1, { unread_count: 2, mention_count: 1 }), text(2)]);
      muteChannel(1);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);
    });

    it("keeps a voice channel with a person and hides an empty one", () => {
      setChannels([
        text(1),
        { id: 3, name: "lobby", type: "voice", category: "Voice Channels", position: 0 },
        { id: 5, name: "empty", type: "voice", category: "Voice Channels", position: 1 },
      ]);
      addVoiceUser(3, 30, "alice");
      collapse("Voice Channels");
      sidebar.mount(container);
      expect(container.querySelector('[data-channel-id="3"]')).not.toBeNull();
      expect(container.querySelector('[data-channel-id="5"]')).toBeNull();
      expect(container.querySelector('.voice-user-item[data-voice-uid="30"]')).not.toBeNull();
      // Live: the last person leaving hides the row again.
      voiceStore.setState((prev) => ({ ...prev, voiceUsers: new Map() }));
      voiceStore.flush();
      expect(container.querySelector('[data-channel-id="3"]')).toBeNull();
    });

    it("keeps the active channel", () => {
      setChannels([text(1), text(2), text(3)]);
      setActiveChannel(2);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["2"]);
    });

    it("rows appear and disappear live as unread state changes", () => {
      setChannels([text(1), text(2), text(3)]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual([]);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.set(2, { ...channels.get(2)!, unreadCount: 1 });
        return { ...prev, channels };
      });
      channelsStore.flush();
      expect(rowIds()).toEqual(["2"]);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        channels.set(2, { ...channels.get(2)!, unreadCount: 0 });
        return { ...prev, channels };
      });
      channelsStore.flush();
      expect(rowIds()).toEqual([]);
    });

    it("muting a collapsed unread row hides it; unmuting reverses", () => {
      setChannels([text(1, { unread_count: 2 })]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1"]);
      muteChannel(1);
      expect(rowIds()).toEqual([]);
      unmuteChannel(1);
      expect(rowIds()).toEqual(["1"]);
    });

    it("an expanded category shows every row", () => {
      setChannels([text(1, { unread_count: 2 }), text(2), text(3, { unread_count: 1 })]);
      muteChannel(3);
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "2", "3"]);
    });

    it("Move Up in a collapsed category swaps with the row shown above, not a hidden one", () => {
      const onReorderChannel = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
      sidebar.destroy?.();
      setAdminUser();
      sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onReorderChannel });
      setChannels([text(1, { unread_count: 1 }), text(2), text(3, { unread_count: 1 })]);
      collapse("Text Channels");
      sidebar.mount(container);
      expect(rowIds()).toEqual(["1", "3"]);

      container
        .querySelector('[data-channel-id="3"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
      (document.querySelector('[data-testid="ctx-move-up"]') as HTMLElement).click();

      expect(onReorderChannel).toHaveBeenCalledWith([
        { channelId: 3, newPosition: 1, previousPosition: 3 },
        { channelId: 1, newPosition: 3, previousPosition: 1 },
      ]);
      expect(channelsStore.getState().channels.get(2)?.position).toBe(2);
    });

    it("a focused row that stops showing hands focus to the category arrow", () => {
      setChannels([text(1), text(2, { unread_count: 1 })]);
      collapse("Text Channels");
      sidebar.mount(container);
      const row = container.querySelector<HTMLElement>('[data-channel-id="2"]')!;
      row.focus();
      expect(document.activeElement).toBe(row);

      channelsStore.setState((prev) => {
        const channels = new Map(prev.channels);
        const ch = channels.get(2)!;
        channels.set(2, { ...ch, unreadCount: 0 });
        return { ...prev, channels };
      });
      channelsStore.flush();

      expect(container.querySelector('[data-channel-id="2"]')).toBeNull();
      expect(document.activeElement).toBe(container.querySelector(".category-arrow"));
    });
  });

  // ── V11: a voice user with nothing to watch opens their profile ──

  it("clicking a voice user without camera or stream opens their profile (V11)", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    addVoiceUser(3, 30, "alice");
    sidebar.mount(container);

    const row = container.querySelector('.voice-user-item[data-voice-uid="30"]') as HTMLElement;
    row.click();

    expect(mockOpenUserProfilePopup).toHaveBeenCalledOnce();
    expect(mockOpenUserProfilePopup).toHaveBeenCalledWith(expect.objectContaining({ userId: 30 }));
    expect(onWatchStream).not.toHaveBeenCalled();
    expect(onVoiceJoin).not.toHaveBeenCalled();
    expect(onOpenCall).not.toHaveBeenCalled();
  });

  it("Enter or Space on a voice user row opens the profile, own row included (V11)", () => {
    setAdminUser();
    setChannels(testChannels);
    addVoiceUser(3, 1, "Admin");
    addVoiceUser(3, 30, "alice");
    sidebar.mount(container);

    for (const [uid, key] of [
      [1, "Enter"],
      [30, " "],
    ] as const) {
      const row = container.querySelector(
        `.voice-user-item[data-voice-uid="${uid}"]`,
      ) as HTMLElement;
      expect(row.tabIndex).toBe(0);
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(mockOpenUserProfilePopup).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: uid }),
      );
    }
    expect(mockOpenUserProfilePopup).toHaveBeenCalledTimes(2);
  });

  it("clicking a voice user with a stream watches it and opens no profile (V11)", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "alice",
      muted: false,
      deafened: false,
      speaking: false,
      camera: true,
      screenshare: false,
    });
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    (container.querySelector('.voice-user-item[data-voice-uid="30"]') as HTMLElement).click();

    expect(onWatchStream).toHaveBeenCalledWith(30);
    expect(mockOpenUserProfilePopup).not.toHaveBeenCalled();
  });

  it("destroy closes a profile popup a voice user row opened (V11)", () => {
    const close = vi.fn();
    mockOpenUserProfilePopup.mockReturnValueOnce(close);
    setChannels(testChannels);
    addVoiceUser(3, 30, "alice");
    sidebar.mount(container);

    (container.querySelector('.voice-user-item[data-voice-uid="30"]') as HTMLElement).click();
    sidebar.destroy?.();

    expect(close).toHaveBeenCalledOnce();
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

  it("frozen voice channel does not fire onOpenCall even when joined", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);

    voiceItem.click();
    expect(onOpenCall).not.toHaveBeenCalled();
  });

  it("a timeout disables joining voice with the server expiry, never leaving", () => {
    setChannels(testChannels);
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    sidebar.mount(container);

    let voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.getAttribute("aria-disabled")).toBe("true");
    expect(voiceItem.title).toMatch(/^You can't join voice until /);
    // The expiry is visible text in the row, not only a tooltip.
    expect(container.querySelector("[data-testid='voice-timeout-3']")?.textContent).toMatch(
      /^You can't join voice until /,
    );
    voiceItem.click();
    expect(onVoiceJoin).not.toHaveBeenCalled();

    // Already in the channel: the row stays usable (it opens the call).
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    voiceStore.flush();
    voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.hasAttribute("aria-disabled")).toBe(false);
    expect(container.querySelector("[data-testid='voice-timeout-3']")).toBeNull();
    voiceItem.click();
    expect(onOpenCall).toHaveBeenCalled();

    // The lift re-enables the row.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();
    setActiveTimeout(null);
    safetyStore.flush();
    voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.hasAttribute("aria-disabled")).toBe(false);
    expect(container.querySelector("[data-testid='voice-timeout-3']")).toBeNull();
    resetSafetyStore();
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

  it("shows the member's display name (nickname), not the raw username, in the voice roster", () => {
    setChannels(testChannels);
    // Member has a nickname set — every other identity surface (member list,
    // message rows, DM sidebar) renders it instead of the raw username.
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          10,
          {
            id: 10,
            username: "Bob",
            displayName: "Bobby",
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 10,
      username: "Bob",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userName = container.querySelector(".voice-user-item .vu-name");
    expect(userName?.textContent).toBe("Bobby");
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
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });

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
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const voiceUserItem = container.querySelector(".voice-user-item") as HTMLElement;
    expect(voiceUserItem).not.toBeNull();
    voiceUserItem.click();

    // User has screenshare: true, so tileId = userId + SCREENSHARE_TILE_ID_OFFSET
    expect(onWatchStream).toHaveBeenCalledWith(30 + 1_000_000);
  });

  it("clicking a peer's stream row also joins the channel when not already in it", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });

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

    // Watching a peer's stream needs a live LiveKit room -- without joining
    // first, showVideoGrid has no cells to focus and the user is stranded on
    // an empty grid. currentChannelId defaults to null (not channel 3 here).
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("opens no stream when the join backoff refuses the stream row's join", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });

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
    noteJoinFailed();

    try {
      (container.querySelector(".voice-user-item") as HTMLElement).click();
      // The join is still offered so its refusal toast shows, but no room was joined.
      expect(onVoiceJoin).toHaveBeenCalledWith(3);
      expect(onWatchStream).not.toHaveBeenCalled();
    } finally {
      noteJoinSucceeded();
    }
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

  it("offers a create affordance in the empty state for a channel manager (#9)", () => {
    // With zero channels there is no category header and therefore no "+";
    // the old hint pointed at a right-click that did nothing.
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });
    sidebar.mount(container);

    const btn = container.querySelector<HTMLElement>("[data-testid='create-channel-empty']");
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onCreateChannel).toHaveBeenCalledWith({ id: 0, name: "" });
  });

  it("hides the empty-state create affordance from a non-manager (#9)", () => {
    sidebar.mount(container);
    expect(container.querySelector("[data-testid='create-channel-empty']")).toBeNull();
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

  it("shows only the headphones-off icon for a deafened user (deafen implies mute)", () => {
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
    // Deafened implies muted, so showing both mic-off and headphones-off is a
    // duplicate. Discord shows the single headphones-off.
    const mutedIcons = userRow!.querySelectorAll(".vu-muted");
    expect(mutedIcons.length).toBe(1);
    expect(mutedIcons[0]!.querySelector("svg")).not.toBeNull();
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

    // Update only speaking flag (structural signature stays the same).
    // setSpeakers is the only writer of speaking now (a voice_state no longer
    // clobbers the LiveKit-authoritative flag).
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    setSpeakers({ channel_id: 3, speakers: [60] });
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
    // setSpeakers only applies to the channel the client is in; set it before
    // mount so the later flip is speaking-only.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const rowBefore = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowBefore).not.toBeNull();

    // speaking-only flip → patched via the cached row map, not re-rendered
    setSpeakers({ channel_id: 3, speakers: [61] });
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

  it("renders the member's profile picture in the voice row, keeping the speaking class", async () => {
    setChannels(testChannels);
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          72,
          {
            id: 72,
            username: "Pic",
            avatar: "/api/v1/files/pic",
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 72,
      username: "Pic",
      muted: false,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const row = container.querySelector(".voice-user-item")!;
    expect(row.classList.contains("speaking")).toBe(true);
    const avatar = row.querySelector<HTMLElement>(".vu-avatar")!;
    await vi.waitFor(() => {
      expect(avatar.querySelector<HTMLImageElement>(".avatar-img")?.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      );
    });
    expect(avatar.querySelector(".avatar-initial")).toBeNull();
  });

  it("keeps the initial for a voice user whose member has no avatar", () => {
    setChannels(testChannels);
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          73,
          { id: 73, username: "Nopic", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 73,
      username: "Nopic",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".vu-avatar")!;
    expect(avatar.querySelector(".avatar-img")).toBeNull();
    expect(avatar.textContent).toBe("N");
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
      onOpenCall,
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
      onOpenCall,
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
      onOpenCall,
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
      onOpenCall,
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
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });

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
      onOpenCall,
      onEditChannel: vi.fn(),
      onPurgeChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
  });

  it("offers Purge Messages once a live role update grants MANAGE_MESSAGES", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: 0 }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 3, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });
    setChannels(testChannels);
    sidebar.mount(container);
    openChannelCtxMenu();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());

    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_MESSAGES }]);
    channelsStore.flush();

    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).not.toBeNull();
  });

  it("purge prompt clamps the count and calls onPurgeChannel with the channel", async () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });

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
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });

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
      onOpenCall,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector('[data-testid="create-channel-text-channels"]');
    expect(addBtn).not.toBeNull();
    expect(addBtn!.textContent).toBe("+");
  });

  it("clicking create channel button calls onCreateChannel with the category (id and name)", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector(
      '[data-testid="create-channel-text-channels"]',
    ) as HTMLElement;
    addBtn.click();

    // These fixtures carry no category_id: a name-only category (older server).
    expect(onCreateChannel).toHaveBeenCalledWith({ id: 0, name: "Text Channels" });
  });

  it("the + of a real category passes its id, and the synthetic Voice group's passes none and a voice hint", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });
    setChannels([
      { id: 1, name: "general", type: "text", category: "Chat", category_id: 4, position: 0 },
      { id: 2, name: "lounge", type: "voice", category: null, position: 1 },
    ]);
    sidebar.mount(container);

    (container.querySelector('[data-testid="create-channel-chat"]') as HTMLElement).click();
    expect(onCreateChannel).toHaveBeenLastCalledWith({ id: 4, name: "Chat" });
    (container.querySelector('[data-testid="create-channel-voice"]') as HTMLElement).click();
    expect(onCreateChannel).toHaveBeenLastCalledWith({ id: 0, name: "" }, "voice");
  });

  it("create channel button does not collapse the category", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
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
      onOpenCall,
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
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

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
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(container.querySelector(".category-add-btn")).toBeNull();
  });

  // ── Live role-change repaint (OC-0142) ──
  // canManageChannels() is evaluated at render time from authStore.user.role,
  // but the sidebar's only authStore subscription selects serverName. A
  // MEMBER_UPDATE for the signed-in user (dispatcher.ts writes the new role
  // via updateUser) must still cause a repaint without any unrelated event.

  it("repaints channel-management affordances when the signed-in user's own role changes", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    // Starts as a plain member: no "+" button.
    expect(container.querySelector(".category-add-btn")).toBeNull();

    // Promoted to admin (mirrors dispatcher.ts's MEMBER_UPDATE self-branch,
    // which patches authStore via updateUser({ role })) — no channel/voice
    // event fires alongside it.
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user === null ? null : { ...prev.user, role: "admin" },
    }));
    authStore.flush();

    expect(container.querySelector(".category-add-btn")).not.toBeNull();
  });

  it("repaints channel-management affordances when the role list's permission mask changes", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.SEND_MESSAGES }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 3, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    // Moderator role holds no MANAGE_CHANNELS bit yet.
    expect(container.querySelector(".category-add-btn")).toBeNull();

    // A ROLES_UPDATE grants MANAGE_CHANNELS to the same role (dispatcher.ts's
    // ROLES_UPDATE handler replaces the whole list via setRoles) — again with
    // no accompanying channel/voice event.
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    channelsStore.flush();

    expect(container.querySelector(".category-add-btn")).not.toBeNull();
  });

  // ── Voice user volume context menu ──

  it("right-click on other user's voice row opens volume context menu", async () => {
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
    // The menu code loads on its first open (O-6b).
    await vi.dynamicImportSettled();

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

  // ── Voice moderation context menu (can_moderate_voice, B9-14) ──

  /** Signs in as a user whose role holds exactly `permissions`, puts one other
   *  user in the voice channel, mounts the sidebar and right-clicks their row.
   *  Every channel carries `verdict` as its can_moderate_voice (null: absent);
   *  by default the one the server computes with no channel override (the
   *  role's MUTE_MEMBERS, ADMINISTRATOR included). Returns the open menu
   *  element (or null). */
  const MUTE_AND_MOVE = Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS;

  async function openVoiceMenuAs(
    permissions: number,
    voiceUser: Partial<VoiceStatePayload> = {},
    onVoiceModerate?: Parameters<typeof createChannelSidebar>[0]["onVoiceModerate"],
    channels: ReadyChannel[] = testChannels,
    verdict: boolean | null = (permissions &
      (Permission.MUTE_MEMBERS | Permission.ADMINISTRATOR)) !==
      0,
  ): Promise<HTMLElement | null> {
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onVoiceModerate });

    setChannels(
      channels.map((ch) =>
        verdict === null
          ? ch
          : {
              ...ch,
              can_moderate_voice: verdict,
              can_move_voice: (permissions & Permission.MOVE_MEMBERS) !== 0,
            },
      ),
    );
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
    // The menu code loads on its first open (O-6b).
    await vi.dynamicImportSettled();
    return document.querySelector(".user-vol-menu");
  }

  it("hides the moderation section for a role without MUTE_MEMBERS", async () => {
    const menu = await openVoiceMenuAs(Permission.MANAGE_CHANNELS, {}, voiceModCallbacks());
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    // The volume controls stay available to everyone.
    expect(menu!.textContent).toContain("Reset Volume");
  });

  it("follows the channel's verdict, not the role: an override that denies hides the section", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      {},
      voiceModCallbacks(),
      testChannels,
      false,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
  });

  it("follows the channel's verdict, not the role: a verdict of true offers the section", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MANAGE_CHANNELS,
      {},
      voiceModCallbacks(),
      testChannels,
      true,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("offers nothing without a verdict, and says why to a role holding MUTE_MEMBERS", async () => {
    const cb = voiceModCallbacks();
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb, testChannels, null);
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    const why = menu!.querySelector('[data-action="voice-mod-unavailable"]');
    expect(why!.textContent).toBe(
      "Voice moderation unavailable: the server hasn't confirmed you can moderate this channel.",
    );
    expect(why!.getAttribute("aria-disabled")).toBe("true");
    (why as HTMLElement).click();
    expect(cb.onServerMute).not.toHaveBeenCalled();

    const member = await openVoiceMenuAs(Permission.SEND_MESSAGES, {}, cb, testChannels, null);
    expect(member!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
  });

  it("reads each channel's verdict: moderating one voice channel is not moderating another", async () => {
    const channels: ReadyChannel[] = [
      ...testChannels.map((ch) => (ch.id === 3 ? { ...ch, can_moderate_voice: false } : ch)),
      {
        id: 5,
        name: "voice-two",
        type: "voice",
        category: "Voice Channels",
        position: 1,
        can_moderate_voice: true,
      },
    ];
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      {},
      voiceModCallbacks(),
      channels,
      null,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
  });

  it("takes a live channel_create verdict at the next open, and keeps it when one is absent", async () => {
    const cb = voiceModCallbacks();
    expect(
      (await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb))!.querySelector(
        '[data-action="server-mute"]',
      ),
    ).not.toBeNull();
    const voice = testChannels.find((ch) => ch.id === 3)!;
    const row = (): HTMLElement => container.querySelector(".voice-user-item") as HTMLElement;
    const reopen = async (): Promise<HTMLElement | null> => {
      row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await vi.dynamicImportSettled();
      return document.querySelector(".user-vol-menu");
    };

    // An override edit revokes it (RefreshChannelVisibility's targeted channel_create).
    addChannel({ ...voice, can_moderate_voice: false });
    expect((await reopen())!.querySelector('[data-action="server-mute"]')).toBeNull();
    // A channel_create without the field changes nothing.
    addChannel({ ...voice });
    expect((await reopen())!.querySelector('[data-action="server-mute"]')).toBeNull();
    addChannel({ ...voice, can_moderate_voice: true });
    expect((await reopen())!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("offers only Move to to a role whose verdict is can_move_voice without can_moderate_voice", async () => {
    const cb = voiceModCallbacks();
    const channels: ReadyChannel[] = [
      ...testChannels.map((ch) =>
        ch.type === "voice" ? { ...ch, can_moderate_voice: false, can_move_voice: true } : ch,
      ),
      {
        id: 5,
        name: "voice-two",
        type: "voice",
        category: "Voice Channels",
        position: 1,
        can_moderate_voice: false,
        can_move_voice: true,
      },
    ];
    const menu = await openVoiceMenuAs(Permission.MOVE_MEMBERS, {}, cb, channels, null);
    expect(menu!.querySelector('[data-action="move-to"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="server-deafen"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
    const target = menu!.querySelector<HTMLElement>('[data-move-channel="5"]');
    expect(target).not.toBeNull();
    target!.click();
    expect(cb.onMove).toHaveBeenCalledWith(80, 5);
  });

  it("shows the full section but no Move to when can_moderate_voice is true and can_move_voice is false", async () => {
    const channels = [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ].map((ch) =>
      ch.type === "voice" ? { ...ch, can_moderate_voice: true, can_move_voice: false } : ch,
    ) as ReadyChannel[];
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      {},
      voiceModCallbacks(),
      channels,
      null,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="move-to"]')).toBeNull();
  });

  it("offers nothing when both verdicts are false", async () => {
    const channels = testChannels.map((ch) =>
      ch.type === "voice" ? { ...ch, can_moderate_voice: false, can_move_voice: false } : ch,
    );
    const menu = await openVoiceMenuAs(
      Permission.MOVE_MEMBERS,
      {},
      voiceModCallbacks(),
      channels,
      null,
    );
    expect(menu!.querySelector('[data-action="move-to"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
  });

  it("says why to a role holding MOVE_MEMBERS when the server gave no verdict", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MOVE_MEMBERS,
      {},
      voiceModCallbacks(),
      testChannels,
      null,
    );
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).not.toBeNull();
  });

  it("hides the moderation section when the page wired no callbacks", async () => {
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS);
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
  });

  it("shows the moderation section for a role holding MUTE_MEMBERS", async () => {
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, voiceModCallbacks());
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')!.textContent).toBe("Server Mute");
    expect(menu!.querySelector('[data-action="server-deafen"]')!.textContent).toBe("Server Deafen");
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).not.toBeNull();
  });

  it("shows the moderation section for an ADMINISTRATOR role", async () => {
    const menu = await openVoiceMenuAs(Permission.ADMINISTRATOR, {}, voiceModCallbacks());
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("labels the toggles by the target's current server-imposed state", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      { muted: true, deafened: true, server_muted: true, server_deafened: true },
      voiceModCallbacks(),
    );
    expect(menu!.querySelector('[data-action="server-mute"]')!.textContent).toBe("Server Unmute");
    expect(menu!.querySelector('[data-action="server-deafen"]')!.textContent).toBe(
      "Server Undeafen",
    );
  });

  it("sends server mute with the channel and target, and disconnect with the target", async () => {
    const cb = voiceModCallbacks();
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);

    (menu!.querySelector('[data-action="server-mute"]') as HTMLElement).click();
    expect(cb.onServerMute).toHaveBeenCalledWith(3, 80, true);

    const menu2 = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);
    (menu2!.querySelector('[data-action="voice-disconnect"]') as HTMLElement).click();
    expect(cb.onDisconnect).toHaveBeenCalledWith(80);
  });

  it("greys the moderation rows with a reason while the socket is not connected", async () => {
    const cb = voiceModCallbacks();
    const channels: ReadyChannel[] = [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ];
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    const menu = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, channels);

    const why = menu!.querySelector('[data-action="voice-mod-offline"]');
    expect(why!.textContent).toBe(
      "Reconnecting. Voice moderation comes back once you are connected.",
    );
    for (const action of ["server-mute", "server-deafen", "voice-disconnect"]) {
      const item = menu!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
      expect(item.disabled).toBe(true);
      expect(item.classList.contains("disabled")).toBe(true);
      item.click();
    }
    const move = menu!.querySelector('[data-action="move-to"]')!;
    expect(move.getAttribute("aria-disabled")).toBe("true");
    expect(move.querySelector("[data-move-channel]")).toBeNull();
    expect(cb.onServerMute).not.toHaveBeenCalled();
    expect(cb.onServerDeafen).not.toHaveBeenCalled();
    expect(cb.onDisconnect).not.toHaveBeenCalled();

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
    const offline = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, channels);
    expect(offline!.querySelector('[data-action="voice-mod-offline"]')!.textContent).toBe(
      "Not connected. Voice moderation needs a connection to the server.",
    );

    // Back online: the rows are live again and the reason is gone.
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    const live = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, channels);
    expect(live!.querySelector('[data-action="voice-mod-offline"]')).toBeNull();
    const mute = live!.querySelector<HTMLButtonElement>('[data-action="server-mute"]')!;
    expect(mute.disabled).toBe(false);
    mute.click();
    expect(cb.onServerMute).toHaveBeenCalledWith(3, 80, true);
  });

  it("gives a MUTE_MEMBERS-only role no Move to: only MOVE_MEMBERS opens a move", async () => {
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, voiceModCallbacks(), [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ]);
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="move-to"]')).toBeNull();
    expect(menu!.querySelector("[data-move-channel]")).toBeNull();
  });

  it("offers only the other voice channels as move targets", async () => {
    const cb = voiceModCallbacks();
    const menu = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb);

    const moveItems = menu!.querySelectorAll("[data-move-channel]");
    // testChannels has one voice channel (id 3) — the one the target is in.
    expect(moveItems.length).toBe(0);

    const menu2 = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, [
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
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
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

  it("shows a locally muted participant's icon and redraws on a local Mute change", () => {
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    setChannels(testChannels);
    addVoiceUser(3, 82, "loud");
    sidebar.mount(container);
    expect(container.querySelector(".vu-local-muted")).toBeNull();

    mockGetUserLocalMute.mockImplementation((id) => id === 82);
    try {
      window.dispatchEvent(
        new CustomEvent("owncord:user-local-mute-changed", { detail: { userId: 82 } }),
      );
      const icon = container.querySelector(
        '.voice-user-item[data-voice-uid="82"] .vu-local-muted',
      ) as HTMLElement;
      expect(icon).not.toBeNull();
      expect(icon.title).toBe("Muted for you");
    } finally {
      mockGetUserLocalMute.mockImplementation(() => false);
    }
  });

  it("colours a self-mute grey and a moderator's mute red, with a steady speaking ring", () => {
    expect(varToken(cascadedDeclaration(".voice-user-item .vu-muted", "color"))).toBe(
      "--text-muted",
    );
    expect(varToken(cascadedDeclaration(".vu-muted.vu-server-muted", "color"))).toBe("--red");
    // The ring is steady: no pulse on the sidebar row or on the user bar.
    expect(cascadedDeclaration(".voice-user-item.speaking .vu-avatar", "box-shadow")).toBeDefined();
    expect(
      cascadedDeclaration(".voice-user-item.speaking .vu-avatar", "animation"),
    ).toBeUndefined();
    expect(cascadedDeclaration(".user-bar .ub-avatar.speaking", "animation")).toBeUndefined();
  });

  it("keeps a moderator's mute on the single icon of a self-deafened user", () => {
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 82,
      username: "DeafAndModMuted",
      muted: true,
      deafened: true,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });
    sidebar.mount(container);

    const icons = container.querySelectorAll(".vu-muted");
    expect(icons.length).toBe(1);
    const icon = icons[0] as HTMLElement;
    expect(icon.classList.contains("vu-server-muted")).toBe(true);
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
      onOpenCall,
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
      onOpenCall,
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
      onOpenCall,
      onReorderChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // After mount with drag support, destroy should not throw
    sidebar.destroy?.();

    // Verify sidebar is removed
    expect(container.querySelector('[data-testid="channel-sidebar"]')).toBeNull();

    // Re-create for afterEach cleanup
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
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
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
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
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
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

  // The voice row has no hover/focus stream preview, for anyone.
  it("opens no stream preview when a voice row with video is hovered or focused", () => {
    vi.useFakeTimers();
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
    const row = container.querySelector<HTMLElement>(".voice-user-item")!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    row.dispatchEvent(new FocusEvent("focusin"));
    vi.advanceTimersByTime(1000);
    expect(container.querySelector(".vu-preview")).toBeNull();
    vi.useRealTimers();
  });

  // T20: Constant shared — sidebar uses SCREENSHARE_TILE_ID_OFFSET from constants
  it("uses shared SCREENSHARE_TILE_ID_OFFSET constant", async () => {
    // Verify the constant is imported and used by checking the offset value
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
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
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
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

  it("shows the session fingerprint, labelled as not an identity, on an unverified badge", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null, "5E55 1234 5678 9ABC");
    sidebar.mount(container);

    const title = badgeFor(10)!.getAttribute("title") ?? "";
    expect(title).toContain("5E55 1234 5678 9ABC");
    expect(title).toContain("not an identity");
  });

  it("refreshes the badge tooltip when a peer's session fingerprint changes at an unchanged status", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null, "5E55 1234 5678 9ABC");
    sidebar.mount(container);

    expect(badgeFor(10)!.getAttribute("title") ?? "").toContain("5E55 1234 5678 9ABC");

    // Peer reconnects: LiveKit E2EE re-announces a fresh ephemeral keypair,
    // producing a new session fingerprint while `status` stays "unverified".
    setPeerVerif(10, "unverified", null, "9C71 8888 4444 2222");
    voiceStore.flush();

    const title = badgeFor(10)!.getAttribute("title") ?? "";
    expect(title).toContain("9C71 8888 4444 2222");
    expect(title).not.toContain("5E55 1234 5678 9ABC");
  });

  it("shows the local user's own session fingerprint on their voice row", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 7, username: "Me", avatar: null, role: "member", status: "online" } as never,
      isAuthenticated: true,
    }));
    addVoiceUser(VOICE_CH, 7, "Me");
    voiceStore.setState((prev) => ({ ...prev, localSessionFingerprint: "0123 4567 89AB CDEF" }));
    sidebar.mount(container);

    const own = container.querySelector(`.voice-user-item[data-voice-uid="7"] .vu-session-fp`);
    expect(own).not.toBeNull();
    expect(own!.getAttribute("title")).toContain("0123 4567 89AB CDEF");
  });

  it("shows a new-device badge, not a plain verified one, after a new device key was accepted", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "changed", "AB12 CD34");
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("changed")).toBe(true);
    expect(badge!.getAttribute("title")).toContain("New device");
    expect(badge!.getAttribute("title")).toContain("AB12 CD34");
    expect(badge!.getAttribute("title")).not.toContain("Same key as before");
  });

  it("shows a mismatch badge for a blocked peer", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("mismatch")).toBe(true);
  });

  it("shows a distinct 'could not check' badge when the pin store was unreadable", () => {
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
    // The modal closes once the re-pin confirms (#22: it no longer closes
    // before the write is known to have succeeded).
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).toBeNull();
    });
  });

  // The user verifies the DISPLAYED fingerprint out of band, which takes human
  // time. A malicious server can push a user_update during that window; if
  // Trust re-read membersStore instead of using the captured key, the swapped
  // key would get pinned (TOCTOU).
  it("pins the displayed key, not one the server swapped in during the verification window", async () => {
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
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await vi.waitFor(() => {
      const btn = document.body.querySelector(".modal-overlay .btn-danger") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      return btn;
    });

    // Server mutates the peer's key while the modal is open and the human is
    // still comparing the fingerprint it displayed.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, { ...members.get(10)!, identityPublicKey: "attacker-swapped-key-b64" });
      return { ...prev, members };
    });

    trustBtn.click();

    expect(mockRePinPeerIdentity).toHaveBeenCalledWith(10, "alice-published-key-b64");
    expect(mockRePinPeerIdentity).not.toHaveBeenCalledWith(10, "attacker-swapped-key-b64");
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
    expectConsole("warn", /\[peer-verification\] E2EE: could not compute changed-key fingerprint/);
    trustBtn.click();

    expect(mockRePinPeerIdentity).not.toHaveBeenCalled();
    expect(document.body.querySelector(".modal-overlay")).toBeNull();
  });

  it("surfaces a failed re-pin instead of silently staying blocked (#22)", async () => {
    // rePinPeerIdentity returns false (rather than rejecting) when it could
    // not persist the new pin; the caller used to ignore that boolean, so
    // "Trust New Key" closed the modal and the peer stayed blocked silently.
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
    mockRePinPeerIdentity.mockResolvedValueOnce(false);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await vi.waitFor(() => {
      const btn = document.body.querySelector(".modal-overlay .btn-danger") as HTMLButtonElement;
      expect(btn).not.toBeNull();
      return btn;
    });
    trustBtn.click();

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't"), "error");
    });
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

// ── Identity-mismatch modal must not be bound to the per-render signal (OC-0281) ──
//
// openIdentityMismatchModal used to receive renderChannels()'s render-scoped
// AbortSignal (aborted and replaced on EVERY re-render), not the sidebar's own
// lifetime signal. That means any unrelated re-render -- a message landing in
// another channel, a voice peer toggling mute, the WS flipping to
// reconnecting -- tears the open re-pin prompt down, and a re-render landing
// during the async fingerprint compute makes the click a silent no-op.
describe("ChannelSidebar identity-mismatch modal lifetime", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  const VOICE_CH = 3; // "voice-lobby" in testChannels

  beforeEach(() => {
    resetStores();
    setChannels(testChannels);
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  function badgeFor(userId: number): HTMLElement | null {
    return container.querySelector(`.voice-user-item[data-voice-uid="${userId}"] .vu-verify`);
  }

  it("keeps the mismatch modal open across a sidebar re-render unrelated to the modal", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
    });

    // Unrelated re-render, the same shape as a message landing in another
    // channel (dispatcher -> incrementUnread -> new channels Map ->
    // renderChannels()). Nothing about the open modal should care.
    setChannels(testChannels);
    channelsStore.flush();

    expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
  });

  it("still opens the mismatch modal when an unrelated re-render lands during the fingerprint compute", async () => {
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
    sidebar.mount(container);

    // Hold the fingerprint compute open so a re-render can land mid-flight.
    let resolveFingerprint: (v: string) => void = () => {};
    (computeKeyFingerprint as any).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFingerprint = resolve;
        }),
    );

    (badgeFor(10) as HTMLElement).click();

    // Let the click's async handler actually reach the (held-open) fingerprint
    // compute before landing the re-render, so the re-render provably lands
    // mid-flight rather than before the compute even started.
    await vi.waitFor(() => {
      expect(computeKeyFingerprint).toHaveBeenCalled();
    });

    // Unrelated re-render lands while the click's async fingerprint compute
    // is still in flight.
    setChannels(testChannels);
    channelsStore.flush();

    resolveFingerprint("FEED FACE 1234 5678");

    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
    });
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
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
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

  describe("private channel lock", () => {
    const lock = (id: number): Element | null =>
      container.querySelector(`[data-testid='channel-private-${id}']`);

    it("shows on text, announcement and voice rows, with a title and aria-label", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: true },
        { id: 2, name: "news", type: "announcement", category: "Text", position: 1, private: true },
        { id: 3, name: "war-room", type: "voice", category: "Voice", position: 0, private: true },
      ]);
      sidebar.mount(container);

      for (const id of [1, 2, 3]) {
        const badge = lock(id);
        expect(badge).not.toBeNull();
        expect(badge?.getAttribute("title")).toBe("Private channel");
        expect(badge?.getAttribute("aria-label")).toBe("Private channel");
        expect(badge?.querySelector("svg")).not.toBeNull();
      }
    });

    it("is not inside the aria-hidden glyph, so it stays announced", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: true },
      ]);
      sidebar.mount(container);

      expect(lock(1)?.closest("[aria-hidden='true']")).toBeNull();
    });

    it("is absent on a non-private row and on a row from an older server", () => {
      setChannels([
        { id: 1, name: "a", type: "text", category: "Text", position: 0, private: false },
        { id: 2, name: "b", type: "text", category: "Text", position: 1 },
        { id: 3, name: "c", type: "voice", category: "Voice", position: 0 },
      ]);
      sidebar.mount(container);

      expect(lock(1)).toBeNull();
      expect(lock(2)).toBeNull();
      expect(lock(3)).toBeNull();
    });

    it("coexists with the nsfw marker and the voice capacity badge", () => {
      setChannels([
        {
          id: 1,
          name: "staff",
          type: "text",
          category: "Text",
          position: 0,
          private: true,
          nsfw: true,
        },
        {
          id: 5,
          name: "war-room",
          type: "voice",
          category: "Voice",
          position: 0,
          private: true,
          nsfw: true,
          voice_max_users: 5,
        },
      ]);
      sidebar.mount(container);

      expect(lock(1)).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-nsfw-1']")).not.toBeNull();
      expect(lock(5)).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-nsfw-5']")).not.toBeNull();
      expect(container.querySelector("[data-testid='channel-capacity-5']")).not.toBeNull();
    });

    it("redraws the row live when a channel_create flips the flag, both ways", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: false },
      ]);
      sidebar.mount(container);
      expect(lock(1)).toBeNull();

      addChannel({
        id: 1,
        name: "staff",
        type: "text",
        category: "Text",
        position: 0,
        private: true,
      });

      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      // An older-server frame without the key keeps the lock.
      addChannel({ id: 1, name: "staff", type: "text", category: "Text", position: 0 });
      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      addChannel({
        id: 1,
        name: "staff",
        type: "text",
        category: "Text",
        position: 0,
        private: false,
      });

      channelsStore.flush();
      expect(lock(1)).toBeNull();
    });

    it("redraws the row live when a channel_update flips the flag", () => {
      setChannels([
        { id: 1, name: "staff", type: "text", category: "Text", position: 0, private: false },
      ]);
      sidebar.mount(container);

      updateChannel({ id: 1, private: true });

      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      updateChannel({ id: 1, name: "staff-room" });

      channelsStore.flush();
      expect(lock(1)).not.toBeNull();

      updateChannel({ id: 1, private: false });

      channelsStore.flush();
      expect(lock(1)).toBeNull();
    });
  });

  describe("AFK channel marker", () => {
    const afkTestId = "[data-testid='channel-afk-5']";

    it("shows a moon and an AFK label on the AFK channel only", () => {
      setChannels([
        { id: 5, name: "parking", type: "voice", category: "Voice", position: 0, afk: true },
        { id: 6, name: "lounge", type: "voice", category: "Voice", position: 1 },
      ]);
      sidebar.mount(container);

      const badge = container.querySelector(afkTestId);
      expect(badge?.textContent).toBe("AFK");
      expect(badge?.querySelector("svg")?.getAttribute("data-icon")).toBe("moon");
      expect(container.querySelector("[data-testid='channel-afk-6']")).toBeNull();
    });

    it("appears and disappears in place when the flag changes", () => {
      setChannels([{ id: 5, name: "parking", type: "voice", category: "Voice", position: 0 }]);
      sidebar.mount(container);
      expect(container.querySelector(afkTestId)).toBeNull();
      const wrapper = container.querySelector("[data-testid='channel-5']")!.parentElement;

      updateChannel({ id: 5, afk: true });
      channelsStore.flush();
      expect(container.querySelector(afkTestId)?.textContent).toBe("AFK");
      expect(container.querySelector("[data-testid='channel-5']")!.parentElement).toBe(wrapper);

      updateChannel({ id: 5, afk: false });
      channelsStore.flush();
      expect(container.querySelector(afkTestId)).toBeNull();
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
      onOpenCall: vi.fn(),
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

// ── Per-row listeners must not outlive the render that created them (OC-0229) ──
//
// A row's listeners (context menu, drag handlers, ...) must never be registered
// on the sidebar's single factory-lifetime AbortSignal, which only aborts once,
// in destroy(): that signal's "abort" algorithm list is what actually keeps a
// DOM node alive in a browser once addEventListener({ signal }) has been called
// on it, so a detached row whose listener is still on that signal is retained
// for the sidebar's entire lifetime.
//
// B9-21 keys the list, so an unchanged row is now REUSED across a re-render
// instead of being detached and rebuilt. A replaced row (its signature changed)
// must still be disposed before it detaches, or the old leak returns for that
// row. This pins both halves of the keyed contract: identity is kept for an
// unchanged row, and the listeners of a replaced one die with it.
describe("ChannelSidebar row listeners across re-renders", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
  });

  it("reuses an unchanged row's node across a re-render (no detach, no relisten)", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const row = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(row).not.toBeNull();

    // Provoke renderChannels() the same way incrementUnread does for every
    // message delivered to a non-active channel: a fresh channels Map with
    // fresh Channel object references flows through the `s.channels`
    // selector, which is not shallow-equal to the previous one.
    setChannels(testChannels);
    channelsStore.flush();

    // The row is unchanged, so the keyed list reuses the node; its context
    // menu still works and was never re-registered.
    const after = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(after).toBe(row);
    expect(after.isConnected).toBe(true);
    after.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
  });

  it("reorders rows live when a channel_update changes only a position", () => {
    setChannels(testChannels);
    sidebar.mount(container);
    const order = () =>
      Array.from(container.querySelectorAll(".category-channels-container .channel-item"))
        .map((el) => (el as HTMLElement).dataset.channelId)
        .filter((id) => id === "1" || id === "2");
    expect(order()).toEqual(["1", "2"]);

    updateChannel({ id: 1, position: 5 });
    channelsStore.flush();

    expect(order()).toEqual(["2", "1"]);
  });

  it("disposes a replaced row so its context-menu listener cannot fire again", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const staleRow = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(staleRow).not.toBeNull();

    // Rename channel 1: its signature changes, so the keyed list replaces the
    // node instead of reusing it.
    setChannels(testChannels.map((c) => (c.id === 1 ? { ...c, name: "renamed" } : c)));
    channelsStore.flush();

    const freshRow = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(freshRow).not.toBeNull();
    expect(freshRow).not.toBe(staleRow);
    expect(staleRow.isConnected).toBe(false);

    // The replaced, detached row must not still be able to open a menu -- if
    // it does, its listener is still registered (on a signal that only aborts
    // at sidebar destroy()), which is the retention this finding is about.
    staleRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();

    // The replacement row works normally.
    freshRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
    );
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
  });
});

// ── Sidebar popovers must not close on an unrelated re-render (OC-0282) ──
//
// The channel context menu and the voice-user volume/moderation menu bridge
// their "close if the sidebar goes away" listener onto renderChannels()'s
// render-scoped AbortSignal, not the sidebar's own lifetime signal. Since
// renderChannels() aborts and replaces that signal on EVERY re-render, an
// open popover is torn down by events that have nothing to do with it -- a
// message in another channel, a peer toggling their mic, a category
// collapsing.
describe("ChannelSidebar popovers survive unrelated re-renders", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu, .user-vol-menu").forEach((el) => el.remove());
  });

  it("keeps the channel context menu open across a re-render unrelated to the menu", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    expect(document.querySelector('[data-testid="channel-context-menu"]')).not.toBeNull();

    // Unrelated re-render, the same shape as a message landing in another
    // channel (dispatcher -> incrementUnread -> new channels Map ->
    // renderChannels()). The open menu has nothing to do with this.
    setChannels(testChannels);
    channelsStore.flush();

    expect(document.querySelector('[data-testid="channel-context-menu"]')).not.toBeNull();
  });

  it("keeps the voice-user volume menu open when an unrelated peer's voice state changes", async () => {
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

    const voiceRow = container.querySelector(
      '.voice-user-item[data-voice-uid="80"]',
    ) as HTMLElement;
    voiceRow.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 150, clientY: 250 }),
    );
    await vi.dynamicImportSettled();
    expect(document.querySelector(".user-vol-menu")).not.toBeNull();

    // Unrelated re-render: a DIFFERENT peer joins/toggles state in the same
    // channel, firing the voice store's structural-signature subscription.
    updateVoiceState({
      channel_id: 3,
      user_id: 81,
      username: "AnotherUser",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    expect(document.querySelector(".user-vol-menu")).not.toBeNull();
  });
});

// ── Voice rows drawn from row models (5.4c-2) ──
//
// The voice rows reconcile from VoiceUserRowModel / VoiceChannelChromeModel,
// kept current by one select over their stores. A row's node is kept unless
// something it draws changed; these pin which changes keep or rebuild which
// node, and where focus goes when its row goes.
describe("ChannelSidebar voice rows on models", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  const VOICE_CH = 3; // "voice-lobby" in testChannels

  function member(id: number, username: string, displayName?: string) {
    return {
      id,
      username,
      ...(displayName !== undefined ? { displayName } : {}),
      avatar: null,
      role: "member",
      status: "online" as const,
    };
  }

  function setMembersMap(list: ReturnType<typeof member>[]): void {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map(list.map((m) => [m.id, m] as const)),
    }));
  }

  function userRow(userId: number): HTMLElement | null {
    return container.querySelector<HTMLElement>(`.voice-user-item[data-voice-uid="${userId}"]`);
  }

  function wrapperOf(channelId: number): HTMLElement | null {
    return (
      container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${channelId}"]`)
        ?.parentElement ?? null
    );
  }

  function leave(channelId: number, userId: number): void {
    removeVoiceUser({ channel_id: channelId, user_id: userId });
    voiceStore.flush();
  }

  it("a peer whose status flips to mismatch after mount gets a working badge click", async () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "verified", "AB12 CD34 EF56 7890");
    sidebar.mount(container);
    const before = userRow(10)!;
    expect(before.querySelector(".vu-verify.verified")).not.toBeNull();

    setPeerVerif(10, "mismatch", null);
    voiceStore.flush();

    const after = userRow(10)!;
    expect(after).not.toBe(before);
    expect(after.querySelector(".vu-verify.verified")).toBeNull();
    (after.querySelector(".vu-verify.mismatch") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
    });
  });

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    mockGetUserLocalMute.mockImplementation(() => false);
  });

  it("rename mid-call updates the label", () => {
    setChannels(testChannels);
    setMembersMap([member(10, "alice", "Alice"), member(11, "bob", "Bob")]);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    expect(userRow(10)!.querySelector(".vu-name")!.textContent).toBe("Alice");
    const other = userRow(11);
    const revision = membersStore.getState().roleRevision;

    // A new display name in the member store alone: no roleRevision bump and
    // no voice store change.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, member(10, "alice", "Alicia"));
      return { ...prev, members };
    });
    membersStore.flush();

    expect(membersStore.getState().roleRevision).toBe(revision);
    expect(userRow(10)!.querySelector(".vu-name")!.textContent).toBe("Alicia");
    expect(userRow(11)).toBe(other);
  });

  it("focused user row survives another user joining", () => {
    setChannels(testChannels.map((c) => (c.id === VOICE_CH ? { ...c, voice_max_users: 5 } : c)));
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    const focusedRow = userRow(11)!;
    focusedRow.focus();
    expect(document.activeElement).toBe(focusedRow);

    addVoiceUser(VOICE_CH, 12, "carol");
    voiceStore.flush();

    // The capacity readout is a chrome patch: the wrapper and the focused row
    // are kept, and focus never moves.
    expect(
      container.querySelector(`[data-testid="channel-capacity-${VOICE_CH}"]`)!.textContent,
    ).toBe("3/5");
    expect(wrapperOf(VOICE_CH)).toBe(wrapper);
    expect(userRow(11)).toBe(focusedRow);
    expect(document.activeElement).toBe(focusedRow);
  });

  it("focused user row survives a voice channel rename", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    userRow(11)!.focus();

    setChannels(testChannels.map((c) => (c.id === VOICE_CH ? { ...c, name: "hangout" } : c)));
    channelsStore.flush();

    // The wrapper is rebuilt (its signature changed); focus follows the key
    // path to the same participant in the replacement.
    expect(wrapperOf(VOICE_CH)).not.toBe(wrapper);
    expect(document.activeElement).toBe(userRow(11));
  });

  it("a focused user who leaves hands focus to the next participant, else the channel row", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    addVoiceUser(VOICE_CH, 12, "carol");
    sidebar.mount(container);

    // The participant now at the leaver's position.
    userRow(11)!.focus();
    leave(VOICE_CH, 11);
    expect(document.activeElement).toBe(userRow(12));

    // The last one leaving: the participant before them.
    leave(VOICE_CH, 12);
    expect(document.activeElement).toBe(userRow(10));

    // The channel empties: its own row.
    leave(VOICE_CH, 10);
    expect(container.querySelector(".voice-users-list")).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector(`.channel-item[data-channel-id="${VOICE_CH}"]`),
    );
  });

  it("a focused participant whose channel stops showing hands focus to the category", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Voice Channels"]),
    }));
    sidebar.mount(container);
    userRow(10)!.focus();

    // Collapsed, the channel shows only while occupied: emptied, it hides.
    leave(VOICE_CH, 10);

    expect(container.querySelector(`.channel-item[data-channel-id="${VOICE_CH}"]`)).toBeNull();
    const arrow = container.querySelector<HTMLElement>(
      '.category[data-category="Voice Channels"] .category-arrow',
    );
    expect(document.activeElement).toBe(arrow);
  });

  it("local mute event redraws only that user's row", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 82, "loud");
    addVoiceUser(VOICE_CH, 83, "quiet");
    sidebar.mount(container);
    const loud = userRow(82);
    const quiet = userRow(83);

    mockGetUserLocalMute.mockImplementation((id) => id === 82);
    window.dispatchEvent(
      new CustomEvent("owncord:user-local-mute-changed", { detail: { userId: 82 } }),
    );

    expect(userRow(82)).not.toBe(loud);
    expect(userRow(82)!.querySelector(".vu-local-muted")).not.toBeNull();
    expect(userRow(83)).toBe(quiet);
    expect(userRow(83)!.querySelector(".vu-local-muted")).toBeNull();
  });

  it("connection drop disables the channel without rebuilding user rows", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    const rows = [userRow(10), userRow(11)];

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" as const }));
    uiStore.flush();

    const item = container.querySelector<HTMLElement>(
      `.channel-item[data-channel-id="${VOICE_CH}"]`,
    )!;
    expect(item.classList.contains("disabled")).toBe(true);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.title).toBe("Reconnecting…");
    expect(wrapperOf(VOICE_CH)).toBe(wrapper);
    expect([userRow(10), userRow(11)]).toEqual(rows);
    expect(userRow(10)).toBe(rows[0]);
    expect(userRow(11)).toBe(rows[1]);
  });

  it("draggable follows connection status", () => {
    sidebar.destroy?.();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Me", avatar: null, role: "admin" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onVoiceModerate: voiceModCallbacks(),
    });
    setChannels(
      testChannels.map((c) => ({ ...c, can_moderate_voice: true, can_move_voice: true })),
    );
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 99, "Me");
    sidebar.mount(container);
    const draggable = (id: number) => userRow(id)!.classList.contains("voice-user-draggable");
    expect(draggable(10)).toBe(true);
    expect(draggable(99)).toBe(false);

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" as const }));
    uiStore.flush();
    expect(draggable(10)).toBe(false);

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" as const }));
    uiStore.flush();
    expect(draggable(10)).toBe(true);
    expect(draggable(99)).toBe(false);
  });

  it("a click on the channel after joining opens the call", () => {
    setChannels(testChannels);
    sidebar.mount(container);
    const item = () =>
      container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${VOICE_CH}"]`)!;
    const first = item();
    first.click();
    expect(onVoiceJoin).toHaveBeenCalledWith(VOICE_CH);
    expect(onOpenCall).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: VOICE_CH }));
    voiceStore.flush();

    // The wrapper is reused (joined is a chrome patch), so the click reads
    // the joined channel when it fires, not when the row was built.
    expect(item()).toBe(first);
    expect(first.classList.contains("active")).toBe(true);
    first.click();
    expect(onOpenCall).toHaveBeenCalledTimes(1);
    expect(onVoiceJoin).toHaveBeenCalledTimes(1);
  });

  it("presence change of a member not in voice keeps every voice row node", () => {
    setChannels(testChannels);
    setMembersMap([member(10, "alice"), member(11, "bob"), member(50, "away")]);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    const rows = [userRow(10), userRow(11)];

    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(50, { ...member(50, "away"), status: "idle" as const });
      return { ...prev, members };
    });
    membersStore.flush();

    expect(wrapperOf(VOICE_CH)).toBe(wrapper);
    expect(userRow(10)).toBe(rows[0]);
    expect(userRow(11)).toBe(rows[1]);
  });

  it("speaking toggle keeps the same row node, its focus and a class another module set", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 60, "talker");
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: VOICE_CH }));
    sidebar.mount(container);
    const row = userRow(60)!;
    row.focus();
    // dragMove marks the live row it is dragging.
    row.classList.add("dragging");

    setSpeakers({ channel_id: VOICE_CH, speakers: [60] });
    voiceStore.flush();
    expect(userRow(60)).toBe(row);
    expect(row.classList.contains("speaking")).toBe(true);

    setSpeakers({ channel_id: VOICE_CH, speakers: [] });
    voiceStore.flush();
    expect(userRow(60)).toBe(row);
    expect(row.classList.contains("speaking")).toBe(false);
    expect(row.classList.contains("dragging")).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("a reconnect replacing the voice state keeps unchanged rows and redraws a changed fingerprint", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    setPeerVerif(10, "unverified", null, "AAAA 1111");
    setPeerVerif(11, "unverified", null, "BBBB 2222");
    sidebar.mount(container);
    const alice = userRow(10);
    const bob = userRow(11);

    // ready replaces both maps with fresh objects; only bob's fingerprint differs.
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map(
        Array.from(prev.voiceUsers, ([ch, users]) => [
          ch,
          new Map(Array.from(users, ([uid, u]) => [uid, { ...u }] as const)),
        ]),
      ),
      peerVerifications: new Map([
        [
          10,
          { userId: 10, status: "unverified", safetyNumber: null, sessionFingerprint: "AAAA 1111" },
        ],
        [
          11,
          { userId: 11, status: "unverified", safetyNumber: null, sessionFingerprint: "CCCC 3333" },
        ],
      ]),
    }));
    voiceStore.flush();

    expect(userRow(10)).toBe(alice);
    expect(userRow(11)).not.toBe(bob);
    const title = userRow(11)!.querySelector(".vu-verify")!.getAttribute("title") ?? "";
    expect(title).toContain("CCCC 3333");
    expect(title).not.toContain("BBBB 2222");
  });
});

// ── Text rows and groups drawn from row models (5.4d-1) ──
//
// The text rows and category groups reconcile from models, so a row's node is
// kept unless something it draws changed. The row's handlers are bound from
// the model too (`access`, `orderIds`), so a role edit rebinds them.
describe("ChannelSidebar text rows and groups on models", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  const VOICE_CH = 3; // "voice-lobby" in testChannels

  function row(channelId: number): HTMLElement | null {
    return container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${channelId}"]`);
  }

  function ctxMenuFor(channelId: number): HTMLElement | null {
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    row(channelId)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    return document.querySelector<HTMLElement>('[data-testid="channel-context-menu"]');
  }

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

  it("an unread count change keeps the focused row's node", () => {
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    setChannels(testChannels); // channel 1 starts with 2 unread
    sidebar.mount(container);
    const focused = row(1)!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    expect(focused.classList.contains("unread")).toBe(true);

    incrementUnread(1);
    channelsStore.flush();

    // 2 -> 3: the row looks the same, so the node, its focus and its roving
    // tab stop are untouched (it used to be rebuilt and refocused by key).
    expect(channelsStore.getState().channels.get(1)!.unreadCount).toBe(3);
    expect(row(1)).toBe(focused);
    expect(document.activeElement).toBe(focused);
    expect(focused.getAttribute("tabindex")).toBe("0");
  });

  it("a change that flips how the row looks rebuilds it and focus follows", () => {
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    setChannels(testChannels); // channel 2 starts read
    sidebar.mount(container);
    const before = row(2)!;
    before.focus();
    expect(before.classList.contains("unread")).toBe(false);

    incrementUnread(2);
    channelsStore.flush();

    const after = row(2)!;
    expect(after).not.toBe(before);
    expect(after.classList.contains("unread")).toBe(true);
    expect(document.activeElement).toBe(after);
  });

  it("a MANAGE_MESSAGES-only role edit rebinds every text row's menu and keeps voice focus", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: 0 }]);
    authStore.setState(() => ({
      token: "tok",
      user: { id: 3, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn(), onPurgeChannel });
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);

    const textIds = [1, 2, 4];
    for (const id of textIds) {
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
    }
    const voiceWrapper = row(VOICE_CH)!.parentElement;
    const participant = container.querySelector<HTMLElement>(
      '.voice-user-item[data-voice-uid="11"]',
    )!;
    participant.focus();
    expect(document.activeElement).toBe(participant);

    // Only the permission mask changes: no channel, voice or role-name event.
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_MESSAGES }]);
    channelsStore.flush();

    for (const id of textIds) {
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      expect(
        document.querySelector('[data-testid="ctx-purge-messages"]'),
        `Purge on ${id}`,
      ).not.toBeNull();
    }
    // The voice wrapper rebound too (a rebuild), and focus followed the key.
    expect(row(VOICE_CH)!.parentElement).not.toBe(voiceWrapper);
    expect(document.activeElement).toBe(
      container.querySelector('.voice-user-item[data-voice-uid="11"]'),
    );
  });

  function setModeratorMask(permissions: number): void {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions }]);
    channelsStore.flush();
  }

  function useModerator(): void {
    authStore.setState(() => ({
      token: "tok",
      user: { id: 3, username: "Mod", avatar: null, role: "moderator" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
  }

  it("a MANAGE_INVITES-only role edit grants and revokes Invite People on text and voice rows", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: 0 }]);
    useModerator();
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onInviteFromChannel: vi.fn(),
    });
    setChannels(testChannels);
    sidebar.mount(container);
    const invite = (): Element | null =>
      document.querySelector('[data-testid="ctx-invite-people"]');

    for (const id of [1, VOICE_CH]) {
      ctxMenuFor(id);
      expect(invite(), `no invite on ${id}`).toBeNull();
    }

    // Only the permission mask changes: no channel, voice or role-name event.
    setModeratorMask(Permission.MANAGE_INVITES);
    for (const id of [1, VOICE_CH]) {
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      expect(invite(), `invite on ${id}`).not.toBeNull();
    }

    setModeratorMask(0);
    for (const id of [1, VOICE_CH]) {
      ctxMenuFor(id);
      expect(invite(), `invite gone on ${id}`).toBeNull();
    }
  });

  it("losing MANAGE_CHANNELS while mounted strips drag and the Edit, Delete and Move entries", () => {
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    useModerator();
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onReorderChannel: vi.fn(),
      onEditChannel: vi.fn(),
      onDeleteChannel: vi.fn(),
    });
    setChannels(testChannels);
    sidebar.mount(container);
    const ids = [1, 2, VOICE_CH];
    const testIds = [
      "ctx-edit-channel",
      "ctx-delete-channel",
      "ctx-move-up",
      "ctx-move-down",
    ] as const;

    for (const id of ids) {
      if (id !== VOICE_CH) {
        expect(row(id)!.classList.contains("channel-draggable"), `draggable ${id}`).toBe(true);
        expect(row(id)!.hasAttribute("data-drag-channel-id"), `drag id ${id}`).toBe(true);
      }
      expect(ctxMenuFor(id), `menu ${id}`).not.toBeNull();
      for (const t of testIds) {
        expect(document.querySelector(`[data-testid="${t}"]`), `${t} on ${id}`).not.toBeNull();
      }
    }

    // Only the permission mask changes: no channel, voice or role-name event.
    setModeratorMask(0);

    expect(container.querySelector(".channel-draggable")).toBeNull();
    expect(container.querySelector("[data-drag-channel-id]")).toBeNull();
    for (const id of ids) {
      ctxMenuFor(id);
      for (const t of testIds) {
        expect(document.querySelector(`[data-testid="${t}"]`), `${t} gone on ${id}`).toBeNull();
      }
    }
  });

  it("a voice capacity edit patches the label and keeps the wrapper", () => {
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    const withMax = (max: number): ReadyChannel[] =>
      testChannels.map((c) => (c.id === VOICE_CH ? { ...c, voice_max_users: max } : c));
    setChannels(withMax(5));
    addVoiceUser(VOICE_CH, 10, "alice");
    sidebar.mount(container);
    const wrapper = row(VOICE_CH)!.parentElement;
    const label = (): string | null | undefined =>
      container.querySelector(`[data-testid="channel-capacity-${VOICE_CH}"]`)?.textContent;
    expect(label()).toBe("1/5");

    setChannels(withMax(8));
    channelsStore.flush();

    expect(label()).toBe("1/8");
    expect(row(VOICE_CH)!.parentElement).toBe(wrapper);
  });

  it("an edit action acts on the live channel, not the one the row was built for", () => {
    const onEditChannel = vi.fn<(channel: Channel) => void>();
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn(), onEditChannel });
    setChannels(testChannels);
    sidebar.mount(container);
    const before = row(2)!;

    // A topic edit is not drawn, so the row is kept; its Edit must still
    // hand over the current channel.
    updateChannel({ id: 2, topic: "new topic" });
    channelsStore.flush();
    expect(row(2)).toBe(before);

    expect(ctxMenuFor(2)).not.toBeNull();
    document.querySelector<HTMLElement>('[data-testid="ctx-edit-channel"]')!.click();
    expect(onEditChannel).toHaveBeenCalledTimes(1);
    expect(onEditChannel.mock.calls[0]![0]).toMatchObject({ id: 2, topic: "new topic" });
  });
});

describe("ChannelSidebar on one select", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  const text = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
    id,
    name: `text-${id}`,
    type: "text",
    category: "Text Channels",
    position: id,
    unread_count: 0,
    last_message_id: 1,
    ...extra,
  });
  const rowIds = (): string[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".channel-item")).map(
      (el) => el.dataset.channelId ?? "",
    );
  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${id}"]`);

  beforeEach(() => {
    resetStores();
    // Mutes persist across tests; start with none.
    unmuteChannel(1);
    unmuteChannel(2);
    invalidateMuteCache();
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    vi.restoreAllMocks();
  });

  it("a muted channel that gains a mention under a collapsed category shows with its badge, and keeps it when expanded", () => {
    setChannels([text(1), text(2)]);
    muteChannel(2);
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set(["Text Channels"]) }));
    sidebar.mount(container);
    expect(rowIds()).toEqual([]);

    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(2, { ...channels.get(2)!, unreadCount: 1, mentionCount: 1 });
      return { ...prev, channels };
    });
    channelsStore.flush();
    expect(rowIds()).toEqual(["2"]);
    expect(row(2)!.querySelector(".mention-badge")?.textContent).toBe("1");
    const badgeText = row(2)!.textContent;

    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set<string>() }));
    uiStore.flush();
    expect(rowIds()).toEqual(["1", "2"]);
    expect(row(2)!.textContent).toBe(badgeText);
    expect(row(2)!.querySelector(".mention-badge")?.textContent).toBe("1");
  });

  it("mount subscribes only through select", () => {
    const stores = [voiceStore, membersStore, authStore, channelsStore, uiStore, safetyStore];
    const subscribe = stores.map((s) => vi.spyOn(s, "subscribe"));
    const selector = stores.map((s) => vi.spyOn(s, "subscribeSelector"));
    setChannels([text(1)]);

    sidebar.mount(container);

    for (const spy of selector) expect(spy).not.toHaveBeenCalled();
    for (const spy of subscribe) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("muting through muteChannel ends with the row muted", () => {
    setChannels([text(1), text(2)]);
    sidebar.mount(container);
    expect(row(2)!.classList.contains("muted")).toBe(false);

    muteChannel(2);

    expect(row(2)!.classList.contains("muted")).toBe(true);
  });

  it("a mute pref-change alone does not redraw; the mute announcement does", () => {
    setChannels([text(1), text(2)]);
    sidebar.mount(container);
    const before = row(2)!;
    expect(before.classList.contains("muted")).toBe(false);

    // Write the list the way writeMuted saves it (a bare id is a forever mute),
    // then drop the cache the module's own pref-change listener would drop.
    const key =
      getChannelMutesHost() === null ? "mutedChannels" : `mutedChannels:${getChannelMutesHost()}`;
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify([2]));
    invalidateMuteCache();
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key } }));

    expect(row(2)).toBe(before);
    expect(row(2)!.classList.contains("muted")).toBe(false);

    window.dispatchEvent(new CustomEvent(CHANNEL_MUTE_CHANGED, { detail: { channelId: 2 } }));

    expect(row(2)!.classList.contains("muted")).toBe(true);
  });

  it("destroy then a store change touches no row", () => {
    setChannels([text(1), text(2)]);
    sidebar.mount(container);
    const first = row(1)!;
    const second = row(2)!;
    const observer = new MutationObserver(() => {});
    observer.observe(first, { attributes: true, childList: true, subtree: true });
    observer.observe(second, { attributes: true, childList: true, subtree: true });
    const nameBefore = container.querySelector("h2");

    sidebar.destroy?.();
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    channelsStore.flush();
    setRoles([{ id: 9, name: "x", color: null, permissions: 0 }]);
    channelsStore.flush();
    authStore.setState((prev) => ({ ...prev, serverName: "Renamed" }));
    authStore.flush();
    window.dispatchEvent(new CustomEvent("owncord:channel-mute-changed"));
    muteChannel(1);

    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(container.querySelector(".channel-sidebar")).toBeNull();
    expect(nameBefore?.textContent).toBe("Test Server");
  });
});
