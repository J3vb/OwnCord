/**
 * MainPage's activeChannelId subscriber (finding: a deleted/closed active
 * channel left its message list and composer mounted, because the
 * subscriber had no else branch to tear them down).
 *
 * MainPage.ts is excluded from unit coverage (vitest.config.ts) — it has
 * lots of heavy child components (SidebarArea, ChatArea, ChannelController)
 * that are extracted specifically to be independently testable, so those are
 * mocked out here and only the wiring under test (the store subscription) is
 * exercised for real.
 */
import { noteJoinFailed, noteJoinSucceeded } from "../../src/features/voice/joinBackoff";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// jsdom has no matchMedia; the lazily-loaded sidebar drawer reads its
// breakpoint from it. Wide: the drawer stays out of the way.
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => Object.assign(new EventTarget(), { matches: false, media: "" })),
);

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { capturedOnRemoteVideo } = vi.hoisted(() => ({
  capturedOnRemoteVideo: {
    current: null as null | ((userId: number, stream: MediaStream, isScreenshare: boolean) => void),
  },
}));

vi.mock("@lib/livekitSession", () => ({
  cleanupAll: vi.fn(),
  setOnRemoteVideo: vi.fn(
    (cb: (userId: number, stream: MediaStream, isScreenshare: boolean) => void) => {
      capturedOnRemoteVideo.current = cb;
    },
  ),
  setOnRemoteVideoRemoved: vi.fn(),
  clearOnRemoteVideo: vi.fn(),
  setWsClient: vi.fn(),
  setServerHost: vi.fn(),
  setOnError: vi.fn(),
  leaveVoice: vi.fn(),
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  enableCamera: vi.fn().mockResolvedValue(undefined),
  disableCamera: vi.fn().mockResolvedValue(undefined),
  enableScreenshare: vi.fn().mockResolvedValue(undefined),
  disableScreenshare: vi.fn().mockResolvedValue(undefined),
  getLocalCameraStream: vi.fn(() => null),
  getLocalScreenshareStream: vi.fn(() => null),
  getRemoteVideoStats: vi.fn().mockResolvedValue(null),
  getLocalScreenshareStats: vi.fn().mockResolvedValue({ sentFps: 57 }),
  setRemoteVideoView: vi.fn(),
}));

vi.mock("@lib/notificationSound", () => ({
  startRingChime: vi.fn(),
  stopRingChime: vi.fn(),
  startRingback: vi.fn(),
  stopRingback: vi.fn(),
  cleanupNotificationAudio: vi.fn(),
  playVoiceSound: vi.fn(),
}));

// DP-24: the OS-level call alerts are a lazy chunk the page loads on a ring;
// their own behaviour is call-alerts.test.ts's.
vi.mock("../../src/features/direct-messages/callAlerts", () => ({
  alertIncomingCall: vi.fn(),
  alertMissedCall: vi.fn(),
  alertSupersededCall: vi.fn(),
  clearIncomingCall: vi.fn(),
}));

const { mockSetAudioVolumeHost } = vi.hoisted(() => ({
  mockSetAudioVolumeHost: vi.fn(),
}));

// Real audioElements.ts pulls in livekit-client (unmocked elsewhere in this
// file's graph) purely to hold the AudioElements class this page never
// touches directly — mock out the one export MainPage actually calls.
const { mockCreateUpdateNotifier } = vi.hoisted(() => ({
  mockCreateUpdateNotifier: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));
vi.mock("@components/UpdateNotifier", () => ({
  createUpdateNotifier: mockCreateUpdateNotifier,
}));

vi.mock("@lib/audioElements", () => ({
  setAudioVolumeHost: mockSetAudioVolumeHost,
}));

const { capturedAutoIdleOptions, autoIdleController } = vi.hoisted(() => ({
  capturedAutoIdleOptions: {
    current: null as null | { onStatusChange: (status: string) => void },
  },
  autoIdleController: { destroy: vi.fn() },
}));

vi.mock("@lib/autoIdle", () => ({
  startAutoIdle: (options: { onStatusChange: (status: string) => void }) => {
    capturedAutoIdleOptions.current = options;
    return autoIdleController;
  },
}));

const {
  mockMountChannel,
  mockDestroyChannel,
  mockCreateChannelController,
  mockCreateSidebarArea,
  mockCreateChatArea,
  capturedChatAreaRef,
} = vi.hoisted(() => ({
  mockMountChannel: vi.fn(),
  mockDestroyChannel: vi.fn(),
  mockCreateChannelController: vi.fn(),
  mockCreateSidebarArea: vi.fn(),
  mockCreateChatArea: vi.fn(),
  // The ChatArea mock below builds fresh DOM elements per call (a plain
  // return value can't be read back from a vi.fn() call site) — this is how
  // tests get at the actual slots/dmProfileSlot MainPage is wiring against.
  capturedChatAreaRef: {
    current: null as null | {
      chatArea: HTMLDivElement;
      slots: {
        messagesSlot: HTMLDivElement;
        typingSlot: HTMLDivElement;
        inputSlot: HTMLDivElement;
        videoGridSlot: HTMLDivElement;
      };
      dmProfileSlot: HTMLDivElement;
      profileBtn: HTMLButtonElement;
      videoGrid: {
        addStream: ReturnType<typeof vi.fn>;
        removeStream: ReturnType<typeof vi.fn>;
        clearStreams: ReturnType<typeof vi.fn>;
        watch: ReturnType<typeof vi.fn>;
        hasStreams: ReturnType<typeof vi.fn>;
        setFocusedTile: ReturnType<typeof vi.fn>;
        getFocusedTileId: ReturnType<typeof vi.fn>;
        setLabel: ReturnType<typeof vi.fn>;
        setPeople: ReturnType<typeof vi.fn>;
        setSpeaking: ReturnType<typeof vi.fn>;
        setCallbacks: ReturnType<typeof vi.fn>;
        setCallState: ReturnType<typeof vi.fn>;
        ensureLoaded: ReturnType<typeof vi.fn>;
        setExitVisible: ReturnType<typeof vi.fn>;
        showMiniPlayer: ReturnType<typeof vi.fn>;
        hideMiniPlayer: ReturnType<typeof vi.fn>;
      };
    },
  },
}));

const { mockPruneAttachmentCacheScope } = vi.hoisted(() => ({
  mockPruneAttachmentCacheScope: vi.fn(async () => {}),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/message-list/attachments")>()),
  pruneAttachmentCacheScope: mockPruneAttachmentCacheScope,
}));

vi.mock("../../src/pages/main-page/ChannelController", () => ({
  createChannelController: (...args: unknown[]) => {
    mockCreateChannelController(...args);
    return {
      mountChannel: mockMountChannel,
      destroyChannel: mockDestroyChannel,
      destroy: () => mockDestroyChannel(),
      openFilePicker: vi.fn(),
      currentChannelId: 0,
      messageList: null,
    };
  },
}));

const { mockReturnToChannel, mockRememberChannel, mockRenameGroup, inertModeration, memberPanels } =
  vi.hoisted(() => ({
    mockReturnToChannel: vi.fn(),
    mockRenameGroup: vi.fn(),
    mockRememberChannel: vi.fn(),
    inertModeration: { signals: [] as AbortSignal[] },
    // Every member-list instance either host built, and how many were destroyed.
    memberPanels: { created: 0, destroyed: 0, events: [] as string[] },
  }));

vi.mock("../../src/pages/main-page/SidebarArea", () => ({
  createSidebarArea: (...args: unknown[]) => {
    mockCreateSidebarArea(...args);
    const sidebarWrapper = document.createElement("div");
    sidebarWrapper.className = "unified-sidebar";
    // One stand-in member list per panel: the factory both hosts share.
    const buildMemberPanel = () => {
      const element = document.createElement("div");
      element.dataset["testid"] = "member-list";
      memberPanels.created += 1;
      memberPanels.events.push("create");
      let destroyed = false;
      return {
        element,
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          memberPanels.destroyed += 1;
          memberPanels.events.push("destroy");
          element.remove();
        },
      };
    };
    // The left section as the real SidebarArea runs it: present in channels
    // mode with the "left" layout, added and removed in place.
    let leftPanel: ReturnType<typeof buildMemberPanel> | null = null;
    const syncMemberSection = () => {
      const left = localStorage.getItem("owncord:settings:memberListLayout") === '"left"';
      if (left && leftPanel === null) {
        leftPanel = buildMemberPanel();
        sidebarWrapper.appendChild(leftPanel.element);
      } else if (!left && leftPanel !== null) {
        leftPanel.destroy();
        leftPanel = null;
      }
    };
    syncMemberSection();
    return {
      sidebarWrapper,
      children: [],
      unsubscribers: [() => leftPanel?.destroy()],
      openQuickSwitch: vi.fn(),
      openDm: vi.fn(),
      rememberChannel: mockRememberChannel,
      forgetChannel: vi.fn(),
      returnToChannel: mockReturnToChannel,
      buildMemberPanel,
      syncMemberSection,
      renameGroup: mockRenameGroup,
    };
  },
}));

// B9-4: one inert destination, so the page's navigation wiring can be driven.
vi.mock("../../src/features/navigation/destinations", () => ({
  NAVIGATION_DESTINATIONS: {
    moderation: {
      build: (ctx: { signal: AbortSignal }) => {
        inertModeration.signals.push(ctx.signal);
        const el = document.createElement("div");
        el.dataset["testid"] = "inert-moderation";
        return el;
      },
    },
  },
}));

vi.mock("../../src/pages/main-page/ChatArea", () => ({
  createChatArea: (...args: unknown[]) => {
    mockCreateChatArea(...args);
    const slots = {
      messagesSlot: document.createElement("div"),
      typingSlot: document.createElement("div"),
      inputSlot: document.createElement("div"),
      videoGridSlot: document.createElement("div"),
    };
    const dmProfileSlot = document.createElement("div");
    const profileBtn = document.createElement("button");
    const videoGrid = {
      addStream: vi.fn(),
      removeStream: vi.fn(),
      clearStreams: vi.fn(),
      watch: vi.fn(),
      hasStreams: vi.fn(() => false),
      setFocusedTile: vi.fn(),
      getFocusedTileId: vi.fn(() => null),
      setLabel: vi.fn(),
      setPeople: vi.fn(),
      setSpeaking: vi.fn(),
      setCallbacks: vi.fn(),
      setCallState: vi.fn(),
      setExitVisible: vi.fn(),
      ensureLoaded: vi.fn(),
      showMiniPlayer: vi.fn(),
      hideMiniPlayer: vi.fn(),
      raiseCallPopout: vi.fn(() => false),
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const chatArea = document.createElement("div");
    const callPanelSlot = document.createElement("div");
    // The real chat column's order: the call panel, then the chat slots.
    chatArea.append(
      callPanelSlot,
      slots.messagesSlot,
      slots.typingSlot,
      slots.inputSlot,
      slots.videoGridSlot,
    );
    capturedChatAreaRef.current = { chatArea, slots, dmProfileSlot, profileBtn, videoGrid };
    return {
      chatArea,
      slots,
      callPanelSlot,
      threadSlot: document.createElement("div"),
      videoGrid,
      chatHeaderName: document.createElement("span"),
      chatHeaderRefs: {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        profileBtn,
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        sidebarToggle: document.createElement("button"),
      },
      sidebarToggle: document.createElement("button"),
      closePinnedPanel: vi.fn(),
      searchCtrl: { open: vi.fn(), cleanup: vi.fn() },
      dmProfileSlot,
      children: [],
      unsubscribers: [],
    };
  },
}));

import { savePref } from "../../src/lib/preferences";

// The remembered-open pref must never leak between tests, whatever their order.
afterEach(() => {
  localStorage.removeItem("owncord:settings:dmProfileOpen");
});
import { createMainPage } from "../../src/pages/MainPage";
import { channelsStore, setActiveChannel } from "../../src/stores/channels.store";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { wireConnectionStatus } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { voiceStore, updateVoiceUserProfile } from "../../src/stores/voice.store";
import { dmStore, updateDmParticipant } from "../../src/stores/dm.store";
import { membersStore, updateMemberProfile } from "../../src/stores/members.store";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ApiClient } from "../../src/lib/api";
import type { ServerMessage } from "../../src/lib/types";
import { Permission } from "../../src/lib/types";
import { openImageLightbox, renderYouTubeEmbed } from "../../src/components/message-list/media";
import { renderGenericLinkPreview } from "../../src/components/message-list/embeds";
import {
  externalPartition,
  fetchExternalImage,
} from "../../src/components/message-list/attachments";
import { desktop } from "../../src/platform/desktop";
import { SCREENSHARE_TILE_ID_OFFSET } from "../../src/lib/constants";
import { saveUserStatus } from "../../src/lib/userStatus";
import { markAllRead } from "../../src/lib/read-state";
import { startRingChime, startRingback, stopRingback } from "../../src/lib/notificationSound";
import {
  alertIncomingCall,
  alertMissedCall,
  alertSupersededCall,
} from "../../src/features/direct-messages/callAlerts";

function resetStores(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "alice", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected", settingsOpen: false }));
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
  }));
  dmStore.setState(() => ({ channels: [] }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map(), roleRevision: 0 }));
}

type FakeWsClient = WsClient & {
  /** Test-only: drive a registered `ws.on(type, ...)` listener directly. */
  emit: (type: ServerMessage["type"], payload: unknown, id?: string) => void;
};

/** The caller's voice join succeeding: startCall rings only after that. */
function finishCallJoin(): void {
  voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
  voiceStore.flush();
}

function fakeWs(): FakeWsClient {
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  return {
    ping: vi.fn(async () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(() => "id"),
    on<T extends ServerMessage["type"]>(type: T, listener: WsListener<T>) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener as unknown as WsListener<ServerMessage["type"]>);
      return () => {
        listeners.get(type)?.delete(listener as unknown as WsListener<ServerMessage["type"]>);
      };
    },
    emit(type: ServerMessage["type"], payload: unknown, id?: string) {
      for (const listener of listeners.get(type) ?? []) {
        (listener as (p: unknown, id?: string) => void)(payload, id);
      }
    },
    onStateChange: vi.fn(() => () => {}),
    onSendFailure: vi.fn(() => () => {}),
    onCertMismatch: vi.fn(() => () => {}),
    onCertFirstUse: vi.fn(() => () => {}),
    onServerBusy: vi.fn(() => () => {}),
    startCertListener: vi.fn(async () => {}),
    acceptCertFingerprint: vi.fn(async () => {}),
    getConnectFailureCode: vi.fn(() => null),
    getState: vi.fn(() => "connected" as ConnectionState),
    _getWs: vi.fn(() => null),
  };
}

