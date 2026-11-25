// The DM list's preview text for a last message, with a blocked author's text
// replaced by the blocked-message label. The DM store keeps the text as the
// server sent it; the rows apply this check when they draw, so a row follows
// the block list both ways (a block hides it, an unblock brings it back).
import { blocksStore } from "../../stores/blocks.store";
import { messagesStore } from "../../stores/messages.store";
import { dmStore } from "../../stores/dm.store";
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

/** The DMs whose last message the list shows as the blocked-message label. */
function hiddenPreviews(): string {
  if (blocksStore.getState().blockedByMe.size === 0) return "";
  return dmStore
    .getState()
    .channels.filter(
      (dm) =>
        blockedPreviewText(dm.channelId, dm.lastMessageId, dm.lastMessage, dm.participants) !==
        dm.lastMessage,
    )
    .map((dm) => dm.channelId)
    .join(",");
}

/**
 * Call `redraw` when a DM row's preview flips between its text and the label:
 * the user blocks or unblocks someone, the block list arrives, or a loaded
 * message names the last message's author. A DM list change is the list's own
 * subscription. Returns the unsubscribe.
 */
export function watchBlockedPreviews(redraw: () => void): () => void {
  let shown = hiddenPreviews();
  const check = (): void => {
    const next = hiddenPreviews();
    if (next === shown) return;
    shown = next;
    redraw();
  };
  const unsubs = [blocksStore.subscribe(check), messagesStore.subscribe(check)];
  return () => {
    for (const unsub of unsubs) unsub();
  };
}
