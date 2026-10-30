import { vi } from "vitest";
import { channelsStore } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { dmStore } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import type { WsClient, WsListener, ConnectionState } from "../../src/lib/ws";
import type { ApiClient } from "../../src/lib/api";
import type { ServerMessage } from "../../src/lib/types";

export function resetStores(): void {
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
