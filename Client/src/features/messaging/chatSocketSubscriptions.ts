/** Socket events the chat area's panels follow, narrowed to what they read. */

import type { WsClient } from "@lib/ws";

/** Deleted messages: one id, or a purge's ids. */
export function subscribeDeletedMessages(
  ws: WsClient,
  listener: (channelId: number, messageIds: readonly number[]) => void,
): () => void {
  const offOne = ws.on("chat_deleted", (p) => listener(p.channel_id, [p.message_id]));
  const offMany = ws.on("chat_bulk_deleted", (p) => listener(p.channel_id, p.ids));
  return () => {
    offOne();
    offMany();
  };
}

/** A message's remaining attachment ids after an edit. */
export function subscribeEditedAttachments(
  ws: WsClient,
  listener: (channelId: number, messageId: number, remainingIds: readonly string[]) => void,
): () => void {
  return ws.on("chat_edited", (p) => {
    if (p.attachments !== undefined) {
      listener(
        p.channel_id,
        p.message_id,
        p.attachments.map((a) => a.id),
      );
    }
  });
}
