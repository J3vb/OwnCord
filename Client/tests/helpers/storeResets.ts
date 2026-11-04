import { messagesStore, type MessagesState } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";

/** Empty every message, pending send and history flag, as a fresh session starts. */
export function resetMessagesState(overrides: Partial<MessagesState> = {}): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
    ...overrides,
  }));
}

/** Empty the roster and the typing indicators. */
export function resetMembersState(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}
