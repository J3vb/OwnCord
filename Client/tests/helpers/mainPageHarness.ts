import { afterEach, beforeEach, vi } from "vitest";
import { createMainPage } from "../../src/pages/MainPage";
import { savePref } from "../../src/lib/prefs/preferences";
import { channelsStore, type Channel } from "../../src/stores/channels.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore, type VoiceUser } from "../../src/stores/voice.store";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ApiClient } from "../../src/lib/api";
import type { ServerMessage } from "../../src/lib/types";
import { signInAs, resetChannelsState, resetVoiceState } from "./storeSeeds";
import {
  capturedChatAreaRef,
  mockCreateChatArea,
  mockCreateSidebarArea,
  mockDestroyChannel,
  mockMountChannel,
} from "./mainPageMocks";

export function resetStores(): void {
  resetChannelsState();
  signInAs(
    { id: 1, username: "alice", avatar: null, role: "member" },
    { token: "t", serverName: null },
  );
  uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected", settingsOpen: false }));
  resetVoiceState();
  dmStore.setState(() => ({ channels: [] }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map(), roleRevision: 0 }));
}

export type FakeWsClient = WsClient & {
  /** Test-only: drive a registered `ws.on(type, ...)` listener directly. */
  emit: (type: ServerMessage["type"], payload: unknown, id?: string) => void;
};

/** The caller's voice join succeeding: startCall rings only after that. */
export function finishCallJoin(): void {
  voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
  voiceStore.flush();
}

export function fakeWs(): FakeWsClient {
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
    getState: vi.fn((): ConnectionState => "connected"),
    _getWs: vi.fn(() => null),
  };
}

export function fakeApi(host = ""): ApiClient {
  return {
    getConfig: () => ({ host }),
    getSession: () => ({ signal: new AbortController().signal }),
    getReactionUsers: vi.fn(async () => ({ users: [] })),
    getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
    getSessions: vi.fn(async () => []),
  } as unknown as ApiClient;
}

export function textChannel(id: number, name: string, position = 0) {
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

export function dmChannel(id: number, name: string, position = 0) {
  return { ...textChannel(id, name, position), type: "dm" as const };
}

export type MainPageBinding = {
  wired(container: HTMLDivElement): void;
  currentPage(): { destroy?: () => void } | undefined;
};

const DM_PROFILE_OPEN_KEY = "owncord:settings:dmProfileOpen";

/** Registers the shared beforeEach/afterEach for the MainPage suites. */
export function useMainPageHarness(binding: MainPageBinding): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    mockMountChannel.mockClear();
    mockDestroyChannel.mockClear();
    mockCreateChatArea.mockClear();
    capturedChatAreaRef.current = null;
    // The panel opens with a 1:1 DM by default; the toggle tests start from
    // "remembered closed" and the auto-open tests set it back.
    savePref("dmProfileOpen", false);
    container = document.createElement("div");
    document.body.appendChild(container);
    binding.wired(container);
  });

  afterEach(() => {
    binding.currentPage()?.destroy?.();
    container.remove();
    localStorage.removeItem(DM_PROFILE_OPEN_KEY);
  });
}

export type MainPageScope = {
  wired(container: HTMLDivElement): void;
  currentPage(): { destroy?: () => void } | undefined;
  arrange?(): void;
  mount?(
    container: HTMLDivElement,
  ): ReturnType<typeof createMainPage> | Promise<ReturnType<typeof createMainPage>>;
  mounted?(page: ReturnType<typeof createMainPage>): void;
  fakeTimers?: boolean;
  teardown?(): void;
};

/**
 * Registers a per-suite beforeEach/afterEach that resets the stores, runs
 * `arrange`, attaches a fresh container, optionally installs fake timers and
 * mounts the page. Teardown destroys the page and removes the container.
 */
