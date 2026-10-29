/**
 * The channel the user last had open, per server.
 *
 * Every launch or server switch used to re-select the first text channel,
 * silently moving the reader off where they were. Channel ids are per-server
 * SQLite autoincrement integers, and the multi-server client shares one
 * localStorage, so the key is scoped by host — mirroring `channel-mutes.ts`.
 *
 * A stored id is only a hint: it is advisory on restore, and a stale id (the
 * channel was deleted, or is no longer visible) is ignored rather than
 * guessed at.
 */

import { clearUnread } from "@stores/channels.store";
import { loadPref, savePref } from "./preferences";
import { readPointerEnabled } from "./serverCapabilities";
import type { ChannelType } from "./types";
import type { WsClient } from "./ws";

/** localStorage key (under the shared settings prefix). */
const LAST_CHANNEL_KEY = "lastChannel";

/** Server host the stored id belongs to. Set on connect and server switch. */
let currentHost: string | null = null;

function keyFor(host: string | null): string {
  return host === null ? LAST_CHANNEL_KEY : `${LAST_CHANNEL_KEY}:${host}`;
}

/** Point reads/writes at a specific server's key. Call on connect and switch. */
export function setLastChannelHost(host: string | null): void {
  currentHost = host;
}

/** Record the channel the user has open for the current server. */
export function rememberLastChannel(channelId: number): void {
  savePref(keyFor(currentHost), channelId);
}

/** The `channel_focus` payload: with a read pointer, focus without marking read. */
export function focusPayload(channelId: number): { channel_id: number; read?: false } {
  return readPointerEnabled() ? { channel_id: channelId, read: false } : { channel_id: channelId };
}

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

/** The stored last channel for the current server, or null when none/unset.
 *  `loadPref`'s typeof guard needs a numeric fallback (a `null` fallback makes
 *  it reject every stored number), so 0 stands in for "nothing stored". */
export function loadLastChannel(): number | null {
  const value = loadPref(keyFor(currentHost), 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
