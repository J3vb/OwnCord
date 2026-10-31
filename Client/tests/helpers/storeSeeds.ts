import { authStore, type AuthState } from "@stores/auth.store";
import { channelsStore, type Channel } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";

/** Put authStore in its signed-out state. */
export function resetAuthState(): void {
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
}

export interface SignInOptions {
  readonly token?: string | null;
  readonly serverName?: string | null;
  readonly motd?: string | null;
}

/** Sign `user` in to authStore, as auth_ok leaves it. */
export function signInAs(
  user: NonNullable<AuthState["user"]>,
  { token = "tok", serverName = "Test Server", motd = null }: SignInOptions = {},
): void {
  authStore.setState(() => ({ token, user, serverName, motd, isAuthenticated: true }));
}

/** Empty channelsStore: no channels, no active channel, no roles or categories. */
export function resetChannelsState(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
}

/** Put voiceStore back to idle: no channel joined, nothing muted or shared. */
export function resetVoiceState(): void {
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
}

/** A complete Channel with quiet defaults; override only what the test cares about. */
export function makeChannelRow(
  overrides: Pick<Channel, "id" | "name"> & Partial<Channel>,
): Channel {
  return {
    type: "text",
    category: null,
    position: 0,
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
    ...overrides,
  };
}
