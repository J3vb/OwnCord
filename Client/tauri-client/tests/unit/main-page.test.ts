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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/livekitSession", () => ({
  cleanupAll: vi.fn(),
  setOnRemoteVideo: vi.fn(),
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
}));

vi.mock("@lib/notifications", () => ({
  startRingChime: vi.fn(),
  stopRingChime: vi.fn(),
}));

vi.mock("@lib/autoIdle", () => ({
  startAutoIdle: vi.fn(() => ({ destroy: vi.fn() })),
}));

const {
  mockMountChannel,
  mockDestroyChannel,
  mockCreateChannelController,
  mockCreateSidebarArea,
  mockCreateChatArea,
} = vi.hoisted(() => ({
  mockMountChannel: vi.fn(),
  mockDestroyChannel: vi.fn(),
  mockCreateChannelController: vi.fn(),
  mockCreateSidebarArea: vi.fn(),
  mockCreateChatArea: vi.fn(),
}));

vi.mock("../../src/pages/main-page/ChannelController", () => ({
  createChannelController: (...args: unknown[]) => {
    mockCreateChannelController(...args);
    return {
      mountChannel: mockMountChannel,
      destroyChannel: mockDestroyChannel,
      openFilePicker: vi.fn(),
      currentChannelId: 0,
      messageList: null,
    };
  },
}));

vi.mock("../../src/pages/main-page/SidebarArea", () => ({
  createSidebarArea: (...args: unknown[]) => {
    mockCreateSidebarArea(...args);
    return {
      sidebarWrapper: document.createElement("div"),
      children: [],
      unsubscribers: [],
      openQuickSwitch: vi.fn(),
    };
  },
}));

vi.mock("../../src/pages/main-page/ChatArea", () => ({
  createChatArea: (...args: unknown[]) => {
    mockCreateChatArea(...args);
    return {
      chatArea: document.createElement("div"),
      slots: {
        messagesSlot: document.createElement("div"),
        typingSlot: document.createElement("div"),
        inputSlot: document.createElement("div"),
        videoGridSlot: document.createElement("div"),
      },
      videoGrid: {
        addStream: vi.fn(),
        removeStream: vi.fn(),
        hasStreams: vi.fn(() => false),
        setFocusedTile: vi.fn(),
        getFocusedTileId: vi.fn(() => null),
        mount: vi.fn(),
        destroy: vi.fn(),
      },
      chatHeaderName: document.createElement("span"),
      chatHeaderRefs: {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
      },
      searchCtrl: { open: vi.fn(), cleanup: vi.fn() },
      dmProfileSlot: document.createElement("div"),
      children: [],
      unsubscribers: [],
    };
  },
}));

import { createMainPage } from "../../src/pages/MainPage";
import { channelsStore, setChannels, setActiveChannel } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { dmStore } from "../../src/stores/dm.store";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ApiClient } from "../../src/lib/api";
import type { ServerMessage } from "../../src/lib/types";

function resetStores(): void {
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
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
}

function fakeWs(): WsClient {
  const listeners = new Map<string, Set<WsListener<ServerMessage["type"]>>>();
  return {
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
    onStateChange: vi.fn(() => () => {}),
    onSendFailure: vi.fn(() => () => {}),
    onCertMismatch: vi.fn(() => () => {}),
    onCertFirstUse: vi.fn(() => () => {}),
    startCertListener: vi.fn(async () => {}),
    acceptCertFingerprint: vi.fn(async () => {}),
    getState: vi.fn(() => "connected" as ConnectionState),
    isReplaying: vi.fn(() => false),
    _getWs: vi.fn(() => null),
  };
}

function fakeApi(): ApiClient {
  return {
    getConfig: () => ({ host: "" }),
    getReactionUsers: vi.fn(async () => ({ users: [] })),
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
