import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";

/** Empty every message, pending send and history flag, as a fresh session starts. */
export function resetMessagesState(): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map(),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
}

/** Empty the roster and the typing indicators. */
export function resetMembersState(): void {
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}
