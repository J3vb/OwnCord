/**
 * Read-only selectors over the messages store. messages.store.ts builds them
 * from its store instance and re-exports them, so this file never imports the
 * facade back.
 */
import type { Store } from "@lib/store";
import type { Message, MessagesState } from "../features/messaging/messageModel";

export function createMessagesSelectors(store: Pick<Store<MessagesState>, "select">) {
  /** Get messages for a channel, or empty array if none loaded. */
  function getChannelMessages(channelId: number): readonly Message[] {
    return store.select((s) => s.messagesByChannel.get(channelId) ?? []);
  }

  /** Check whether initial messages have been loaded for a channel. */
  function isChannelLoaded(channelId: number): boolean {
    return store.select((s) => s.loadedChannels.has(channelId));
  }

  /** Check whether a channel has more older messages to fetch. */
  function hasMoreMessages(channelId: number): boolean {
    return store.select((s) => s.hasMore.get(channelId) ?? false);
  }

  /** First-page history fetch state for a channel; null when idle/loaded. */
  function getHistoryLoadState(channelId: number): "loading" | "error" | null {
    return store.select((s) => s.historyLoadState.get(channelId) ?? null);
  }

  /**
   * Whether the channel's loaded window is an around-window detached from the
   * live tail — newer messages exist below what is rendered.
   */
  function isWindowDetached(channelId: number): boolean {
    return store.select((s) => s.detachedChannels.has(channelId));
  }

  /** Whether a message id is present in a channel's loaded window. */
  function hasMessageLoaded(channelId: number, messageId: number): boolean {
    return store.select(
      (s) => s.messagesByChannel.get(channelId)?.some((m) => m.id === messageId) ?? false,
    );
  }

  return {
    getChannelMessages,
    isChannelLoaded,
    hasMoreMessages,
    getHistoryLoadState,
    isWindowDetached,
    hasMessageLoaded,
  };
}