function fakeApi(host = ""): ApiClient {
  return {
    getConfig: () => ({ host }),
    getSession: () => ({ signal: new AbortController().signal }),
    getReactionUsers: vi.fn(async () => ({ users: [] })),
    getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
    getSessions: vi.fn(async () => []),
  } as unknown as ApiClient;
}

function textChannel(id: number, name: string, position = 0) {
  return {
    id,
    name,
    type: "text" as const,
    category: null,
    position,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    topic: "",
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

describe("MainPage — activeChannelId subscriber", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    mockMountChannel.mockClear();
    mockDestroyChannel.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
  });

  it("mounts the channel when an active channel is set", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    expect(mockMountChannel).toHaveBeenCalledWith(1, "general", "text");
  });

  it("destroys the mounted channel when the active channel is cleared (deleted/closed while offline)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    expect(mockMountChannel).toHaveBeenCalledWith(1, "general", "text");

    // The channel is gone and nothing replaces it as active — this is what
    // dispatcher.ts's ready handler now does when the previously-active
    // channel is absent from a fresh snapshot.
    setActiveChannel(null);
    channelsStore.flush();

    expect(mockDestroyChannel).toHaveBeenCalledOnce();
  });

  it("mounts the newly active channel when switching between two channels", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      ch.set(2, textChannel(2, "random", 1));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    setActiveChannel(2);
    channelsStore.flush();

    expect(mockMountChannel).toHaveBeenCalledWith(2, "random", "text");
    // Switching to a real channel remounts rather than destroying.
    expect(mockDestroyChannel).not.toHaveBeenCalled();
  });
});

function dmChannel(id: number, name: string, position = 0) {
  return { ...textChannel(id, name, position), type: "dm" as const };
}

