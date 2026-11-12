import { messagesStore, type MessagesState } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { clearReadingPositions } from "../../src/features/messaging/message-list/readingPositions";

/** Empty every message, pending send and history flag, and the reading
 *  positions kept for them, as a fresh session starts. */
export function resetMessagesState(overrides: Partial<MessagesState> = {}): void {
  clearReadingPositions();
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
