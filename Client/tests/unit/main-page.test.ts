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
}));

vi.mock("@lib/notifications", () => ({
  startRingChime: vi.fn(),
  stopRingChime: vi.fn(),
}));

const { mockSetAudioVolumeHost } = vi.hoisted(() => ({
  mockSetAudioVolumeHost: vi.fn(),
}));

// Real audioElements.ts pulls in livekit-client (unmocked elsewhere in this
// file's graph) purely to hold the AudioElements class this page never
// touches directly — mock out the one export MainPage actually calls.
vi.mock("@lib/audioElements", () => ({
  setAudioVolumeHost: mockSetAudioVolumeHost,
}));

const { capturedAutoIdleOptions } = vi.hoisted(() => ({
  capturedAutoIdleOptions: {
    current: null as null | { onStatusChange: (status: string) => void },
  },
}));

vi.mock("@lib/autoIdle", () => ({
  startAutoIdle: (options: { onStatusChange: (status: string) => void }) => {
    capturedAutoIdleOptions.current = options;
    return { destroy: vi.fn() };
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
      slots: {
        messagesSlot: HTMLDivElement;
        typingSlot: HTMLDivElement;
        inputSlot: HTMLDivElement;
        videoGridSlot: HTMLDivElement;
      };
      dmProfileSlot: HTMLDivElement;
      videoGrid: {
        addStream: ReturnType<typeof vi.fn>;
        removeStream: ReturnType<typeof vi.fn>;
        clearStreams: ReturnType<typeof vi.fn>;
        hasStreams: ReturnType<typeof vi.fn>;
        setFocusedTile: ReturnType<typeof vi.fn>;
        getFocusedTileId: ReturnType<typeof vi.fn>;
        setLabel: ReturnType<typeof vi.fn>;
      };
    },
  },
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
    const slots = {
      messagesSlot: document.createElement("div"),
      typingSlot: document.createElement("div"),
      inputSlot: document.createElement("div"),
      videoGridSlot: document.createElement("div"),
    };
    const dmProfileSlot = document.createElement("div");
    const videoGrid = {
      addStream: vi.fn(),
      removeStream: vi.fn(),
      clearStreams: vi.fn(),
      hasStreams: vi.fn(() => false),
      setFocusedTile: vi.fn(),
      getFocusedTileId: vi.fn(() => null),
      setLabel: vi.fn(),
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    capturedChatAreaRef.current = { slots, dmProfileSlot, videoGrid };
    return {
      chatArea: document.createElement("div"),
      slots,
      videoGrid,
      chatHeaderName: document.createElement("span"),
      chatHeaderRefs: {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
      },
      searchCtrl: { open: vi.fn(), cleanup: vi.fn() },
      dmProfileSlot,
      children: [],
      unsubscribers: [],
    };
  },
}));

import { createMainPage } from "../../src/pages/MainPage";
import { channelsStore, setChannels, setActiveChannel } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore, updateVoiceUserProfile } from "../../src/stores/voice.store";
import { dmStore, updateDmParticipant } from "../../src/stores/dm.store";
import { membersStore, updateMemberProfile } from "../../src/stores/members.store";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ApiClient } from "../../src/lib/api";
import type { ServerMessage } from "../../src/lib/types";
import { openImageLightbox } from "../../src/components/message-list/media";
import { saveUserStatus } from "../../src/lib/userStatus";

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
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map(), roleRevision: 0 }));
}

type FakeWsClient = WsClient & {
  /** Test-only: drive a registered `ws.on(type, ...)` listener directly. */
  emit: (type: ServerMessage["type"], payload: unknown) => void;
};

function fakeWs(): FakeWsClient {
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
    emit(type: ServerMessage["type"], payload: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        (listener as (p: unknown, id?: string) => void)(payload);
      }
    },
    onStateChange: vi.fn(() => () => {}),
    onSendFailure: vi.fn(() => () => {}),
    onCertMismatch: vi.fn(() => () => {}),
    onCertFirstUse: vi.fn(() => () => {}),
    startCertListener: vi.fn(async () => {}),
    acceptCertFingerprint: vi.fn(async () => {}),
    getState: vi.fn(() => "connected" as ConnectionState),
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
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
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

    // Put the grid into video mode via a local camera start while in voice
    // (the real, unmocked VideoModeController drives this off voiceStore).
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([[9, new Map()]]),
      localCamera: true,
    }));
    voiceStore.flush();

    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("none");

    // Switch to a DM while the grid is up — a dm channel mounts a chat
    // surface just like text/announcement do, so the grid must not survive
    // the switch and hide it behind an unrelated video grid.
    setActiveChannel(2);
    channelsStore.flush();

    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("");
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
    expect(videoGrid.setLabel).toHaveBeenCalledWith(200, "Robert");
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

  it("does not cancel an incoming ring on a voice_leave for a different channel from the ringer (OC-0011)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    // Alice (10) rings this client's DM (channel 50).
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

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

  it("scopes DM profile notes to the connected host, like channel mutes and the NSFW gate (OC-0143)", () => {
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
      getReactionUsers: vi.fn(async () => ({ users: [] })),
    } as unknown as ApiClient;

    page = createMainPage({ ws: fakeWs(), api: hostedApi });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();

    const noteEl = capturedChatAreaRef.current!.dmProfileSlot.querySelector(
      '[data-testid="dps-note"]',
    ) as HTMLTextAreaElement;
    noteEl.value = "owes me money";
    noteEl.dispatchEvent(new Event("input"));

    try {
      // Server A's note about user 5 must land under a key scoped to server A
      // — the same host scoping already applied to channel mutes, the NSFW
      // gate and per-user volume (setChannelMutesHost/setNsfwGateHost/
      // setAudioVolumeHost, all called with apiConfig.host above).
      expect(localStorage.getItem("owncord:dm-note:chat.example.com:5")).toBe("owes me money");
      // And it must not have gone to the legacy unscoped key, which server
      // B's unrelated user 5 would also read from.
      expect(localStorage.getItem("owncord:dm-note:5")).toBeNull();
    } finally {
      localStorage.removeItem("owncord:dm-note:chat.example.com:5");
      localStorage.removeItem("owncord:dm-note:5");
    }
  });

  it("keeps the open DM profile panel's status and name live, like the chat header does (OC-0309)", () => {
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

    // Once the limiter's 10s window reopens, the deferred "online" frame must
    // still go out — without a retry the server and every other client stay
    // stuck on "idle" forever with no further trigger to correct it.
    vi.advanceTimersByTime(10_000);

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