describe("MainPage — video grid, DM profile panel, calls, settings", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    mockMountChannel.mockClear();
    mockDestroyChannel.mockClear();
    mockCreateChatArea.mockClear();
    capturedChatAreaRef.current = null;
    // The panel opens with a 1:1 DM by default (WP 3B-3); the toggle tests below
    // start from "remembered closed" and the auto-open tests set it back.
    savePref("dmProfileOpen", false);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
    localStorage.removeItem("owncord:settings:dmProfileOpen");
  });

  it("dismisses the video grid when switching to a non-voice channel (dm/announcement), not just 'text'", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      ch.set(2, dmChannel(2, "dm-with-bob"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    // Open the call view while in voice with the camera on (the real,
    // unmocked VideoModeController drives this off voiceStore).
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([[9, new Map()]]),
      localCamera: true,
    }));
    voiceStore.flush();
    // Your own camera alone no longer covers the chat (WP 1B-4).
    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("");
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();

    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("none");

    // Switch to a DM while the grid is up — a dm channel mounts a chat
    // surface just like text/announcement do, so the grid must not survive
    // the switch and hide it behind an unrelated video grid.
    setActiveChannel(2);
    channelsStore.flush();

    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("");
  });

  it("opening the call view of a voice channel selects it and keeps its chat beside the grid (WP 6.1b)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      ch.set(9, { ...textChannel(9, "lounge", 1), type: "voice" as const });
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([[9, new Map()]]),
    }));
    voiceStore.flush();
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();

    const { chatArea, slots } = capturedChatAreaRef.current!;
    expect(channelsStore.getState().activeChannelId).toBe(9);
    expect(slots.videoGridSlot.style.display).toBe("block");
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.inputSlot.style.display).toBe("");
    expect(chatArea.classList.contains("chat-area--call-chat")).toBe(true);

    // Leaving the call closes the grid; the voice chat stays, full width.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, voiceUsers: new Map() }));
    voiceStore.flush();
    channelsStore.flush();
    expect(channelsStore.getState().activeChannelId).toBe(9);
    expect(slots.videoGridSlot.style.display).toBe("none");
    expect(slots.messagesSlot.style.display).toBe("");
    expect(chatArea.classList.contains("chat-area--call-chat")).toBe(false);
  });

  it("opening another voice channel's chat while in a call dismisses the grid (WP 6.1d)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      ch.set(9, { ...textChannel(9, "lounge", 1), type: "voice" as const });
      ch.set(10, { ...textChannel(10, "music", 2), type: "voice" as const });
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([[9, new Map()]]),
    }));
    voiceStore.flush();
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();
    const { slots } = capturedChatAreaRef.current!;
    expect(slots.videoGridSlot.style.display).toBe("block");

    setActiveChannel(10);
    channelsStore.flush();
    expect(slots.videoGridSlot.style.display).toBe("none");
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("does not clear a just-added remote video tile when a voice-channel switch left the camera/screenshare signature unchanged (OC-0207)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    // Alice joins voice channel A (9). Someone's camera briefly toggles the
    // signature so the real VideoModeController actually runs checkVideoMode
    // against channel 9 and latches its lastChannelId there — mirroring
    // "Alice is already in voice channel A" from the finding's repro.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [
              100,
              {
                userId: 100,
                username: "carl",
                muted: false,
                deafened: false,
                speaking: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [
              100,
              {
                userId: 100,
                username: "carl",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();

    // Alice switches to voice channel B (10). Nobody in B has camera or
    // screenshare on either, so MainPage's camera/screenshare signature does
    // not change across the switch — the blind spot the finding describes.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 10,
      voiceUsers: new Map([[10, new Map()]]),
    }));
    voiceStore.flush();

    // The switch itself may legitimately clear stale tiles from channel A
    // (that is the correct, eager fix) — what matters for this finding is
    // that nothing clears the grid again *after* the new tile is added.
    const videoGrid = capturedChatAreaRef.current!.videoGrid;
    videoGrid.clearStreams.mockClear();

    // Bob's screenshare track arrives via LiveKit in channel B ahead of the
    // server's voice_state broadcast (the documented TrackSubscribed race).
    const fakeStream = {} as MediaStream;
    capturedOnRemoteVideo.current!(200, fakeStream, true);

    expect(videoGrid.addStream).toHaveBeenCalled();
    // The bug: VideoModeController's lastChannelId is still stuck on channel
    // A (9) because the switch to B (10) never changed the signature, so the
    // checkVideoMode() call right after addStream sees a "channel change"
    // that isn't one and wipes the tile it was just given.
    expect(videoGrid.clearStreams).not.toHaveBeenCalled();
  });

  it("applies a cross-channel roster click's channel change before watching, so clearStreams cannot drop the watch", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      ch.set(10, { ...textChannel(10, "lounge", 1), type: "voice" as const });
      return { ...prev, channels: ch, activeChannelId: 1 };
    });
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    const user = (userId: number, screenshare: boolean) => ({
      userId,
      username: `u${userId}`,
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare,
    });
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        [9, new Map([[100, user(100, true)]])],
        [10, new Map([[200, user(200, true)]])],
      ]),
    }));
    voiceStore.flush();
    channelsStore.flush();

    const grid = capturedChatAreaRef.current!.videoGrid;
    grid.clearStreams.mockClear();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    // The roster click (ChannelSidebar) joins first, then asks the page to watch.
    (
      mockCreateSidebarArea.mock.calls.at(-1)![0] as { onWatchStream: (userId: number) => void }
    ).onWatchStream(200);

    expect(grid.watch).toHaveBeenCalledOnce();
    expect(grid.clearStreams).toHaveBeenCalled();
    expect(grid.clearStreams.mock.invocationCallOrder[0]!).toBeLessThan(
      grid.watch.mock.invocationCallOrder[0]!,
    );
  });

  it("opens the call view from the joined channel, and keeps its avatar tiles in step with who joins (1B-1)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    const user = (userId: number) => ({
      userId,
      username: `u${userId}`,
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([[9, new Map([[100, user(100)]])]]),
    }));
    voiceStore.flush();

    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();

    const { slots, videoGrid } = capturedChatAreaRef.current!;
    expect(slots.messagesSlot.style.display).toBe("none");
    const ids = () =>
      (videoGrid.setPeople.mock.calls.at(-1)![0] as { userId: number }[]).map((p) => p.userId);
    expect(ids()).toEqual([100]);

    // A join with no video changes no camera/share flag.
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [100, user(100)],
            [101, user(101)],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();
    expect(ids()).toEqual([100, 101]);
    expect(slots.messagesSlot.style.display).toBe("none");
  });

  it("relabels a remote video tile with the member's display name, not the raw username, and keeps it in sync with a mid-call rename (OC-0227)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });
    membersStore.setState(() => ({
      members: new Map([
        [
          200,
          {
            id: 200,
            username: "bob_1994",
            avatar: null,
            role: "member",
            status: "online" as const,
            displayName: "Bee",
          },
        ],
      ]),
      typingUsers: new Map(),
      roleRevision: 0,
    }));

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [
              200,
              {
                userId: 200,
                username: "bob_1994",
                muted: false,
                deafened: false,
                speaking: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();

    const fakeStream = {} as MediaStream;
    capturedOnRemoteVideo.current!(200, fakeStream, false);

    const videoGrid = capturedChatAreaRef.current!.videoGrid;
    // The tile must show the same identity the voice roster and every other
    // surface show for user 200 — the nickname "Bee" — not the raw username
    // "bob_1994" (ChannelSidebar.ts's memberDisplayName idiom).
    expect(videoGrid.addStream).toHaveBeenCalledWith(
      200,
      "Bee",
      fakeStream,
      expect.objectContaining({ isSelf: false }),
    );

    // Bob renames himself mid-call (Settings -> Account). The USER_UPDATE
    // fan-out updates both membersStore and voiceStore's frozen username
    // copy, exactly like dispatcher.ts's USER_UPDATE handler does.
    updateMemberProfile(200, { username: "bob_1994", avatar: null, displayName: "Robert" });
    updateVoiceUserProfile(200, { username: "bob_1994" });
    voiceStore.flush();

    // The already-open tile must pick up the new name without the tile
    // being torn down and re-created (no new addStream call for tile 200).
    expect(videoGrid.setLabel).toHaveBeenCalledWith(200, "Robert", "Robert");
  });

  it('keeps "(You)" on the self-view tile when the server echoes our own voice_state (OC-0375)', () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    // resetStores authenticates user 1 ("alice"). This is the server's own
    // voice_state echo landing in voiceUsers for the local user — updateVoiceState
    // writes self into the roster exactly like any other member.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [
              1,
              {
                userId: 1,
                username: "alice",
                muted: false,
                deafened: false,
                speaking: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();

    const videoGrid = capturedChatAreaRef.current!.videoGrid;
    // VideoModeController registers the self tile under the local user id with
    // "alice (You)". The relabel loop walks the whole roster, self included, so
    // it must produce the same self label — not the bare remote form, which
    // would leave your own tile indistinguishable from a participant's.
    expect(videoGrid.setLabel).not.toHaveBeenCalledWith(1, "alice", "alice");
    expect(videoGrid.setLabel).toHaveBeenCalledWith(1, "alice (You)", "alice");
  });

  it("brackets a bare IPv6 host when building the auto-updater URL (OC-0332)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi("2001:db8::1") });
    page.mount(container);

    // A bare IPv6 literal spliced into a URL authority is not parseable — the
    // host parser enters the port state at the first colon — so build_updater
    // rejects it and checkForUpdate reports "no update available" forever.
    // Every other URL-building site brackets it (ws.ts, admin-panel.ts,
    // attachments.ts); this one did not.
    expect(mockCreateUpdateNotifier).toHaveBeenCalledWith({
      serverUrl: "https://[2001:db8::1]",
      keepChecking: true,
    });
  });

  it("leaves a DNS host unbracketed in the auto-updater URL (OC-0332)", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, textChannel(1, "general"));
      return { ...prev, channels: ch, activeChannelId: 1 };
    });

    page = createMainPage({ ws: fakeWs(), api: fakeApi("chat.example.com:8443") });
    page.mount(container);

    expect(mockCreateUpdateNotifier).toHaveBeenCalledWith({
      serverUrl: "https://chat.example.com:8443",
      keepChecking: true,
    });
  });

  describe("DM profile panel is open by default and remembered (WP 3B-3)", () => {
    const panel = (): HTMLElement | null =>
      capturedChatAreaRef.current!.dmProfileSlot.querySelector<HTMLElement>(
        '[data-testid="dm-profile-sidebar"]',
      );
    const names = (): string | undefined =>
      capturedChatAreaRef.current!.dmProfileSlot.querySelector<HTMLElement>(
        '[data-testid="dps-username"]',
      )?.textContent ?? undefined;
    const pref = (): string | null => localStorage.getItem("owncord:settings:dmProfileOpen");
    const oneToOne = (channelId: number, userId: number, username: string) => ({
      channelId,
      recipient: { id: userId, username, avatar: "", status: "online" },
      participants: [{ id: userId, username, avatar: "", status: "online" }],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    });
    function mountOnTwoDms(): void {
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(1, textChannel(1, "general"));
        ch.set(70, dmChannel(70, "dm-bob"));
        ch.set(71, dmChannel(71, "dm-carol"));
        ch.set(72, dmChannel(72, "group"));
        return { ...prev, channels: ch, activeChannelId: 70 };
      });
      dmStore.setState(() => ({
        channels: [
          oneToOne(70, 7, "bob"),
          oneToOne(71, 8, "carol"),
          { ...oneToOne(72, 9, "dave"), isGroup: true, name: "group" },
        ],
      }));
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      // The mocked chat area's slot is detached; focus needs it in the document.
      container.appendChild(capturedChatAreaRef.current!.dmProfileSlot);
    }
    async function settle(): Promise<void> {
      await import("@components/DmProfileSidebar");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("opens with a 1:1 DM at mount and keeps the panel, updated for the second user, on a DM switch", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(names()).toBe("bob"));
      expect(capturedChatAreaRef.current!.profileBtn.getAttribute("aria-pressed")).toBe("true");
      const before = panel();

      setActiveChannel(71);
      channelsStore.flush();
      await vi.waitFor(() => expect(names()).toBe("carol"));
      // The same panel node, repainted: it does not slide in again.
      expect(panel()).toBe(before);
      expect(
        capturedChatAreaRef.current!.dmProfileSlot.querySelectorAll(
          '[data-testid="dm-profile-sidebar"]',
        ),
      ).toHaveLength(1);
      expect(pref()).toBe("true");
    });

    it("opens by default when nothing was saved", async () => {
      localStorage.removeItem("owncord:settings:dmProfileOpen");
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
    });

    it("stays closed on mount and on a DM switch when the saved preference is false", async () => {
      mountOnTwoDms();
      await settle();
      expect(panel()).toBeNull();
      setActiveChannel(71);
      channelsStore.flush();
      await settle();
      expect(panel()).toBeNull();
      expect(capturedChatAreaRef.current!.profileBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("hides for a group or a server channel without changing the preference, and returns for the next 1:1 DM", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());

      setActiveChannel(72);
      channelsStore.flush();
      await settle();
      expect(panel()).toBeNull();
      expect(pref()).toBe("true");

      setActiveChannel(1);
      channelsStore.flush();
      await settle();
      expect(panel()).toBeNull();

      setActiveChannel(71);
      channelsStore.flush();
      await vi.waitFor(() => expect(names()).toBe("carol"));
    });

    it("the header's Show User Profile toggle closes, remembers false, then reopens and remembers true", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      const toggle = (): void => mockCreateChatArea.mock.calls[0]![0].onToggleDmProfile();
      const pressed = (): string | null =>
        capturedChatAreaRef.current!.profileBtn.getAttribute("aria-pressed");

      toggle();
      expect(panel()).toBeNull();
      expect(pressed()).toBe("false");
      expect(pref()).toBe("false");

      toggle();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      expect(pressed()).toBe("true");
      expect(pref()).toBe("true");
    });

    describe("focus and Escape", () => {
      let composer: HTMLTextAreaElement;
      beforeEach(() => {
        composer = document.createElement("textarea");
        document.body.appendChild(composer);
      });
      afterEach(() => composer.remove());
      const escape = (target: EventTarget = document): KeyboardEvent => {
        // The Settings panel is mounted inside its closed overlay, which only the
        // stylesheet hides; jsdom has none, so hide it or it counts as a dialog.
        for (const settings of document.querySelectorAll<HTMLElement>(".settings-panel")) {
          if (settings.parentElement !== null) settings.parentElement.style.display = "none";
        }
        const ev = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(ev);
        return ev;
      };

      it("does not steal focus when the panel opens by itself, at mount or on a DM switch", async () => {
        savePref("dmProfileOpen", true);
        composer.focus();
        mountOnTwoDms();
        await vi.waitFor(() => expect(names()).toBe("bob"));
        expect(document.activeElement).toBe(composer);

        setActiveChannel(71);
        channelsStore.flush();
        await vi.waitFor(() => expect(names()).toBe("carol"));
        expect(document.activeElement).toBe(composer);
      });

      it("does focus the panel when the user opens it from the header", async () => {
        mountOnTwoDms();
        mockCreateChatArea.mock.calls[0]![0].onToggleDmProfile();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        expect(panel()!.contains(document.activeElement)).toBe(true);
      });

      it("keeps the panel and the pref when a field already used the Escape", async () => {
        savePref("dmProfileOpen", true);
        mountOnTwoDms();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        const note = panel()!.querySelector<HTMLTextAreaElement>('[data-testid="dps-note"]')!;
        note.focus();
        note.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
        escape(note);
        expect(panel()).not.toBeNull();
        expect(pref()).toBe("true");
      });

      it("ignores an Escape while focus is outside the panel", async () => {
        savePref("dmProfileOpen", true);
        mountOnTwoDms();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        composer.focus();
        escape(composer);
        expect(panel()).not.toBeNull();
        expect(pref()).toBe("true");
      });

      it("closes on Escape with focus inside and remembers it", async () => {
        savePref("dmProfileOpen", true);
        mountOnTwoDms();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        panel()!.focus();
        escape();
        expect(panel()).toBeNull();
        expect(pref()).toBe("false");
      });

      it("leaves the panel open when Escape belongs to a dialog opened before it", async () => {
        savePref("dmProfileOpen", true);
        const dialog = document.createElement("div");
        dialog.className = "modal-overlay";
        document.body.appendChild(dialog);
        try {
          mountOnTwoDms();
          await vi.waitFor(() => expect(panel()).not.toBeNull());
          panel()!.focus();
          escape();
          expect(panel()).not.toBeNull();
          expect(pref()).toBe("true");
        } finally {
          dialog.remove();
        }
      });
    });

    it("closing with the panel's own close button is remembered", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      capturedChatAreaRef
        .current!.dmProfileSlot.querySelector<HTMLButtonElement>('[data-testid="dps-close"]')
        ?.click();
      expect(panel()).toBeNull();
      expect(pref()).toBe("false");
    });
  });

  it("does not open the 1:1 profile panel for a group DM header click", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(50, dmChannel(50, "Group Chat"));
      return { ...prev, channels: ch, activeChannelId: 50 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 50,
          recipient: { id: 10, username: "alice", avatar: "", status: "online" },
          participants: [
            { id: 10, username: "alice", avatar: "", status: "online" },
            { id: 11, username: "bob", avatar: "", status: "online" },
          ],
          name: "Group Chat",
          isGroup: true,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();

    // dm.store.ts documents .recipient as "the first of participants" for a
    // group, with the explicit instruction that group-correct code reads
    // .participants instead — a 1:1 panel built from .recipient would show
    // one arbitrary member's identity as if it were the whole conversation.
    expect(
      capturedChatAreaRef.current!.dmProfileSlot.querySelector(
        '[data-testid="dm-profile-sidebar"]',
      ),
    ).toBeNull();
  });

  it("does not ring or announce 'Calling…' when starting a call while the socket is reconnecting", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(50, dmChannel(50, "dm-alice"));
      return { ...prev, channels: ch, activeChannelId: 50 };
    });
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));

    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onStartCall();

    // onVoiceJoin already silently refuses to join while the socket is down
    // (VoiceCallbacks.ts's socketLive() guard) — startCall must not still
    // ring and tell the user "Calling…" over a call nobody can hear.
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "call_ring" }));
  });

  it("keeps an incoming ring alive when Accept is clicked while the socket is reconnecting", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).not.toBe("none");

    // The socket drops mid-ring.
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));

    const acceptBtn = document.querySelector('[data-testid="incoming-call-accept"]') as HTMLElement;
    acceptBtn.click();

    // Accepting while reconnecting must not silently consume the ring (the
    // banner clearing means ringCtrl.accept() ran and nothing rejoins) — the
    // ring has to survive so the user can accept again once reconnected.
    expect(banner.style.display).not.toBe("none");
  });

  it("keeps an incoming ring alive when Accept is clicked during the join backoff", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    noteJoinFailed();

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    const acceptBtn = document.querySelector('[data-testid="incoming-call-accept"]') as HTMLElement;
    acceptBtn.click();

    expect(banner.style.display).not.toBe("none");
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));
    expect(document.body.textContent).toContain("Voice join failed — try again in 2 s");

    noteJoinFailed(Date.now(), true);
    acceptBtn.click();
    expect(document.body.textContent).toContain("Please wait 4 s before switching voice channels");

    noteJoinSucceeded();
    acceptBtn.click();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));
  });

  it("Join with video on the incoming banner joins and turns the camera on once connected (3B-4)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    const lk = await import("@lib/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    (document.querySelector('[data-testid="incoming-call-accept-video"]') as HTMLElement).click();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));
    expect(lk.enableCamera).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();
    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    vi.mocked(lk.enableCamera).mockClear();
    page.destroy?.();
  });

  it("Ctrl+Enter accepts and Escape declines a ringing call (3B-4)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    // The closed Settings panel is hidden by stylesheet only, which jsdom does
    // not load; hide it the way the real page's CSS does.
    const settingsOverlay = document.querySelector<HTMLElement>('[data-testid="settings-overlay"]');
    expect(settingsOverlay).not.toBeNull();
    settingsOverlay!.style.display = "none";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true }),
    );
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));

    ws.emit("call_incoming", { channel_id: 51, from_user: 11, username: "carol" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(ws.send).toHaveBeenCalledWith({ type: "call_decline", payload: { channel_id: 51 } });
    page.destroy?.();
  });

  it("a ring replaced by a ring from another channel reports the first as missed (3B-4)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    vi.mocked(alertSupersededCall).mockClear();

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    await vi.dynamicImportSettled();
    expect(alertSupersededCall).not.toHaveBeenCalled();

    ws.emit("call_incoming", { channel_id: 51, from_user: 11, username: "carol" });
    await vi.waitFor(() => expect(alertSupersededCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertSupersededCall).mock.calls[0]![0]).toMatchObject({ channelId: 50 });
    page.destroy?.();
  });

  function openOneToOneDm(id: number): void {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(id, dmChannel(id, "dm-bob"));
      return { ...prev, channels: ch, activeChannelId: id };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: id,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 10, username: "bob", avatar: "", status: "online" }],
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
  }

  it("answers a ring for the open DM in the call panel and hides the banner, handing it back when you look elsewhere", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    // The panel is a lazy chunk.
    await vi.dynamicImportSettled();

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "bob" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("incoming");
    expect(banner.style.display).toBe("none");

    // Another channel on screen: the banner is the only way to answer.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();
    expect(banner.style.display).not.toBe("none");

    // Settings over the DM hides the panel, so the banner answers there too.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
    channelsStore.flush();
    expect(banner.style.display).toBe("none");
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    uiStore.flush();
    expect(banner.style.display).not.toBe("none");
  });

  it("shows the DM's own call video in its panel, keeping the chat in view", async () => {
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceUsers: new Map([
        [
          50,
          new Map([
            [
              1,
              {
                userId: 1,
                username: "alice",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
              },
            ],
            [
              10,
              {
                userId: 10,
                username: "bob",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: true,
              },
            ],
          ]),
        ],
      ]),
      localCamera: true,
    }));
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    voiceStore.flush();

    const slots = capturedChatAreaRef.current!.slots;
    const panelVideo = document.querySelector('[data-testid="dcp-video"]');
    expect(panelVideo).not.toBeNull();
    expect(panelVideo!.contains(slots.videoGridSlot)).toBe(true);
    // Your own camera no longer takes over the DM's chat.
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.inputSlot.style.display).toBe("");

    // Opening another channel hands the grid back to the chat column.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();
    expect(panelVideo!.contains(slots.videoGridSlot)).toBe(false);

    page.destroy?.();
  });

  it("keeps the DM call panel's video up across repeated video changes, never switching it off in between", async () => {
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    const vu = (userId: number, username: string, extra = {}) => ({
      userId,
      username,
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      ...extra,
    });
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceUsers: new Map([
        [
          50,
          new Map([
            [1, vu(1, "alice")],
            [10, vu(10, "bob", { screenshare: true })],
          ]),
        ],
      ]),
    }));
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    voiceStore.flush();

    const mute = document.querySelector('[data-testid="dcp-mute"]');
    expect(mute).not.toBeNull();
    const setPeople = capturedChatAreaRef.current!.videoGrid.setPeople;
    setPeople.mockClear();

    for (const extra of [{ screenshare: true, camera: true }, { screenshare: true }]) {
      voiceStore.setState((prev) => ({
        ...prev,
        voiceUsers: new Map([
          [
            50,
            new Map([
              [1, vu(1, "alice")],
              [10, vu(10, "bob", extra)],
            ]),
          ],
        ]),
      }));
      voiceStore.flush();
    }

    expect(setPeople).not.toHaveBeenCalledWith([]);
    expect(document.querySelector('[data-testid="dcp-mute"]')).toBe(mute);

    page.destroy?.();
  });

  it("joining voice calls ensureLoaded once per channel, not on every voice update", () => {
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    const ensureLoaded = capturedChatAreaRef.current!.videoGrid.ensureLoaded;
    expect(ensureLoaded).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9 }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);

    // Other voice updates in the same channel do not ask again.
    voiceStore.setState((prev) => ({ ...prev, localMuted: !prev.localMuted }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);

    // A leave asks nothing; the next join (a retry after a failed import) does.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9 }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(2);
  });

  it("rings the video tiles of whoever is speaking in the current call", () => {
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    const grid = capturedChatAreaRef.current!.videoGrid;

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [
              10,
              {
                userId: 10,
                username: "bob",
                muted: false,
                deafened: false,
                speaking: true,
                camera: true,
                screenshare: false,
              },
            ],
            [
              11,
              {
                userId: 11,
                username: "cy",
                muted: false,
                deafened: false,
                speaking: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();

    const last = grid.setSpeaking.mock.calls.at(-1)![0] as ReadonlySet<number>;
    expect([...last]).toEqual([10]);
  });

  it("wires full screen, the full-screen call controls, stream stats and video views into the video grid", async () => {
    const lk = await import("@lib/livekitSession");
    const setFullscreen = vi.spyOn(desktop.window, "setFullscreen").mockResolvedValue(undefined);
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    const grid = capturedChatAreaRef.current!.videoGrid;
    const cbs = grid.setCallbacks.mock.calls.at(-1)![0] as {
      setWindowFullscreen: (on: boolean) => Promise<void>;
      callControls: {
        onMuteToggle: () => void;
        onDeafenToggle: () => void;
        onLeave: () => void;
        onCameraToggle: () => void;
        onScreenshareToggle: () => void;
      };
      getStreamStats: (tileId: number) => Promise<unknown>;
      getLocalShareStats: () => Promise<unknown>;
      setStreamView: (tileId: number, view: { enabled: boolean }) => void;
    };

    await cbs.setWindowFullscreen(true);
    expect(setFullscreen).toHaveBeenCalledWith(true);

    // Stats for a screen-share tile ask for that user's screen share.
    await cbs.getStreamStats(10 + SCREENSHARE_TILE_ID_OFFSET);
    expect(lk.getRemoteVideoStats).toHaveBeenLastCalledWith(10, "screenshare");
    await cbs.getStreamStats(10);
    expect(lk.getRemoteVideoStats).toHaveBeenLastCalledWith(10, "camera");
    // Your own share's tile reads the rate it is sending.
    await expect(cbs.getLocalShareStats()).resolves.toEqual({ sentFps: 57 });
    // A tile's view goes to that user's screen share or camera the same way.
    cbs.setStreamView(10 + SCREENSHARE_TILE_ID_OFFSET, { enabled: false });
    expect(lk.setRemoteVideoView).toHaveBeenLastCalledWith(10, "screenshare", { enabled: false });
    cbs.setStreamView(10, { enabled: true });
    expect(lk.setRemoteVideoView).toHaveBeenLastCalledWith(10, "camera", { enabled: true });

    // Leave from a full-screen tile leaves the call.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9 }));
    cbs.callControls.onLeave();
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });

    // The full-screen controls show your mute state.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: true }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith({
      muted: true,
      deafened: false,
      listenOnly: false,
      camera: false,
      screenshare: false,
      connecting: false,
      serverMuted: false,
      serverDeafened: false,
    });
    // Joined without a microphone: the controls read listen-only.
    voiceStore.setState((prev) => ({ ...prev, localMuted: false, listenOnly: true }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith({
      muted: false,
      deafened: false,
      listenOnly: true,
      camera: false,
      screenshare: false,
      connecting: false,
      serverMuted: false,
      serverDeafened: false,
    });
    // The call view's control bar shows your camera and share state, and
    // holds them inert while the join is still connecting.
    voiceStore.setState((prev) => ({
      ...prev,
      listenOnly: false,
      localCamera: true,
      localScreenshare: true,
      voiceStatus: "joining",
    }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith({
      muted: false,
      deafened: false,
      listenOnly: false,
      camera: true,
      screenshare: true,
      connecting: true,
      serverMuted: false,
      serverDeafened: false,
    });
    // Its camera and share buttons run the same toggles as the voice widget.
    voiceStore.setState((prev) => ({
      ...prev,
      localCamera: false,
      localScreenshare: false,
      voiceStatus: "connected",
    }));
    // A moderator mute and a dropped chat socket reach the bar too.
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverMuted: true }),
    );
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    uiStore.flush?.();
    expect(grid.setCallState).toHaveBeenLastCalledWith(
      expect.objectContaining({ offline: "reconnecting" }),
    );
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    uiStore.flush?.();
    expect(grid.setCallState).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ offline: expect.anything() }),
    );
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: false }));
    cbs.callControls.onCameraToggle();
    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    cbs.callControls.onScreenshareToggle();
    expect(lk.enableScreenshare).toHaveBeenCalledTimes(1);
    setFullscreen.mockRestore();
  });

  it("toggles mute and deafen from a global shortcut while unfocused (U6)", async () => {
    const shortcutHandlers = new Set<(action: "mute" | "deafen") => void>();
    const onShortcut = vi
      .spyOn(desktop.globalShortcuts, "onShortcut")
      .mockImplementation((handler) => {
        shortcutHandlers.add(handler);
        return () => shortcutHandlers.delete(handler);
      });
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(true);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    for (const handler of shortcutHandlers) handler("mute");

    // The same toggle the in-app Ctrl+M runs: muting sends voice_mute(true).
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });

    onShortcut.mockRestore();
    start.mockRestore();
    supported.mockRestore();
  });

  it("toggles once on a focused Ctrl+Shift+M while the global poller runs (1A-5)", async () => {
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(true);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // jsdom loads no CSS, so the closed Settings panel would read as an open dialog.
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";

    // The poller sees the press and emits the shortcut; the in-app handler must not also toggle.
    const event = new KeyboardEvent("keydown", {
      key: "M",
      code: "KeyM",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    expect(voiceStore.getState().localMuted).toBe(false);

    start.mockRestore();
    supported.mockRestore();
  });

  it("keeps standing down after a remount while the running poller is re-checked (1A-5)", async () => {
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(true);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    page.destroy?.();

    // A logout or server switch remounts the page; the native poller is still live.
    supported.mockReturnValue(new Promise<boolean>(() => {}));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
    );

    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));

    start.mockRestore();
    supported.mockRestore();
  });

  it("toggles mute in-app on Ctrl+Shift+M where global keys are unsupported (1A-5)", async () => {
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.waitFor(() => expect(supported).toHaveBeenCalled());
    await Promise.resolve();
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
    );

    // The host decides whether anything observes keys; the in-app key still answers.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });

    start.mockRestore();
    supported.mockRestore();
  });

  describe("Wayland portal keys (LP-9b)", () => {
    const portal = {
      backend: "portal" as const,
      portalVersion: 2,
      triggers: { ptt: null, mute: null, deafen: null },
      canConfigure: true,
      triggersUnnamed: false,
      sessionRefused: false,
    };
    // Spies on the shared registry would otherwise carry their calls into the next test.
    const restore = ["status", "bindPortal", "supported", "start", "onStatusChange"] as const;
    afterEach(() => {
      localStorage.removeItem("owncord:settings:globalKeysPortalBound");
      for (const name of restore) vi.mocked(desktop.globalShortcuts[name]).mockRestore?.();
    });

    it("restores the portal binding at startup only after an earlier successful bind", async () => {
      const status = vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(portal);
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);

      // Never bound before: no dialog is opened on its own.
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await Promise.resolve();
      expect(bind).not.toHaveBeenCalled();
      page.destroy?.();

      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      localStorage.setItem("owncord:settings:pttVk", String(0x77));
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
      expect(bind).toHaveBeenCalledWith({ pttVk: 0x77, muteVk: 0x4d, deafenVk: 0x44 });
      localStorage.removeItem("owncord:settings:pttVk");
    });

    it("does not reopen the dialog when the desktop already holds a trigger", async () => {
      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      const status = vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue({
        ...portal,
        triggers: { ptt: null, mute: "Ctrl+Alt+M", deafen: null },
      });
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(bind).not.toHaveBeenCalled();
    });

    it("forgets the earlier bind when the restore dialog is cancelled, and keeps it on other failures", async () => {
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal");
      const pref = (): string | null =>
        localStorage.getItem("owncord:settings:globalKeysPortalBound");

      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      bind.mockRejectedValue(Object.assign(new Error("bind_timeout"), { code: "bind_timeout" }));
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pref()).toBe("true");
      page.destroy?.();

      bind.mockRejectedValue(
        Object.assign(new Error("bind_cancelled"), { code: "bind_cancelled" }),
      );
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(pref()).toBe("false"));
    });

    it("lets only the latest supported() answer set the flag when answers arrive out of order", async () => {
      const changeHandlers = new Set<(s: typeof portal) => void>();
      vi.spyOn(desktop.globalShortcuts, "onStatusChange").mockImplementation((handler) => {
        changeHandlers.add(handler);
        return () => changeHandlers.delete(handler);
      });
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue({ ...portal, backend: "none" });
      const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
      const answers: ((value: boolean) => void)[] = [];
      const supported = vi
        .spyOn(desktop.globalShortcuts, "supported")
        .mockImplementation(() => new Promise<boolean>((resolve) => answers.push(resolve)));
      const ws = fakeWs();
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(supported).toHaveBeenCalledTimes(1));
      for (const handler of changeHandlers) handler(portal);
      expect(answers).toHaveLength(2);

      // The newer query answers "no keys" first; the older "yes" must not undo it.
      answers[1]?.(false);
      await Promise.resolve();
      answers[0]?.(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Only the newer query ran start(); the stale "yes" returned early.
      expect(start).toHaveBeenCalledTimes(1);
      (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
      );
      expect(vi.mocked(ws.send).mock.calls.filter((c) => c[0].type === "voice_mute")).toHaveLength(
        1,
      );
    });

    it("arms the portal on a desktop that names no keys, and still answers the in-app key", async () => {
      const unnamed = { ...portal, triggersUnnamed: true };
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(unnamed);
      const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      const ws = fakeWs();
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
      );
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    });

    it("re-binds at startup when the portal holds the shortcuts but names no keys", async () => {
      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      const status = vi
        .spyOn(desktop.globalShortcuts, "status")
        .mockResolvedValue({ ...portal, triggersUnnamed: true });
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    });

    it("does not bind on a desktop without the portal even after an earlier bind", async () => {
      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      const status = vi
        .spyOn(desktop.globalShortcuts, "status")
        .mockResolvedValue({ ...portal, backend: "none" });
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await Promise.resolve();
      expect(bind).not.toHaveBeenCalled();
    });

    it("keeps the in-app shortcut until both keys are bound, then stands down", async () => {
      const changeHandlers = new Set<(s: typeof portal) => void>();
      vi.spyOn(desktop.globalShortcuts, "onStatusChange").mockImplementation((handler) => {
        changeHandlers.add(handler);
        return () => changeHandlers.delete(handler);
      });
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(portal);
      const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
      const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      const ws = fakeWs();
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      await vi.waitFor(() => expect(supported).toHaveBeenCalledTimes(1));
      (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
      const mutes = (): number =>
        vi.mocked(ws.send).mock.calls.filter((c) => c[0].type === "voice_mute").length;
      const press = (): void => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
        );
      };

      press();
      expect(mutes()).toBe(1); // the in-app key still answers

      supported.mockResolvedValue(true);
      for (const handler of changeHandlers) handler(portal);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      press();
      expect(mutes()).toBe(1); // the desktop's key owns it now

      page.destroy?.();
      expect(changeHandlers.size).toBe(0);
    });
  });

  // WP 1D-1: outside a call the shortcut toggles the local, saved state and
  // sends nothing; the next join restates it to the server.
  it("toggles mute and deafen from a global shortcut outside a voice channel, sending nothing (U6)", async () => {
    const lk = await import("@lib/livekitSession");
    const shortcutHandlers = new Set<(action: "mute" | "deafen") => void>();
    const onShortcut = vi
      .spyOn(desktop.globalShortcuts, "onShortcut")
      .mockImplementation((handler) => {
        shortcutHandlers.add(handler);
        return () => shortcutHandlers.delete(handler);
      });
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: null,
      localMuted: false,
      localDeafened: false,
    }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    vi.mocked(lk.setMuted).mockClear();
    vi.mocked(lk.setDeafened).mockClear();

    for (const handler of shortcutHandlers) handler("mute");
    expect(lk.setMuted).toHaveBeenCalledWith(true);
    for (const handler of shortcutHandlers) handler("deafen");
    expect(lk.setDeafened).toHaveBeenCalledWith(true);

    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_deafen" }));

    onShortcut.mockRestore();
    start.mockRestore();
  });

  it("pushes the persisted global shortcut bindings to the poller on mount (U6)", async () => {
    const setKeys = vi.spyOn(desktop.globalShortcuts, "setKeys").mockResolvedValue(undefined);
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    localStorage.setItem("owncord:settings:globalMuteVk", "75"); // Ctrl+Shift+K

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    expect(setKeys).toHaveBeenCalledWith({ muteVk: 0x4b, deafenVk: 0x44 });
    localStorage.removeItem("owncord:settings:globalMuteVk");
    setKeys.mockRestore();
    start.mockRestore();
  });

  it("stops your screen share from the grid's self-preview cover, and names remote tiles for their controls", async () => {
    const { disableScreenshare } = await import("@lib/livekitSession");
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    const grid = capturedChatAreaRef.current!.videoGrid;
    const cbs = grid.setCallbacks.mock.calls.at(-1)![0] as { onStopSharing: () => void };

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localScreenshare: true }));
    cbs.onStopSharing();
    expect(disableScreenshare).toHaveBeenCalled();

    // A remote tile carries the person's name for its control labels.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "bob",
        displayName: "Bobby",
        avatar: null,
        role: "member",
        status: "online",
      });
      return { ...prev, members };
    });
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [
              10,
              {
                userId: 10,
                username: "bob",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: true,
              },
            ],
          ]),
        ],
      ]),
    }));
    capturedOnRemoteVideo.current!(10, {} as MediaStream, true);
    const config = grid.addStream.mock.calls.at(-1)![3] as { name?: string };
    expect(config.name).toBe("Bobby");
  });

  it("the header's video call button joins the DM call and turns the camera on once connected (3B-1)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    const lk = await import("@lib/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();

    mockCreateChatArea.mock.calls[0]![0].onStartVideoCall();
    // Not before the join lands: the camera follows "connected".
    expect(lk.enableCamera).not.toHaveBeenCalled();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();
    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    page.destroy?.();
  });

  it("the header's group name click renames the open DM through the sidebar (3B-1)", () => {
    openOneToOneDm(50);
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    mockCreateChatArea.mock.calls[0]![0].onRenameGroup();

    expect(mockRenameGroup).toHaveBeenCalledWith(50);
    page.destroy?.();
  });

  it("Video while already connected in the DM's call turns the camera on at once (3B-1)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    const lk = await import("@lib/livekitSession");
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceStatus: "connected",
      localCamera: false,
    }));
    voiceStore.flush();
    vi.mocked(lk.enableCamera).mockClear();

    mockCreateChatArea.mock.calls[0]![0].onStartVideoCall();

    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    page.destroy?.();
  });

  it("a Video start refused by join backoff does not arm the camera for a later plain join (3B-1)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    const lk = await import("@lib/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();
    const { noteJoinFailed } = await import("../../src/features/voice/joinBackoff");
    noteJoinFailed(Date.now(), true);
    noteJoinFailed(Date.now(), true);
    noteJoinFailed(Date.now(), true);

    mockCreateChatArea.mock.calls[0]![0].onStartVideoCall();
    // The refused join left no channel; a later join of the same DM, plain.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();

    expect(lk.enableCamera).not.toHaveBeenCalled();
    page.destroy?.();
    const { noteJoinSucceeded } = await import("../../src/features/voice/joinBackoff");
    noteJoinSucceeded();
  });

  it("a plain header call leaves the camera off (3B-1)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    const lk = await import("@lib/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();

    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();
    expect(lk.enableCamera).not.toHaveBeenCalled();
    page.destroy?.();
  });

  it("tells the caller when the callee declines, and Ring again rings once more", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    // The panel is a lazy chunk.
    await vi.dynamicImportSettled();

    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    finishCallJoin();
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("outgoing");

    ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "bob" });
    expect(panel.dataset.state).toBe("unanswered");
    // The panel is the caller's feedback while the DM is open: no toast too.
    expect(container.querySelector('[data-testid="toast"]')).toBeNull();

    vi.mocked(ws.send).mockClear();
    // Past the server's 3s ring window plus slack, so the redial goes out at once.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 4000);
    (panel.querySelector('[data-testid="dcp-ring-again"]') as HTMLElement).click();
    now.mockRestore();
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    expect(panel.dataset.state).toBe("outgoing");

    // The call timer is the page's to stop.
    page.destroy?.();
  });

  it("a group call is declined once every online callee declined; offline members are not waited on (D-12)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    dmStore.setState((prev) => ({
      channels: prev.channels.map((c) => ({
        ...c,
        isGroup: true,
        participants: [
          ...c.participants,
          { id: 12, username: "dan", avatar: "", status: "offline" as const },
        ],
      })),
    }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();

    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    finishCallJoin();
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("outgoing");

    ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "bob" });
    expect(panel.dataset.state).toBe("unanswered");
    page.destroy?.();
  });

  it("Ring again in a connected group call with a member missing re-rings the group without a Calling… state (3B-8)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    dmStore.setState((prev) => ({
      channels: prev.channels.map((c) => ({
        ...c,
        isGroup: true,
        participants: [
          ...c.participants,
          { id: 12, username: "dan", avatar: "", status: "online" as const },
        ],
      })),
    }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();

    // Alice and bob are in the room; dan is not.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceStatus: "connected" as const,
      voiceUsers: new Map([
        [
          50,
          new Map(
            [
              [1, "alice"],
              [10, "bob"],
            ].map(([userId, username]) => [
              userId as number,
              {
                userId: userId as number,
                username: username as string,
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
              },
            ]),
          ),
        ],
      ]),
    }));
    voiceStore.flush();
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("connected");
    const again = panel.querySelector('[data-testid="dcp-ring-again"]') as HTMLElement;
    expect(again).not.toBeNull();

    vi.mocked(ws.send).mockClear();
    again.click();
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    // Bob is in the call: no ringing state is started over a live call.
    expect(panel.dataset.state).toBe("connected");
    page.destroy?.();
  });

  it("calling an offline 1:1 contact says so at once instead of ringing back for 30 s (D-14)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    dmStore.setState((prev) => ({
      channels: prev.channels.map((c) => ({
        ...c,
        recipient: { ...c.recipient, status: "offline" },
        participants: c.participants.map((p) => ({ ...p, status: "offline" })),
      })),
    }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    vi.mocked(startRingback).mockClear();

    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    finishCallJoin();
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("unanswered");
    expect(panel.querySelector('[data-testid="dcp-caption"]')!.textContent).toBe("bob is offline");
    expect(startRingback).not.toHaveBeenCalled();
    // Still rung: an invisible contact is shown offline but can still answer.
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    page.destroy?.();
  });

  describe("ringing the callee (D-01, D-02, D-05)", () => {
    const rings = (ws: FakeWsClient): unknown[] =>
      vi.mocked(ws.send).mock.calls.filter(([m]) => (m as { type: string }).type === "call_ring");

    async function mountCaller(): Promise<{ ws: FakeWsClient; panel: HTMLElement }> {
      const ws = fakeWs();
      uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
      openOneToOneDm(50);
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      await vi.dynamicImportSettled();
      return { ws, panel: document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement };
    }

    it("rings only once the caller's join has left joining, and keeps the join", async () => {
      const { ws } = await mountCaller();
      mockCreateChatArea.mock.calls[0]![0].onStartCall();
      expect(voiceStore.getState().voiceStatus).toBe("joining");
      expect(rings(ws)).toHaveLength(0);

      finishCallJoin();
      expect(rings(ws)).toHaveLength(1);
      expect(voiceStore.getState().currentChannelId).toBe(50);
      page.destroy?.();
    });

    it("does not ring while the join is still securing or connecting", async () => {
      const { ws } = await mountCaller();
      mockCreateChatArea.mock.calls[0]![0].onStartCall();
      voiceStore.setState((prev) => ({ ...prev, voiceStatus: "securing" as const }));
      voiceStore.flush();
      expect(rings(ws)).toHaveLength(0);

      finishCallJoin();
      expect(rings(ws)).toHaveLength(1);
      page.destroy?.();
    });

    it("drops a delayed Ring again when the caller leaves the call", async () => {
      vi.useFakeTimers();
      try {
        const { ws } = await mountCaller();
        mockCreateChatArea.mock.calls[0]![0].onStartCall();
        finishCallJoin();
        vi.advanceTimersByTime(1000);
        // The callee declines; Ring again inside the spacing window.
        ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "bob" });
        (document.querySelector('[data-testid="dcp-ring-again"]') as HTMLElement).click();
        voiceStore.setState((prev) => ({
          ...prev,
          currentChannelId: null,
          voiceStatus: "idle" as const,
        }));
        voiceStore.flush();

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        page.destroy?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends no ring and shows no Calling… when the join is refused", async () => {
      const { ws, panel } = await mountCaller();
      mockCreateChatArea.mock.calls[0]![0].onStartCall();
      // The dispatcher's join rollback.
      voiceStore.setState((prev) => ({
        ...prev,
        currentChannelId: null,
        voiceStatus: "idle" as const,
      }));
      voiceStore.flush();

      expect(rings(ws)).toHaveLength(0);
      expect(panel.dataset.state).not.toBe("outgoing");
      page.destroy?.();
    });

    it("a second Call 1 s after a ring waits for the server's 3 s window", async () => {
      vi.useFakeTimers();
      try {
        const { ws, panel } = await mountCaller();
        const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
        start();
        finishCallJoin();
        expect(rings(ws)).toHaveLength(1);

        vi.advanceTimersByTime(1000);
        start();
        expect(rings(ws)).toHaveLength(1);

        // Held back the server's 3 s window plus transport slack.
        vi.advanceTimersByTime(2249);
        expect(rings(ws)).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(rings(ws)).toHaveLength(2);
        expect(panel.dataset.state).toBe("outgoing");
        page.destroy?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops a waiting ring when the socket drops before it fires", async () => {
      vi.useFakeTimers();
      try {
        const { ws } = await mountCaller();
        const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
        start();
        finishCallJoin();
        vi.advanceTimersByTime(1000);
        start();
        // An unplanned drop keeps the voice channel, so only the status says so.
        uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        page.destroy?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops a waiting ring across a drop that reconnects before it fires", async () => {
      vi.useFakeTimers();
      try {
        const { ws } = await mountCaller();
        const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
        start();
        finishCallJoin();
        vi.advanceTimersByTime(1000);
        start();
        uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
        uiStore.flush();
        uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
        uiStore.flush();

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        page.destroy?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a margin over the server's 3 s window for transport jitter", async () => {
      vi.useFakeTimers();
      try {
        const { ws } = await mountCaller();
        const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
        start();
        finishCallJoin();
        vi.advanceTimersByTime(1000);
        start();

        vi.advanceTimersByTime(2000);
        expect(rings(ws)).toHaveLength(1);
        vi.advanceTimersByTime(500);
        expect(rings(ws)).toHaveLength(2);
        page.destroy?.();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a ring the server rate-limits ends the outgoing call", async () => {
      const { ws, panel } = await mountCaller();
      vi.mocked(ws.send).mockImplementation((m) =>
        (m as { type: string }).type === "call_ring" ? "ring-id" : "id",
      );
      mockCreateChatArea.mock.calls[0]![0].onStartCall();
      finishCallJoin();
      expect(panel.dataset.state).toBe("outgoing");

      ws.emit("error", { code: "RATE_LIMITED", message: "too many call attempts" }, "other-id");
      expect(panel.dataset.state).toBe("outgoing");
      ws.emit("error", { code: "RATE_LIMITED", message: "too many call attempts" }, "ring-id");
      expect(panel.dataset.state).not.toBe("outgoing");
      page.destroy?.();
    });

    it("drops a waiting ring when the caller leaves before it fires", async () => {
      vi.useFakeTimers();
      try {
        const { ws } = await mountCaller();
        const start = mockCreateChatArea.mock.calls[0]![0].onStartCall;
        start();
        finishCallJoin();
        vi.advanceTimersByTime(1000);
        start();
        voiceStore.setState((prev) => ({
          ...prev,
          currentChannelId: null,
          voiceStatus: "idle" as const,
        }));
        voiceStore.flush();

        vi.advanceTimersByTime(5000);
        expect(rings(ws)).toHaveLength(1);
        page.destroy?.();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("a ring refused because the callee has not accepted ends the outgoing call at once (D-03)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    vi.mocked(stopRingback).mockClear();

    vi.mocked(ws.send).mockImplementation((m) =>
      (m as { type: string }).type === "call_ring" ? "ring-id" : "id",
    );
    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    finishCallJoin();
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("outgoing");

    const refusal = {
      code: "CALL_REQUIRES_ACCEPTANCE",
      message: "calls work after the other person accepts your message request",
    };
    // A refusal answering an earlier ring (another envelope id) leaves this
    // newer outgoing call alone.
    ws.emit("error", refusal, "an-earlier-ring");
    expect(stopRingback).not.toHaveBeenCalled();
    expect(panel.dataset.state).toBe("outgoing");

    ws.emit("error", refusal, "ring-id");

    expect(stopRingback).toHaveBeenCalledTimes(1);
    expect(panel.dataset.state).not.toBe("outgoing");
    expect(panel.dataset.state).not.toBe("unanswered");
    page.destroy?.();
  });

  describe("any error answering the ring ends the outgoing call", () => {
    async function mountRinging(): Promise<HTMLElement> {
      const ws = fakeWs();
      uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
      openOneToOneDm(50);
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      await vi.dynamicImportSettled();
      vi.mocked(stopRingback).mockClear();
      vi.mocked(ws.send).mockImplementation((m) =>
        (m as { type: string }).type === "call_ring" ? "ring-id" : "id",
      );
      mockCreateChatArea.mock.calls[0]![0].onStartCall();
      finishCallJoin();
      const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
      expect(panel.dataset.state).toBe("outgoing");
      ringWs = ws;
      return panel;
    }
    let ringWs: ReturnType<typeof fakeWs>;

    it.each(["FORBIDDEN", "TIMED_OUT", "VOICE_ERROR", "INTERNAL"])(
      "%s answering the ring stops the ringback and clears Calling",
      async (code) => {
        const panel = await mountRinging();

        ringWs.emit("error", { code, message: "refused" }, "ring-id");

        expect(stopRingback).toHaveBeenCalledTimes(1);
        expect(panel.dataset.state).not.toBe("outgoing");
        expect(panel.dataset.state).not.toBe("unanswered");
        page.destroy?.();
      },
    );

    it("a FORBIDDEN error answering another envelope leaves the call alone", async () => {
      const panel = await mountRinging();

      ringWs.emit("error", { code: "FORBIDDEN", message: "refused" }, "other-id");

      expect(stopRingback).not.toHaveBeenCalled();
      expect(panel.dataset.state).toBe("outgoing");
      page.destroy?.();
    });
  });

  it("a callee's decline while the caller is on another channel shows one toast", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    vi.mocked(startRingback).mockClear();
    vi.mocked(stopRingback).mockClear();

    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    finishCallJoin();
    expect(startRingback).toHaveBeenCalledTimes(1);
    // The caller moves on to another channel while the callee decides.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();

    ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "bob" });

    expect(stopRingback).toHaveBeenCalledTimes(1);
    const toasts = container.querySelectorAll('[data-testid="toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("bob declined");

    page.destroy?.();
  });

  it("an unanswered ring while the caller is on another channel shows one 'No answer' toast", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();

    // Catch the outgoing call's own 30s window and run it by hand.
    const realSetTimeout = globalThis.setTimeout;
    let ringTimeout: (() => void) | null = null;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== 30_000) return realSetTimeout(fn, ms);
      ringTimeout = fn;
      return 0;
    }) as unknown as typeof setTimeout);
    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    finishCallJoin();
    timers.mockRestore();

    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();

    expect(ringTimeout).not.toBeNull();
    ringTimeout!();

    expect(stopRingback).toHaveBeenCalled();
    const toasts = container.querySelectorAll('[data-testid="toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain("No answer");

    page.destroy?.();
  });

  it("redialing from inside a live call rings but leaves no outgoing ring behind", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    openOneToOneDm(50);
    const vu = (userId: number, username: string) => ({
      userId,
      username,
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    const roster = (ids: Array<[number, string]>) =>
      new Map([[50, new Map(ids.map(([id, name]) => [id, vu(id, name)]))]]);
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceUsers: roster([
        [1, "alice"],
        [10, "bob"],
      ]),
    }));
    voiceStore.flush();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    // The panel is a lazy chunk.
    await vi.dynamicImportSettled();

    mockCreateChatArea.mock.calls[0]![0].onStartCall();
    expect(ws.send).toHaveBeenCalledWith({ type: "call_ring", payload: { channel_id: 50 } });
    const panel = document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
    expect(panel.dataset.state).toBe("connected");

    // Bob hangs up before any other voice change: the panel must not start
    // "Calling bob…" about someone who was just in the call.
    voiceStore.setState((prev) => ({ ...prev, voiceUsers: roster([[1, "alice"]]) }));
    voiceStore.flush();
    expect(panel.dataset.state).toBe("connected");

    page.destroy?.();
  });

  it("shows the caller's nickname on the incoming-call banner, not the raw username (OC-0303)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    membersStore.setState(() => ({
      members: new Map([
        [
          10,
          {
            id: 10,
            username: "alice_1998",
            avatar: null,
            role: "member",
            status: "online" as const,
            displayName: "Ali",
          },
        ],
      ]),
      typingUsers: new Map(),
      roleRevision: 0,
    }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    // Alice (10) has set a nickname of "Ali" -- every other identity surface
    // (voice roster, member list, DM header) resolves through it, so the
    // ring must too instead of showing the raw handle.
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice_1998" });

    const title = document.querySelector('[data-testid="incoming-call-title"]') as HTMLElement;
    expect(title.textContent).toBe("Ali is calling");
  });

  it("falls back to the raw username on the incoming-call banner when the caller isn't in the members store (OC-0303)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 999, username: "stranger" });

    const title = document.querySelector('[data-testid="incoming-call-title"]') as HTMLElement;
    expect(title.textContent).toBe("stranger is calling");
  });

  it("does not cancel an incoming ring when a fellow group-DM callee declines, only when the actual ringer does (OC-0114)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    // Alice (10) rings a group DM; this client is a third participant.
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).not.toBe("none");

    // Bob (11), a different callee in the same group DM, declines. The
    // server addresses call_declined to every other participant (not just
    // the caller — it holds no call state to target with), so this client
    // receives it too, but it must not silence a ring it is still deciding
    // on: Bob declining is not Alice hanging up.
    ws.emit("call_declined", { channel_id: 50, from_user: 11, username: "bob" });

    expect(banner.style.display).not.toBe("none");

    // The actual ringer's own call_declined (e.g. a glare decline) still
    // cancels it.
    ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "alice" });

    expect(banner.style.display).toBe("none");
  });

  it("does not cancel an incoming ring on a voice_leave for a different channel from the ringer (OC-0011)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    // Alice (10) rings this client's DM (channel 50).
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    vi.mocked(alertMissedCall).mockClear();
    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).not.toBe("none");

    // Alice also happens to be sitting in an unrelated server voice channel
    // (99) and leaves it. Same user, wrong channel: this must not silence
    // the DM ring — only a voice_leave for the ring's own channel (50) may.
    ws.emit("voice_leave", { channel_id: 99, user_id: 10 });

    expect(banner.style.display).not.toBe("none");

    // Alice leaving the ring's own channel (the DM she was calling from)
    // still cancels it.
    ws.emit("voice_leave", { channel_id: 50, user_id: 10 });

    expect(banner.style.display).toBe("none");
    // The ringer hanging up first is a missed call, same notice as a timeout (D-07).
    await vi.waitFor(() => expect(alertMissedCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertMissedCall).mock.calls[0]![0]).toMatchObject({ channelId: 50 });
  });

  it("does not cancel a group-DM ring when the ringer leaves voice but another callee is still in the call (OC-0235)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    // Alice (10) rings a group DM (channel 50); this client is a third
    // participant (C).
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).not.toBe("none");

    // Bob (11) already accepted and is sitting in the DM's voice channel.
    // The dispatcher's own voice_leave handler may already have removed
    // Alice from the roster by the time this fires (order-independent), so
    // her entry is absent here too — only Bob remains.
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          50,
          new Map([
            [
              11,
              {
                userId: 11,
                username: "bob",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();

    // Alice, the ringer, hangs up. The call is still live — Bob is in it —
    // so this client's own one-click Accept must not disappear.
    ws.emit("voice_leave", { channel_id: 50, user_id: 10 });

    expect(banner.style.display).not.toBe("none");
  });

  it("stops a group ring when the last person leaves after the ringer did (D-06)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;

    const carol = {
      userId: 11,
      username: "carol",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    };
    const roster = (users: (typeof carol)[]) => {
      voiceStore.setState((prev) => ({
        ...prev,
        voiceUsers: new Map([[50, new Map(users.map((u) => [u.userId, u]))]]),
      }));
      voiceStore.flush();
    };
    // alice leaves while carol stays: the ring stays (OC-0235).
    roster([carol]);
    ws.emit("voice_leave", { channel_id: 50, user_id: 10 });
    expect(banner.style.display).not.toBe("none");

    // carol, not the ringer, empties the room: the ring is over.
    roster([]);
    ws.emit("voice_leave", { channel_id: 50, user_id: 11 });
    expect(banner.style.display).toBe("none");
  });

  it("silently ends an incoming ring once this client is in the ringing channel by any path", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).not.toBe("none");

    // Joined without Accept (the header's call button, the Join strip, the
    // sidebar): being in the room answers the ring.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50 }));
    voiceStore.flush();

    expect(banner.style.display).toBe("none");
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "call_decline" }));
  });

  it("a ring raises one call alert, and a redial of the same ring none", async () => {
    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    vi.mocked(alertIncomingCall).mockClear();

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertIncomingCall).mock.calls[0]![0]).toMatchObject({
      channelId: 50,
      fromUserId: 10,
    });
  });

  it("a ring that times out reports one missed call; one the ringer cancelled reports none", async () => {
    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    vi.mocked(alertMissedCall).mockClear();
    vi.mocked(alertIncomingCall).mockClear();

    // The ringer hangs up first: not a missed call.
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));
    ws.emit("call_declined", { channel_id: 50, from_user: 10 });
    // Catch the ring's 30s timer and run it by hand: fake timers would also
    // stall the dynamic import that loads the alert chunk.
    const realSetTimeout = globalThis.setTimeout;
    let ringTimeout: (() => void) | null = null;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== 30_000) return realSetTimeout(fn, ms);
      ringTimeout = fn;
      return 0;
    }) as unknown as typeof setTimeout);
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    timers.mockRestore();
    expect(ringTimeout).not.toBeNull();
    // Let this ring's own alert land first: a mocked module imported again
    // while that import is still in flight resolves to the real one here.
    await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(2));
    ringTimeout!();

    await vi.waitFor(() => expect(alertMissedCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertMissedCall).mock.calls[0]![0]).toMatchObject({ channelId: 50 });
    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).toBe("none");
  });

  describe("a ring for a group the user loses", () => {
    const groupRow = (channelId: number) => ({
      channelId,
      recipient: { id: 10, username: "alice", avatar: "", status: "online" },
      participants: [
        { id: 10, username: "alice", avatar: "", status: "online" },
        { id: 11, username: "bob", avatar: "", status: "online" },
      ],
      name: "Group Chat",
      isGroup: true,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    });
    const banner = () =>
      document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;

    it("is cancelled with no missed call when the group leaves dmStore", async () => {
      const ws = fakeWs();
      dmStore.setState(() => ({ channels: [groupRow(50)] }));
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      vi.mocked(alertMissedCall).mockClear();
      vi.mocked(alertIncomingCall).mockClear();

      ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
      await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));
      expect(banner().style.display).not.toBe("none");

      // Left, or removed by the owner: the group drops out of the store.
      dmStore.setState(() => ({ channels: [] }));
      dmStore.flush();

      expect(banner().style.display).toBe("none");
      expect(alertMissedCall).not.toHaveBeenCalled();
    });

    it("is not cancelled by dmStore changes while its channel was never listed", async () => {
      const ws = fakeWs();
      dmStore.setState(() => ({ channels: [groupRow(60)] }));
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);
      vi.mocked(alertIncomingCall).mockClear();

      // The ring beats its dm_channel_open: channel 50 is not in dmStore yet.
      ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
      await vi.waitFor(() => expect(alertIncomingCall).toHaveBeenCalledTimes(1));

      // An unrelated group goes away, then another DM changes.
      dmStore.setState(() => ({ channels: [] }));
      dmStore.flush();
      dmStore.setState(() => ({ channels: [groupRow(61)] }));
      dmStore.flush();

      expect(banner().style.display).not.toBe("none");
    });
  });

  // OC-0037 / OC-0204: DND silences the tone and the popup (call-alerts.test.ts),
  // never the banner — it is the one way left to answer.
  it("DND keeps the banner", () => {
    saveUserStatus("dnd");
    try {
      const ws = fakeWs();
      page = createMainPage({ ws, api: fakeApi() });
      page.mount(container);

      ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

      const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
      expect(banner.style.display).not.toBe("none");
    } finally {
      saveUserStatus("online");
    }
  });

  it("does not ring for the channel this client is already in", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50 }));
    voiceStore.flush();

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    vi.mocked(startRingChime).mockClear();

    // Someone else in the call redials the DM: the server rings everyone
    // else in it, this client included.
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).toBe("none");
    expect(startRingChime).not.toHaveBeenCalled();
  });

  it("clears settingsOpen on destroy so the next page (e.g. ConnectPage after logout) doesn't inherit a stale open overlay", () => {
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));

    page.destroy?.();

    expect(uiStore.getState().settingsOpen).toBe(false);
  });

  it("scopes per-user volume prefs to the connected host, like channel mutes and the NSFW gate (B3-6)", () => {
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    expect(mockSetAudioVolumeHost).toHaveBeenCalledWith("");
  });

  it("closes an open image lightbox on destroy so it doesn't survive onto the next page (B6-15)", () => {
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    openImageLightbox("https://example.com/pic.png", "pic");
    expect(document.body.querySelector(".image-lightbox")).not.toBeNull();

    page.destroy?.();

    expect(document.body.querySelector(".image-lightbox")).toBeNull();
  });

  it("clears every external-content cache on sign-out so one server's previews never reach the next (B7-16)", async () => {
    const preview = vi.spyOn(desktop.externalContent, "preview").mockResolvedValue({
      ok: true,
      value: { title: "T", description: null, siteName: null, image: null },
    });
    const image = vi
      .spyOn(desktop.externalContent, "image")
      .mockResolvedValue({ ok: true, value: new Blob(["x"]) });
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:teardown");
    URL.revokeObjectURL = vi.fn();
    const pageUrl = "https://news.example.com/teardown";
    const imageUrl = "https://img.example.com/teardown.png";
    const asked = (url: string): number => preview.mock.calls.filter((c) => c[1] === url).length;
    const fetched = (url: string): number =>
      image.mock.calls.filter((c) => "url" in c[1] && c[1].url === url).length;
    const oembed = (): number =>
      preview.mock.calls.filter((c) => c[1].includes("oembed") && c[1].includes("tdvid")).length;
    try {
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);

      // Fill each external cache once, and prove a re-render is served from it.
      renderGenericLinkPreview(pageUrl);
      renderYouTubeEmbed("tdvid", "https://youtu.be/tdvid");
      await fetchExternalImage({ url: imageUrl });
      await vi.waitFor(() => expect(asked(pageUrl) + oembed()).toBe(2));
      await new Promise((r) => setTimeout(r, 0));
      renderGenericLinkPreview(pageUrl);
      renderYouTubeEmbed("tdvid", "https://youtu.be/tdvid");
      await fetchExternalImage({ url: imageUrl });
      expect(asked(pageUrl)).toBe(1);
      expect(oembed()).toBe(1);
      expect(fetched(imageUrl)).toBe(1);
      const partitionBefore = externalPartition();

      // The caches reset with the session (sessionRegistry, cache phase); the
      // page itself only tears down its DOM and controllers.
      clearAuth("server_switch");
      page.destroy?.();

      // Every one of them is asked for again, under a fresh broker partition.
      expect(externalPartition()).not.toBe(partitionBefore);
      renderGenericLinkPreview(pageUrl);
      renderYouTubeEmbed("tdvid", "https://youtu.be/tdvid");
      await fetchExternalImage({ url: imageUrl });
      await vi.waitFor(() => {
        expect(asked(pageUrl)).toBe(2);
        expect(oembed()).toBe(2);
      });
      expect(fetched(imageUrl)).toBe(2);
      expect(image).toHaveBeenLastCalledWith(externalPartition(), { url: imageUrl });
    } finally {
      preview.mockRestore();
      image.mockRestore();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it("scopes DM profile notes to the connected host, like channel mutes and the NSFW gate (OC-0143)", async () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(60, dmChannel(60, "dm-carol"));
      return { ...prev, channels: ch, activeChannelId: 60 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 60,
          recipient: { id: 5, username: "carol", avatar: "", status: "online" },
          participants: [{ id: 5, username: "carol", avatar: "", status: "online" }],
          name: "carol",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));

    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      getReactionUsers: vi.fn(async () => ({ users: [] })),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => []),
    } as unknown as ApiClient;

    page = createMainPage({ ws: fakeWs(), api: hostedApi });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();
    // The panel loads on demand; wait for its import to mount it.
    await vi.waitFor(() => {
      expect(
        capturedChatAreaRef.current!.dmProfileSlot.querySelector('[data-testid="dps-note"]'),
      ).not.toBeNull();
    });

    const noteEl = capturedChatAreaRef.current!.dmProfileSlot.querySelector(
      '[data-testid="dps-note"]',
    ) as HTMLTextAreaElement;
    noteEl.value = "owes me money";
    noteEl.dispatchEvent(new Event("input"));

    try {
      // Server A's note about user 5 must land under a key scoped to server A
      // — the same host scoping already applied to channel mutes and
      // per-user volume (setChannelMutesHost/setAudioVolumeHost, both called
      // with apiConfig.host above).
      expect(localStorage.getItem("owncord:dm-note:chat.example.com:5")).toBe("owes me money");
      // And it must not have gone to the legacy unscoped key, which server
      // B's unrelated user 5 would also read from.
      expect(localStorage.getItem("owncord:dm-note:5")).toBeNull();
    } finally {
      localStorage.removeItem("owncord:dm-note:chat.example.com:5");
      localStorage.removeItem("owncord:dm-note:5");
    }
  });

  it("surfaces the server's partial-success warning on a password change instead of an unqualified success (OC-0314)", async () => {
    // PUT /users/me/password answers 200 + warning (not 204) when the
    // password changed but the other sessions could not be revoked. The
    // warning is the only thing telling the user to revoke them by hand,
    // so a green "changed successfully" toast here would hide a live
    // stolen session.
    const warning =
      "password changed, but other sessions could not be revoked; revoke them from the sessions list";
    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      changePassword: vi.fn(async () => ({ warning, sessions_revoked: 0 })),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => []),
    } as unknown as ApiClient;

    page = createMainPage({ ws: fakeWs(), api: hostedApi });
    page.mount(container);
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    // The store notifies on the next tick, and opening rebuilds the live
    // Account tab then — drive the form a user would see, not the
    // placeholder built at mount.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inputs = [...container.querySelectorAll<HTMLInputElement>("input[type='password']")];
    const byPlaceholder = (placeholder: string): HTMLInputElement => {
      const el = inputs.find((i) => i.placeholder === placeholder);
      if (el === undefined) throw new Error(`no password input with placeholder ${placeholder}`);
      return el;
    };
    byPlaceholder("Old password").value = "old-password";
    byPlaceholder("New password").value = "new-password-1";
    byPlaceholder("Confirm new password").value = "new-password-1";
    const changeBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Change Password",
    );
    if (changeBtn === undefined) throw new Error("no Change Password button");
    changeBtn.click();

    await vi.waitFor(() => {
      expect(hostedApi.changePassword).toHaveBeenCalledWith("old-password", "new-password-1");
      const toast = container.querySelector('[data-testid="toast"]');
      expect(toast).not.toBeNull();
      expect(toast!.classList.contains("toast-warning")).toBe(true);
      expect(toast!.textContent).toBe(warning);
    });
    expect(container.querySelector(".toast-success")).toBeNull();
    // The form carries the same warning inline (Codex P2 on PR #1503): no
    // green "changed successfully" beside the warning toast.
    // The toast is shown before the callback resolves, so the form's own
    // update lands a microtask later.
    const status = container.querySelector<HTMLElement>('[data-testid="pw-change-status"]');
    expect(status).not.toBeNull();
    await vi.waitFor(() => {
      expect(status!.textContent).toBe(warning);
    });
    // B9-23: the inline warning is the qualified .form-warning class, not an
    // inline --yellow (1.89:1 on light), and keeps the live role it was
    // created with so the swap to the warning text is announced.
    expect(status!.classList.contains("form-warning")).toBe(true);
    expect(status!.getAttribute("role")).toBe("alert");
    expect(container.textContent).not.toContain("Password changed successfully.");
  });

  it("shows Signed in elsewhere on SESSION_REPLACED, and Use here reconnects this device (B7-14)", async () => {
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    uiStore.setState((prev) => ({
      ...prev,
      sessionReplaced: true,
      connectionStatus: "disconnected",
    }));
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    await vi.waitFor(() => {
      expect(banner.textContent).toBe("Signed in elsewhere Use here");
    });
    banner.querySelector("button")!.click();

    expect(ws.connect).toHaveBeenCalledWith(
      { host: "chat.example.com", token: "tok-here" },
      { takeover: true },
    );
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });

  it("shows an actionable connection notice on disconnect and Retry redials (B9-25)", async () => {
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    uiStore.setState((prev) => ({
      ...prev,
      sessionReplaced: false,
      connectionStatus: "disconnected",
    }));
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    await vi.waitFor(() => {
      expect(banner.textContent).toContain("Can't reach this server");
    });

    const retry = banner.querySelector("button")!;
    expect(retry.textContent).toBe("Retry");
    retry.click();
    expect(ws.connect).toHaveBeenCalledWith({ host: "chat.example.com", token: "tok-here" });
  });

  it("keeps Reconnecting... until a dial fails, then offers Retry (B9-25)", async () => {
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    uiStore.setState((prev) => ({
      ...prev,
      sessionReplaced: false,
      connectionStatus: "reconnecting",
      connectionDialFailed: false,
    }));
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    await vi.waitFor(() => {
      expect(banner.textContent).toBe("Reconnecting...");
    });
    expect(banner.querySelector("button")).toBeNull();

    // Same 3-state status: only the dial outcome changed.
    uiStore.setState((prev) => ({ ...prev, connectionDialFailed: true }));
    await vi.waitFor(() => {
      expect(banner.textContent).toContain("Can't reach this server");
    });
    banner.querySelector("button")!.click();
    expect(ws.connect).toHaveBeenCalledWith({ host: "chat.example.com", token: "tok-here" });
    uiStore.setState((prev) => ({ ...prev, connectionDialFailed: false }));
  });

  it("holds one unreachable notice and Retry across repeated failed dials (B9-25)", async () => {
    const socket = createMockWsClient();
    const unwire = wireConnectionStatus(socket);
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    socket.simulateStateChange("connecting");
    socket.simulateStateChange("authenticating");
    socket.simulateStateChange("connected");
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    const live = container.querySelector<HTMLElement>("[data-testid='banner-announce']")!;
    const unreachable =
      "Can't reach this server right now. It may be down or blocked on this network.";
    const announced: string[] = [];
    const observer = new MutationObserver(() => announced.push(live.textContent ?? ""));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    const settle = async (): Promise<void> => {
      uiStore.flush();
      await Promise.resolve();
    };

    try {
      socket.simulateStateChange("reconnecting");
      await settle();
      expect(banner.textContent).toBe("Reconnecting...");

      socket.simulateStateChange("connecting");
      socket.simulateStateChange("reconnecting");
      await settle();
      expect(banner.textContent).toBe(`${unreachable} Retry`);

      for (let cycle = 0; cycle < 2; cycle++) {
        socket.simulateStateChange("connecting");
        await settle();
        expect(banner.textContent).toBe(`${unreachable} Retry`);
        expect(banner.querySelector("button")).not.toBeNull();
        socket.simulateStateChange("reconnecting");
        await settle();
        expect(banner.textContent).toBe(`${unreachable} Retry`);
        expect(banner.querySelector("button")).not.toBeNull();
      }

      expect(announced.filter((text) => text === unreachable)).toHaveLength(1);
    } finally {
      observer.disconnect();
      unwire();
      uiStore.setState((prev) => ({
        ...prev,
        connectionStatus: "disconnected",
        connectionDialFailed: false,
      }));
    }
  });

  it("re-renders the notice on network loss and return without redialing (B9-25)", async () => {
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    uiStore.setState((prev) => ({
      ...prev,
      sessionReplaced: false,
      connectionStatus: "disconnected",
    }));
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    await vi.waitFor(() => {
      expect(banner.textContent).toContain("Can't reach this server");
    });

    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      window.dispatchEvent(new Event("offline"));
      expect(banner.textContent).toContain("Your device reports no network connection");

      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event("online"));
      expect(banner.textContent).toContain("Can't reach this server");
    } finally {
      onLine.mockRestore();
    }
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("does not clear a pending restart countdown on a network flap (B9-25)", () => {
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    // The server announces a restart while the socket is live.
    ws.emit("server_restart", { reason: "update", delay_seconds: 30 });
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    expect(banner.textContent).toBe("Server restarting in 30 seconds...");

    // A network interface flaps (VPN toggle / Wi-Fi blip) during the
    // countdown. The socket never dropped, so the countdown must survive.
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(banner.textContent).toBe("Server restarting in 30 seconds...");
    expect(banner.classList.contains("visible")).toBe(true);
  });

  it("counts down a shutdown notice too: the session survives a restart (Q4)", () => {
    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi("chat.example.com") });
    page.mount(container);

    ws.emit("server_restart", { reason: "shutdown", delay_seconds: 5 });
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    expect(banner.textContent).toBe("Server restarting in 5 seconds...");
    expect(banner.classList.contains("visible")).toBe(true);
  });

  it("clears local auth when sign-out-everywhere revoked this device's session (B7-14)", async () => {
    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => []),
      revokeAllSessions: vi.fn(async () => ({
        sessions_revoked: 2,
        current_session_revoked: true,
      })),
    } as unknown as ApiClient;
    authStore.setState((prev) => ({ ...prev, isAuthenticated: true, token: "tok" }));
    page = createMainPage({ ws: fakeWs(), api: hostedApi });
    page.mount(container);
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    container.querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all"]')!.click();
    container
      .querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all-confirm"]')!
      .click();

    await vi.waitFor(() => {
      expect(hostedApi.revokeAllSessions).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(authStore.getState().isAuthenticated).toBe(false);
    });
  });

  it("toasts a sign-in not yet reviewed from the listing made on mount (B7-14)", async () => {
    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => [
        {
          id: 9,
          device: "OwnCord-Client/1.4.0",
          ip: "198.51.100.2",
          created_at: "2026-09-21 08:00:00",
          last_used: "2026-09-21 08:00:00",
          is_current: false,
          unseen: true,
        },
      ]),
    } as unknown as ApiClient;
    page = createMainPage({ ws: fakeWs(), api: hostedApi });
    page.mount(container);

    await vi.waitFor(() => {
      const toast = container.querySelector('[data-testid="toast"]');
      expect(toast?.textContent).toContain("OwnCord desktop from 198.51.100.2");
    });
  });

  it("keeps the open DM profile panel's status and name live, like the chat header does (OC-0309)", async () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(70, dmChannel(70, "dm-bob"));
      return { ...prev, channels: ch, activeChannelId: 70 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 70,
          recipient: { id: 7, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 7, username: "bob", avatar: "", status: "online" }],
          name: "bob",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();

    const slot = capturedChatAreaRef.current!.dmProfileSlot;
    // The panel loads on demand; wait for its import to mount it.
    await vi.waitFor(() => {
      expect(slot.querySelector('[data-testid="dps-status"]')).not.toBeNull();
    });
    const statusEl = slot.querySelector('[data-testid="dps-status"]') as HTMLElement;
    const nameEl = slot.querySelector('[data-testid="dps-username"]') as HTMLElement;
    expect(statusEl.textContent).toContain("Online");
    expect(nameEl.textContent).toBe("bob");

    // Bob goes offline and sets a nickname while the panel stays open, via
    // the same updateDmParticipant call dispatcher.ts's PRESENCE and
    // USER_UPDATE handlers make. The chat header this panel was opened from
    // already stays live across this (ChannelController.ts:621-638) — the
    // profile panel beside it must not be left showing the opposite.
    updateDmParticipant(7, { status: "offline", displayName: "Bobby" });
    dmStore.flush();

    expect(statusEl.textContent).toContain("Offline");
    expect(nameEl.textContent).toBe("Bobby");
  });

  /** Mount the page on a DM with bob and return its profile toggle and slot. */
  function mountOnDm(): { toggle: () => void; slot: HTMLElement } {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(70, dmChannel(70, "dm-bob"));
      return { ...prev, channels: ch, activeChannelId: 70 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 70,
          recipient: { id: 7, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 7, username: "bob", avatar: "", status: "online" }],
          name: "bob",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    return {
      toggle: () => chatAreaOpts.onToggleDmProfile(),
      slot: capturedChatAreaRef.current!.dmProfileSlot,
    };
  }

  /** Let the panel's lazy import (and anything it schedules) settle. */
  async function settleDmProfileImport(): Promise<void> {
    await import("@components/DmProfileSidebar");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("a close click while the DM profile panel is still loading leaves it closed", async () => {
    const { toggle, slot } = mountOnDm();
    toggle();
    toggle();
    await settleDmProfileImport();
    expect(slot.querySelector('[data-testid="dps-status"]')).toBeNull();

    // The dropped load does not wedge the toggle: the next click opens it.
    toggle();
    await vi.waitFor(() => {
      expect(slot.querySelectorAll('[data-testid="dps-status"]')).toHaveLength(1);
    });
  });

  it("the DM row menu's Profile on a DM that is not active shows that DM's panel (WP 3B-2)", async () => {
    const { slot } = mountOnDm();
    const bob = dmStore.getState().channels[0]!;
    dmStore.setState(() => ({
      channels: [
        bob,
        {
          ...bob,
          channelId: 71,
          recipient: { id: 8, username: "carol", avatar: "", status: "online" },
          participants: [{ id: 8, username: "carol", avatar: "", status: "online" }],
          name: "carol",
        },
      ],
    }));
    const sidebarOpts = mockCreateSidebarArea.mock.calls.at(-1)![0] as {
      onOpenDmProfile: () => void;
    };
    // What SidebarArea's row menu does: select the DM, then ask for the panel
    // in the same tick, before the store's listeners have run.
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(71, dmChannel(71, "dm-carol"));
      return { ...prev, channels: ch };
    });
    setActiveChannel(71);
    sidebarOpts.onOpenDmProfile();
    await vi.waitFor(() => {
      expect(slot.querySelector('[data-testid="dps-username"]')?.textContent).toBe("carol");
    });
    await settleDmProfileImport();
    expect(slot.querySelectorAll('[data-testid="dps-username"]')).toHaveLength(1);
  });

  it("the last of several quick DM profile clicks wins, with one panel at most", async () => {
    const { toggle, slot } = mountOnDm();
    toggle();
    toggle();
    toggle();
    await settleDmProfileImport();
    expect(slot.querySelectorAll('[data-testid="dps-status"]')).toHaveLength(1);

    toggle();
    expect(slot.querySelector('[data-testid="dps-status"]')).toBeNull();
  });
});

