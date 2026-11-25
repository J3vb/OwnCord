// The DM list's preview text for a last message, with a blocked author's text
// replaced by the blocked-message label. The DM ws handlers register it as the
// DM store's preview filter, so every preview the store takes passes it while
// the store itself stays out of the messages and blocks stores.
import { blocksStore } from "../../stores/blocks.store";
import { messagesStore } from "../../stores/messages.store";
import { messagingText } from "../../i18n/messaging";
import type { DmUser } from "../../stores/dm.store";

/** The author of a message this client holds, or undefined when it is not loaded. */
function loadedAuthorOf(channelId: number, messageId: number): number | undefined {
  return messagesStore
    .getState()
    .messagesByChannel.get(channelId)
    ?.find((m) => m.id === messageId)?.user.id;
}

/**
 * The text the DM list shows for a DM's last message: the blocked-message
 * label when its author is someone the user blocked, the same check the
 * message list makes. A DM summary and an edit name no author, so when the
 * loaded messages do not either, the label shows only when every listed
 * participant is blocked (a 1:1 DM with a blocked person, or a group where
 * everybody else is): the author is then either blocked or the user. A group
 * with some blocked members shows the text.
 */
export function blockedPreviewText(
  channelId: number,
  messageId: number | null,
  text: string,
  participants: readonly DmUser[],
): string {
  const blocked = blocksStore.getState().blockedByMe;
  if (text === "" || blocked.size === 0) return text;
  const author = messageId === null ? undefined : loadedAuthorOf(channelId, messageId);
  const hidden =
    author !== undefined
      ? blocked.has(author)
      : participants.length > 0 && participants.every((u) => blocked.has(u.id));
  return hidden ? messagingText("blocked.message") : text;
}
