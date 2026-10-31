import { vi } from "vitest";
import { channelsStore } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore, updateVoiceState } from "../../src/stores/voice.store";
import type { PeerVerification } from "../../src/stores/voice.store";
import { type ReadyChannel } from "../../src/lib/types";
import { resetMembersState } from "./storeResets";

export function resetStores(): void {
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
  resetMembersState();
}

/** Add a connected voice user to a channel (via the same store path the WS uses). */
export function addVoiceUser(channelId: number, userId: number, username: string): void {
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
export function setPeerVerif(
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

export const testChannels: ReadyChannel[] = [
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
export function voiceModCallbacks() {
  return {
    onServerMute: vi.fn(),
    onServerDeafen: vi.fn(),
    onMove: vi.fn(),
    onDisconnect: vi.fn(),
  };
}

/** Set auth user so admin-gated features (context menus, drag, create channel) activate. */
export function setAdminUser(): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id: 1, username: "Admin", avatar: null, role: "admin" },
    serverName: "Test Server",
    motd: null,
    isAuthenticated: true,
  }));
}