describe("MainPage — presence", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    // Match the client's own idea of the signed-in user's status to the
    // freshly-reset (default "online") saved preference, so the mount-time
    // restoreSavedPresence() call (MainPage.ts:340) is the no-op it
    // documents itself as being, and doesn't spend the single presence
    // token before this test gets to exercise applyPresence directly.
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user === null ? null : { ...prev.user, status: "online" },
    }));
    capturedAutoIdleOptions.current = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
    vi.useRealTimers();
    localStorage.removeItem("owncord:settings:userStatus");
    localStorage.removeItem("owncord:settings:userStatusOrigin");
  });

  it("does not tell auto-idle about voice calls: Idle still applies in a call", () => {
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    const options = capturedAutoIdleOptions.current!;
    expect(options).not.toHaveProperty("inCall");
    expect(autoIdleController).not.toHaveProperty("setInCall");

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 7 }));
    voiceStore.flush();
    expect(authStore.getState().user?.status).toBe("online");

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
  });

  it("retries the return-to-online presence_update once the limiter's window reopens instead of dropping it forever (OC-0111)", () => {
    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    const onStatusChange = capturedAutoIdleOptions.current!.onStatusChange;

    // Auto-idle fires idle after ten quiet minutes; this consumes the single
    // presence token (1 per 10s, rate-limiter.ts).
    saveUserStatus("idle", "auto");
    onStatusChange("idle");
    expect(ws.send).toHaveBeenCalledWith({
      type: "presence_update",
      payload: { status: "idle" },
    });
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    // The very first mouse event after that flips back to online milliseconds
    // later (autoIdle.ts's unthrottled return-to-activity path) — the token
    // is still gone, so the frame cannot go out immediately.
    saveUserStatus("online", "manual");
    onStatusChange("online");
    expect(ws.send).not.toHaveBeenCalled();

    // Once the limiter's 10s window reopens (plus the OC-0451 margin that
    // clears the server's receipt-measured window), the deferred "online"
    // frame must still go out — without a retry the server and every other
    // client stay stuck on "idle" forever with no further trigger to correct
    // it.
    vi.advanceTimersByTime(11_000);

    expect(ws.send).toHaveBeenCalledWith({
      type: "presence_update",
      payload: { status: "online" },
    });
  });
});

