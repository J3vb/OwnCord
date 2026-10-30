// The browser platform's pending-message store: kept in the page's
// memory only, never in Web Storage. Drafts survive a reconnect or a re-login
// in the same tab, and go with the tab.
import type { PendingMessageOwner, PendingMessageStore } from "../contracts/pendingMessages";

function ownerKey(owner: PendingMessageOwner): string {
  return JSON.stringify([owner.host, owner.userId]);
}

/** A store with its own memory. */
export function createMemoryPendingMessages(): PendingMessageStore {
  const drafts = new Map<string, string>();
  return {
    load: async (owner) => drafts.get(ownerKey(owner)) ?? null,
    save: async (owner, value) => {
      drafts.set(ownerKey(owner), value);
    },
    delete: async (owner) => {
      drafts.delete(ownerKey(owner));
    },
  };
}

export const pendingMessages: PendingMessageStore = createMemoryPendingMessages();
