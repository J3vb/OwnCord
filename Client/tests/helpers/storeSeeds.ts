import { authStore, type AuthState } from "@stores/auth.store";
import { channelsStore, type Channel } from "@stores/channels.store";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import { membersStore } from "@stores/members.store";
import { makeChannel } from "./channelFactory";

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

/** Sign in the admin with id 1, named `username`. */
export function signInAsAdmin(username = "testuser", options: SignInOptions = {}): void {
  signInAs({ id: 1, username, role: "admin", avatar: null, totp_enabled: false }, options);
}

/** Make `id`/`username` the only member, online, and flush the members store. */
export function seedOnlineMember(id: number, username: string): void {
  membersStore.setState((p) => ({
    ...p,
    members: new Map([[id, { id, username, status: "online" } as never]]),
  }));
  membersStore.flush();
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

/** Put voiceStore back to idle: no channel joined, nothing muted or shared; `overrides` win. */
export function resetVoiceState(overrides: Partial<VoiceState> = {}): void {
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
    ...overrides,
  }));
}

/** A complete Channel with quiet defaults; override only what the test cares about. */
export function makeChannelRow(
  overrides: Pick<Channel, "id" | "name"> & Partial<Channel>,
): Channel {
  return makeChannel(overrides);
}