describe("MainPage — server restart banner", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
    vi.useRealTimers();
  });

  it("re-syncs to the real (connected) status instead of counting down to a fake Reconnecting on an update_aborted cancel (OC-0164)", () => {
    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    // Server announces a real restart countdown.
    ws.emit("server_restart", { reason: "update", delay_seconds: 5 });

    const banner = container.querySelector(".reconnecting-banner") as HTMLElement;
    expect(banner.classList.contains("visible")).toBe(true);
    expect(banner.textContent).toBe("Server restarting in 5 seconds...");

    // The staged update then fails to swap; the server cancels the countdown
    // it already announced with a zero-delay update_aborted broadcast
    // (Server/admin/update_handlers.go:181). The socket never actually
    // dropped — uiStore.connectionStatus is still "connected".
    expect(uiStore.getState().connectionStatus).toBe("connected");
    ws.emit("server_restart", { reason: "update_aborted", delay_seconds: 0 });

    // The banner must re-sync to the real (connected) status — hidden — not
    // count down to a permanent "Reconnecting..." over a healthy connection.
    expect(banner.classList.contains("visible")).toBe(false);

    // And nothing left running should later flip it to Reconnecting either
    // (the buggy path fed 0 into showRestart's setInterval, which falls
    // through remaining<=0 into showReconnecting on the very next tick).
    vi.advanceTimersByTime(2000);
    expect(banner.textContent).not.toBe("Reconnecting...");
    expect(banner.classList.contains("visible")).toBe(false);
  });
});

