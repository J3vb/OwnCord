/**
 * Common test utilities for OwnCord Tauri client tests.
 * Provides store reset and async store waiting helpers.
 */

import type { Store } from "@lib/store";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { messagesStore } from "@stores/messages.store";
import { voiceStore } from "@stores/voice.store";
import { uiStore } from "@stores/ui.store";

import type { AuthState } from "@stores/auth.store";
import type { ChannelsState } from "@stores/channels.store";
import type { MembersState } from "@stores/members.store";
import type { MessagesState } from "@stores/messages.store";
import type { VoiceState } from "@stores/voice.store";
import type { UiState } from "@stores/ui.store";

// ---------------------------------------------------------------------------
// Initial states (must match those in each store module)
// ---------------------------------------------------------------------------

const AUTH_INITIAL: AuthState = {
  token: null,
  user: null,
  serverName: null,
  motd: null,
  isAuthenticated: false,
};

const CHANNELS_INITIAL: ChannelsState = {
  channels: new Map(),
  activeChannelId: null,
};

const MEMBERS_INITIAL: MembersState = {
  members: new Map(),
  typingUsers: new Map(),
};

const MESSAGES_INITIAL: MessagesState = {
  messagesByChannel: new Map(),
  pendingSends: new Map(),
  loadedChannels: new Set(),
  hasMore: new Map(),
};

const VOICE_INITIAL: VoiceState = {
  currentChannelId: null,
  voiceUsers: new Map(),
  voiceConfigs: new Map(),
  localMuted: false,
  localDeafened: false,
};

const UI_INITIAL: UiState = {
  sidebarCollapsed: false,
  memberListVisible: true,
  settingsOpen: false,
  activeModal: null,
  theme: "dark",
  connectionStatus: "disconnected",
  transientError: null,
  persistentError: null,
  collapsedCategories: new Set(),
};

// ---------------------------------------------------------------------------
// resetAllStores
// ---------------------------------------------------------------------------

/**
 * Reset every store to its initial state. Call this in `beforeEach` to
 * ensure test isolation.
 */
export function resetAllStores(): void {
  authStore.setState(() => ({ ...AUTH_INITIAL }));
  channelsStore.setState(() => ({ ...CHANNELS_INITIAL, channels: new Map() }));
  membersStore.setState(() => ({
    ...MEMBERS_INITIAL,
    members: new Map(),
    typingUsers: new Map(),
  }));
  messagesStore.setState(() => ({
    ...MESSAGES_INITIAL,
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
  }));
  voiceStore.setState(() => ({
    ...VOICE_INITIAL,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
  }));
  uiStore.setState(() => ({
    ...UI_INITIAL,
    collapsedCategories: new Set(),
  }));
}

// ---------------------------------------------------------------------------
// waitForStoreUpdate
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves when the store's state matches the given
 * predicate. Useful for waiting on asynchronous store updates (e.g. after
 * dispatching a WS message that triggers a store change).
 *
 * Times out after `timeoutMs` (default 2000ms) to prevent hanging tests.
 *
 * @example
 * ```ts
 * await waitForStoreUpdate(authStore, (s) => s.isAuthenticated);
 * ```
 */
export function waitForStoreUpdate<T>(
  store: Store<T>,
  predicate: (state: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Check immediately — predicate may already be true
    const current = store.getState();
    if (predicate(current)) {
      resolve(current);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = store.subscribe((state) => {
      if (predicate(state)) {
        if (timer !== null) {
          clearTimeout(timer);
        }
        unsub();
        resolve(state);
      }
    });

    timer = setTimeout(() => {
      unsub();
      reject(
        new Error(
          `waitForStoreUpdate timed out after ${timeoutMs}ms. ` +
            `Last state: ${JSON.stringify(store.getState())}`,
        ),
      );
    }, timeoutMs);
  });
}
