// A DM preview that showed a deleted message: blank it, then take the server's last message.
import { dmStore, reviseDmLastMessage } from "../../stores/dm.store";
import type { DispatchApi } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";

/** The in-flight GET /dms refetch per DM channel: the preview id it was
 *  issued for, and the token of the only answer that may be applied. */
const dmPreviewRefetches = new Map<number, { shown: number; token: number }>();
let dmPreviewRefetchToken = 0;

/** A DM whose preview showed a now-deleted message is blanked at once, then
 *  takes the server's last message from GET /dms. A delete in the channel
 *  while that is in flight reissues it; an answer newer than the preview is
 *  dropped, since its chat_message frame owns it. */
export function reviseDmPreviewAfterDelete(
  api: DispatchApi | undefined,
  channelId: number,
  ids: readonly number[],
): void {
  const shown = dmStore.getState().channels.find((c) => c.channelId === channelId)?.lastMessageId;
  if (shown === undefined || shown === null) return;
  if (!ids.includes(shown) && dmPreviewRefetches.get(channelId)?.shown !== shown) return;
  reviseDmLastMessage(channelId, shown, { lastMessage: "" });
  const getDmChannels = api?.getDmChannels;
  if (getDmChannels === undefined) return;
  const token = ++dmPreviewRefetchToken;
  dmPreviewRefetches.set(channelId, { shown, token });
  const settle = (): boolean => {
    if (dmPreviewRefetches.get(channelId)?.token !== token) return false;
    dmPreviewRefetches.delete(channelId);
    return true;
  };
  getDmChannels().then(
    (r) => {
      if (!settle()) return;
      const p = r.dm_channels.find((d) => d.channel_id === channelId);
      if (p === undefined || (p.last_message_id !== null && p.last_message_id > shown)) return;
      reviseDmLastMessage(channelId, shown, {
        lastMessageId: p.last_message_id,
        lastMessage: p.last_message,
        lastMessageAt: p.last_message_at,
      });
    },
    (err: unknown) => {
      if (settle()) {
        log.warn("Failed to refetch a DM preview after a delete", { error: String(err) });
      }
    },
  );
}

/** Whether a DM preview refetch is in flight for this channel. */
export function hasDmPreviewRefetch(channelId: number): boolean {
  return dmPreviewRefetches.has(channelId);
}