describe("MainPage — mark-all-read teardown (OC-0418)", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
    vi.useRealTimers();
  });

  it("cancels a queued Mark All as Read burst on destroy instead of letting it fire after the page is torn down", () => {
    // Five unread channels: read-state.ts paces sends in bursts of 4 per
    // 1100ms, so the 5th send is queued behind a timer instead of going out
    // synchronously.
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(1, { ...textChannel(1, "c1"), unreadCount: 1 });
      ch.set(2, { ...textChannel(2, "c2"), unreadCount: 1 });
      ch.set(3, { ...textChannel(3, "c3"), unreadCount: 1 });
      ch.set(4, { ...textChannel(4, "c4"), unreadCount: 1 });
      ch.set(5, { ...textChannel(5, "c5"), unreadCount: 1 });
      return { ...prev, channels: ch, activeChannelId: null };
    });

    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    // Mount can itself send (e.g. a presence re-sync) — clear those so the
    // counts below track only the mark_read burst.
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    markAllRead();

    // Only the first burst (4 channels) goes out synchronously; channel 5's
    // send is still sitting in the paced tail.
    const sendCallsAtClick = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(sendCallsAtClick).toBe(4);
    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(1);

    // The user logs out / switches server before the paced tail fires. With
    // no next MainPage having mounted yet to re-register the mark-read
    // sender, this connection has been abandoned and the queued send has
    // nowhere legitimate to go.
    page.destroy?.();

    vi.advanceTimersByTime(2000);

    // The stale timer must not have fired a mark_read for channel 5 against
    // this (now-torn-down) connection, and must not have wiped its local
    // unread badge either.
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCallsAtClick);
    expect(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) =>
          (call[0] as { type: string; payload: { channel_id: number } }).type === "mark_read" &&
          call[0].payload.channel_id === 5,
      ),
    ).toBe(false);
    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(1);
  });
});

