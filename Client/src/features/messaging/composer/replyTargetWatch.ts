/** Clear the composer's reply bar when the message it replies to is deleted. */

import { getChannelMessages, messagesStore } from "@stores/messages.store";
import type { MessageInputComponent } from "../MessageInput";

type ReplyBar = Pick<MessageInputComponent, "peekDraft" | "clearReply">;

/** Returns the unsubscribe. A bar with no reply costs one property read per store update. */
export function watchReplyTarget(input: ReplyBar, channelId: number): () => void {
  const targetGone = (): boolean => {
    const id = input.peekDraft().replyTo?.messageId;
    if (id === undefined) return false;
    return getChannelMessages(channelId).some((m) => m.id === id && m.deleted === true);
  };
  return messagesStore.subscribeSelector(targetGone, (gone) => {
    if (gone) input.clearReply();
  });
}
