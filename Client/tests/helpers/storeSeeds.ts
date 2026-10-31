import { authStore, type AuthState } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";

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