export function useMainPageScope(scope: MainPageScope): void {
  let container: HTMLDivElement;

  beforeEach(async () => {
    resetStores();
    scope.arrange?.();
    container = document.createElement("div");
    document.body.appendChild(container);
    scope.wired(container);
    if (scope.fakeTimers) vi.useFakeTimers();
    if (scope.mount) scope.mounted?.(await scope.mount(container));
  });

  afterEach(() => {
    scope.currentPage()?.destroy?.();
    container.remove();
    if (scope.fakeTimers) vi.useRealTimers();
    scope.teardown?.();
  });
}

/** Builds a MainPage over `ws` and `api` and mounts it into `container`. */
export function mountPage(
  container: HTMLDivElement,
  ws: FakeWsClient = fakeWs(),
  api: ApiClient = fakeApi(),
): ReturnType<typeof createMainPage> {
  const page = createMainPage({ ws, api });
  page.mount(container);
  return page;
}

/** Adds `channels` to channelsStore and makes `activeChannelId` the active one. */
export function seedChannels(channels: readonly Channel[], activeChannelId: number | null): void {
  channelsStore.setState((prev) => {
    const ch = new Map(prev.channels);
    for (const c of channels) ch.set(c.id, c);
    return { ...prev, channels: ch, activeChannelId };
  });
}

export function voiceChannel(id: number, name: string, position = 0): Channel {
  return { ...textChannel(id, name, position), type: "voice" as const };
}

/** A 1:1 DM record with `username` (user `userId`) as the other side. */
export function oneToOneDm(channelId: number, userId = 10, username = "bob"): DmChannel {
  const other = { id: userId, username, avatar: "", status: "online" as const };
  return {
    channelId,
    recipient: other,
    participants: [other],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

/** Makes channel `id` the active 1:1 DM with bob. */
export function openOneToOneDm(id: number): void {
  seedChannels([dmChannel(id, "dm-bob")], id);
  dmStore.setState(() => ({ channels: [oneToOneDm(id)] }));
}

export function voiceUser(userId: number, over: Partial<VoiceUser> = {}): VoiceUser {
  return {
    userId,
    username: `u${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    ...over,
  };
}

/** The props the page handed its most recently built sidebar area. */
export function sidebarProps<T>(): T {
  return mockCreateSidebarArea.mock.calls.at(-1)![0] as T;
}

/** Connected socket with channel `id` open as a 1:1 DM with bob. */
export function connectedDm(id: number): void {
  uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
  openOneToOneDm(id);
}

/** Mounts the page and lets the lazily loaded call panel chunk land. */
export async function mountSettled(
  container: HTMLDivElement,
  ws?: FakeWsClient,
  api?: ApiClient,
): Promise<ReturnType<typeof createMainPage>> {
  const page = mountPage(container, ws, api);
  await vi.dynamicImportSettled();
  return page;
}

type ChatAreaProps = {
  onStartCall: () => void;
  onStartVideoCall: () => void;
  onRenameGroup: () => void;
};

/** The props the page handed the first chat area it built. */
export function chatAreaProps(): ChatAreaProps {
  return mockCreateChatArea.mock.calls[0]![0] as ChatAreaProps;
}

export function startCall(): void {
  chatAreaProps().onStartCall();
}

export function callPanelEl(): HTMLElement {
  return document.querySelector('[data-testid="dm-call-panel"]') as HTMLElement;
}

export function incomingCall(ws: FakeWsClient): void {
  ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
}

export function callDeclined(ws: FakeWsClient): void {
  ws.emit("call_declined", { channel_id: 50, from_user: 10, username: "bob" });
}

/** voiceUsers state holding `users` in channel `channelId`. */
export function roster(
  channelId: number,
  users: readonly VoiceUser[],
): Map<number, Map<number, VoiceUser>> {
  return new Map([[channelId, new Map(users.map((u) => [u.userId, u]))]]);
}

/** Leaves the voice channel the way the dispatcher's join rollback does. */
export function leaveVoice(): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: null,
    voiceStatus: "idle" as const,
  }));
  voiceStore.flush();
}

export function incomingBannerEl(): HTMLElement {
  return document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
}
