import { clearUnread } from "@stores/channels.store";
import { focusPayload, rememberLastChannel } from "@lib/prefs/lastChannel";
import type { ChannelType } from "@lib/types";
import type { WsClient } from "@lib/ws";

/**
 * The channel is on screen now (mounted, not merely selected): focus it on the
 * server, which advances its read state (unless the server keeps a read pointer:
 * `read: false` then focuses without marking, and only what is seen is marked
 * read), clear its local badge, and record it
 * as the last channel. A DM is not recorded: `ready` restores only from its
 * server channel list, and DMs arrive separately in `dm_channels`. Neither is
 * a voice channel (its chat is reached from a call; a restart must not land on
 * an unjoined call chat). An
 * undefined type is a server channel.
 */
export function viewChannel(
  channelId: number,
  channelType: ChannelType | undefined,
  ws: WsClient,
): void {
  ws.send({ type: "channel_focus", payload: focusPayload(channelId) });
  clearUnread(channelId);
  if (channelType !== "dm" && channelType !== "voice") rememberLastChannel(channelId);
}