// B7-15c: a successful self-deletion drops that account's cached server
// images from disk, keyed by the same host#userId scope B7-13 caches under.
describe("MainPage — account deletion", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    mockPruneAttachmentCacheScope.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
  });

  async function deleteAccount(api: ApiClient): Promise<void> {
    page = createMainPage({ ws: fakeWs(), api });
    page.mount(container);
    // The Account tab (and its delete control) is only built once Settings is
    // open (DP-52), so open it before driving the delete flow.
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    uiStore.flush();
    (document.querySelector("[data-testid='delete-account-trigger']") as HTMLElement).click();
    (document.querySelector("[data-testid='delete-account-password']") as HTMLInputElement).value =
      "pw";
    (document.querySelector("[data-testid='delete-account-confirm']") as HTMLElement).click();
    await vi.waitFor(() => expect(api.deleteAccount).toHaveBeenCalledWith("pw"));
    await Promise.resolve();
    await Promise.resolve();
  }

  it("prunes the deleted account's image cache scope after the server confirms", async () => {
    const api = Object.assign(fakeApi("chat.example"), {
      deleteAccount: vi.fn(async () => {}),
    }) as ApiClient;
    await deleteAccount(api);

    await vi.waitFor(() =>
      expect(mockPruneAttachmentCacheScope).toHaveBeenCalledWith("chat.example#1"),
    );
    expect(authStore.getState().isAuthenticated).toBe(false);
  });

  it("account deletion awaits the cache purge before reporting success", async () => {
    let release!: () => void;
    mockPruneAttachmentCacheScope.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const api = Object.assign(fakeApi("chat.example"), {
      deleteAccount: vi.fn(async () => {}),
    }) as ApiClient;
    await deleteAccount(api);
    await vi.waitFor(() => expect(mockPruneAttachmentCacheScope).toHaveBeenCalled());

    expect(container.querySelector(".toast-success")).toBeNull();
    release();
    await vi.waitFor(() => expect(container.querySelector(".toast-success")).not.toBeNull());
  });

  it("prunes nothing when the server refuses the deletion", async () => {
    const api = Object.assign(fakeApi("chat.example"), {
      deleteAccount: vi.fn(async () => {
        throw new Error("Wrong password");
      }),
    }) as ApiClient;
    await deleteAccount(api);

    expect(mockPruneAttachmentCacheScope).not.toHaveBeenCalled();
    expect(authStore.getState().isAuthenticated).toBe(true);
  });
});

describe("MainPage — B9-4 content view wiring", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  type OpenView = (id: "requests" | "moderation", opener: HTMLElement) => void;
  const openView = (): OpenView =>
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenView: OpenView }).onOpenView;

  beforeEach(() => {
    resetStores();
    mockMountChannel.mockClear();
    mockDestroyChannel.mockClear();
    mockReturnToChannel.mockClear();
    mockRememberChannel.mockClear();
    inertModeration.signals.length = 0;
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[1, textChannel(1, "general")]]),
      activeChannelId: 1,
      roles: [{ id: 3, name: "Moderator", color: null, permissions: Permission.MODERATE_MEMBERS }],
    }));
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "alice", avatar: null, role: "Moderator" },
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
  });

  afterEach(() => {
    page.destroy?.();
    container.remove();
  });

  it("saves the server channel for Back before Alt+ArrowDown steps into a DM", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 60,
          recipient: { id: 10, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 10, username: "bob", avatar: "", status: "online" }],
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
    const activeWhenRemembered: Array<number | null> = [];
    mockRememberChannel.mockImplementation(() =>
      activeWhenRemembered.push(channelsStore.getState().activeChannelId),
    );
    // jsdom loads no CSS, so the closed Settings panel would read as an open
    // dialog and block every global shortcut.
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
    const altDown = (): void => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
      );
    };

    // Channels mode: a step stays among server channels; nothing to remember.
    altDown();
    expect(mockRememberChannel).not.toHaveBeenCalled();

    // "View all" opens the DM view with #general still active.
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
    altDown();
    expect(activeWhenRemembered).toEqual([1]);
    expect(channelsStore.getState().activeChannelId).toBe(60);

    mockRememberChannel.mockReset();
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels" }));
  });

  it("places the view column between the chat column and the DM profile slot", () => {
    const view = container.querySelector("[data-testid='feature-view']");
    const chat = capturedChatAreaRef.current!;
    // The thread panel's slot (WP 6.9c) sits right behind the chat column.
    expect(view?.previousElementSibling?.previousElementSibling).toBe(chat.chatArea);
    // The member column (3C-6b) sits between the content view and the DM panel.
    expect(view?.nextElementSibling?.id).toBe("member-column");
    expect(view?.nextElementSibling?.nextElementSibling).toBe(chat.dmProfileSlot);
  });

  it("opens in place of the chat, whose channel is torn down, and closes back", () => {
    const opener = document.createElement("button");
    container.appendChild(opener);
    openView()("moderation", opener);

    expect(mockRememberChannel).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='inert-moderation']")).not.toBeNull();
    expect(capturedChatAreaRef.current!.chatArea.style.display).toBe("none");
    channelsStore.flush();
    expect(mockDestroyChannel).toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>("[data-testid='feature-view-close']")!.click();
    expect(mockReturnToChannel).toHaveBeenCalledTimes(1);
    expect(inertModeration.signals[0]?.aborted).toBe(true);
    expect(capturedChatAreaRef.current!.chatArea.style.display).toBe("");
  });

  it("page teardown clears the view so the next page starts with none", () => {
    openView()("moderation", document.createElement("button"));
    expect(uiStore.getState().activeView).toBe("moderation");

    page.destroy?.();

    expect(inertModeration.signals[0]?.aborted).toBe(true);
    expect(uiStore.getState().activeView).toBeNull();
  });
});

describe("MainPage — member list placement (3C-6b)", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  const memberLists = (): number => document.querySelectorAll('[data-testid="member-list"]').length;
  const live = (): number => memberPanels.created - memberPanels.destroyed;
  const flip = (layout: "right" | "left"): void => savePref("memberListLayout", layout);

  beforeEach(async () => {
    resetStores();
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeView: null }));
    // These tests flip from the left layout; the default has been right since 3C-6c.
    localStorage.setItem("owncord:settings:memberListLayout", '"left"');
    localStorage.removeItem("owncord:settings:memberListOpen");
    memberPanels.created = 0;
    memberPanels.destroyed = 0;
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[1, textChannel(1, "general")]]),
      activeChannelId: 1,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
  });

  afterEach(() => {
    page.destroy?.();
    container.remove();
    localStorage.removeItem("owncord:settings:memberListLayout");
    localStorage.removeItem("owncord:settings:memberListOpen");
  });

  it("builds an always-present, labelled, hidden member column in the app row", () => {
    const column = container.querySelector<HTMLElement>("#member-column")!;
    expect(column.tagName).toBe("ASIDE");
    expect(column.dataset["testid"]).toBe("member-column");
    expect(column.getAttribute("aria-label")).toBe("Member list");
    expect(column.hidden).toBe(true);
    expect(column.parentElement).toBe(container.querySelector('[data-testid="app-layout"]'));
    expect(column.querySelector(".member-column-body")).not.toBeNull();
  });

  it("each layout flip destroys the old member list before it creates the new one", () => {
    for (const layout of ["right", "left", "right", "left"] as const) {
      memberPanels.events.length = 0;
      flip(layout);
      expect(memberPanels.events).toEqual(["destroy", "create"]);
    }
  });

  it("switching layout leaves exactly one member-list in the document", () => {
    // Stored left: the sidebar's section is the only instance.
    expect(memberLists()).toBe(1);
    expect(container.querySelector("#member-column [data-testid='member-list']")).toBeNull();

    flip("right");
    expect(memberLists()).toBe(1);
    expect(container.querySelector("#member-column [data-testid='member-list']")).not.toBeNull();
    expect(live()).toBe(1);

    flip("left");
    expect(memberLists()).toBe(1);
    expect(container.querySelector("#member-column [data-testid='member-list']")).toBeNull();
    expect(live()).toBe(1);

    flip("right");
    expect(memberLists()).toBe(1);
    expect(live()).toBe(1);

    flip("left");
    expect(memberLists()).toBe(1);
    expect(live()).toBe(1);
  });

  it("a flip with a DM on screen leaves no member list in either layout", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(2, dmChannel(2, "dm-with-bob"));
      return { ...prev, channels: ch, activeChannelId: 2 };
    });
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
    flip("right");
    expect(container.querySelector("#member-column [data-testid='member-list']")).toBeNull();
    expect(container.querySelector<HTMLElement>("#member-column")!.hidden).toBe(true);
  });

  it("destroy before the column's chunk loads mounts nothing", async () => {
    page.destroy?.();
    container.replaceChildren();
    memberPanels.created = 0;
    memberPanels.destroyed = 0;
    localStorage.setItem("owncord:settings:memberListLayout", '"right"');

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    page.destroy?.();
    await vi.dynamicImportSettled();

    expect(memberPanels.created).toBe(0);
    expect(document.querySelectorAll('[data-testid="member-list"]').length).toBe(0);
  });

  it("tearing the page down destroys the column's panel", () => {
    flip("right");
    expect(live()).toBe(1);
    page.destroy?.();
    expect(live()).toBe(0);
  });
});

describe("MainPage — focus fallback skips hidden sidebar buttons", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[1, textChannel(1, "general")]]),
      activeChannelId: 1,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
  });

  afterEach(() => {
    page.destroy?.();
    container.remove();
  });

  // A member without MANAGE_INVITES has the sidebar's Invite button hidden
  // (inline display:none), and it is the first button in the sidebar. The
  // channel controller's focusFallback (declining the NSFW gate) must not
  // spend its attempt on it: focusing a hidden control is a no-op and focus
  // would stay on <body>. jsdom does not compute display, so it would take
  // the hidden button's focus; the assertion reads the inline style instead.
  it("lands focus on the first visible sidebar button, not a hidden one", () => {
    const sidebar = container.querySelector<HTMLElement>(
      "[data-testid='app-layout'] > .unified-sidebar",
    )!;
    const hiddenInvite = document.createElement("button");
    hiddenInvite.style.display = "none";
    const visible = document.createElement("button");
    sidebar.append(hiddenInvite, visible);

    const { focusFallback } = mockCreateChannelController.mock.calls.at(-1)![0] as {
      focusFallback: () => void;
    };
    focusFallback();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBeInstanceOf(HTMLButtonElement);
    expect((document.activeElement as HTMLElement).style.display).not.toBe("none");
    expect(document.activeElement).toBe(visible);
  });
});

describe("MainPage — focus fallback when the channel is declined", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    mockCreateChannelController.mockClear();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[1, textChannel(1, "general")]]),
      activeChannelId: null,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
  });

  afterEach(() => {
    page.destroy?.();
    container.remove();
  });

  // Declining the age-restricted gate leaves the channel and hands focus to
  // `focusFallback`. With no composer on screen it must land on a sidebar
  // control that can actually take focus: the header's first button (Mark All
  // as Read) is hidden while nothing is unread, and focusing a hidden button is
  // a silent no-op that leaves focus on <body>.
  it("lands on a visible sidebar button, skipping a hidden first one", () => {
    const sidebar = container.querySelector("[data-testid='app-layout'] > .unified-sidebar")!;
    const hidden = document.createElement("button");
    hidden.style.display = "none";
    const shown = document.createElement("button");
    sidebar.append(hidden, shown);

    const { focusFallback } = mockCreateChannelController.mock.calls.at(-1)![0] as {
      focusFallback: () => void;
    };
    focusFallback();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(shown);
  });
});

describe("MainPage — destroy isolates every teardown step (ARCH-012)", () => {
  /** Live subscriptions on a store: every subscribe minus its unsubscribe. */
  function trackSubscriptions(store: {
    subscribe: (...a: never[]) => () => void;
    subscribeSelector: (...a: never[]) => () => void;
  }): () => number {
    let live = 0;
    for (const method of ["subscribe", "subscribeSelector"] as const) {
      const original = store[method].bind(store) as (...a: unknown[]) => () => void;
      (store as Record<string, unknown>)[method] = (...args: unknown[]) => {
        live += 1;
        const unsub = original(...args);
        let done = false;
        return () => {
          if (!done) live -= 1;
          done = true;
          unsub();
        };
      };
    }
    return () => live;
  }

  it("a throwing early step still runs every later step and every store unsubscription", async () => {
    resetStores();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const stores = [uiStore, channelsStore, voiceStore, dmStore, membersStore, authStore];
    const originals = stores.map((s) => [s.subscribe, s.subscribeSelector] as const);
    const counts = stores.map((s) => trackSubscriptions(s as never));
    const lk = await import("@lib/livekitSession");
    const page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    try {
      page.mount(container);
      mockDestroyChannel.mockClear();
      const live = counts.reduce((n, c) => n + c(), 0);
      expect(live).toBeGreaterThan(0);

      // voiceCleanupAll sits early in destroy: everything after it must still run.
      vi.mocked(lk.cleanupAll).mockImplementationOnce(() => {
        throw new Error("boom");
      });
      expect(() => page.destroy?.()).not.toThrow();

      expect(counts.map((c) => c())).toEqual(counts.map(() => 0));
      expect(mockDestroyChannel).toHaveBeenCalled();
      expect(container.querySelector("[data-testid='app-layout']")).toBeNull();
    } finally {
      stores.forEach((s, i) => {
        s.subscribe = originals[i]![0];
        s.subscribeSelector = originals[i]![1];
      });
      container.remove();
    }
  });
});
