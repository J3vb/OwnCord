/**
 * The channel the user last had open, per server (UX-8).
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

/**
 * Quiet window for `channel_focus`. The server meters focus at 5/s, so a
 * channel step per keydown (held Alt+Down) must not become a frame per step.
 */
const FOCUS_QUIET_MS = 150;

interface PendingFocus {
  readonly channelId: number;
  readonly ws: WsClient;
}

let lastFocusSentAt = Number.NEGATIVE_INFINITY;
let lastFocusSentChannel: number | null = null;
let pendingFocus: PendingFocus | null = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;

function sendFocus(channelId: number, ws: WsClient): void {
  lastFocusSentAt = Date.now();
  lastFocusSentChannel = channelId;
  ws.send({ type: "channel_focus", payload: { channel_id: channelId } });
}

function flushTrailingFocus(): void {
  focusTimer = null;
  const pending = pendingFocus;
  pendingFocus = null;
  if (pending === null || pending.channelId === lastFocusSentChannel) return;
  sendFocus(pending.channelId, pending.ws);
}

/**
 * Leading+trailing throttle: a lone switch is sent at once (a pure trailing
 * debounce would delay every switch and widen the gap between the REST history
 * snapshot and the live subscription); a burst sends its first channel at once
 * and its latest channel after `FOCUS_QUIET_MS` without further switches.
 */
function requestFocus(channelId: number, ws: WsClient): void {
  if (pendingFocus === null && Date.now() - lastFocusSentAt >= FOCUS_QUIET_MS) {
    sendFocus(channelId, ws);
    return;
  }
  pendingFocus = { channelId, ws };
  if (focusTimer !== null) clearTimeout(focusTimer);
  focusTimer = setTimeout(flushTrailingFocus, FOCUS_QUIET_MS);
}

/**
 * Drop throttle state. Called on every new connection (`auth_ok`), which
 * re-asserts focus itself: a channel id sent on the previous server or socket
 * must not suppress the same id on the new one.
 */
export function resetChannelFocus(): void {
  if (focusTimer !== null) clearTimeout(focusTimer);
  focusTimer = null;
  pendingFocus = null;
  lastFocusSentAt = Number.NEGATIVE_INFINITY;
  lastFocusSentChannel = null;
}

/**
 * The channel is on screen now (mounted, not merely selected): focus it on the
 * server (throttled, see `requestFocus`), which advances its read state, clear
 * its local badge, and record it as the last channel. A DM is not recorded:
 * `ready` restores only from its server channel list, and DMs arrive
 * separately in `dm_channels`. An undefined type is a server channel.
 */
export function viewChannel(
  channelId: number,
  channelType: ChannelType | undefined,
  ws: WsClient,
): void {
  clearUnread(channelId);
  if (channelType !== "dm") rememberLastChannel(channelId);
  requestFocus(channelId, ws);
}

/** The stored last channel for the current server, or null when none/unset.
 *  `loadPref`'s typeof guard needs a numeric fallback (a `null` fallback makes
 *  it reject every stored number), so 0 stands in for "nothing stored". */
export function loadLastChannel(): number | null {
  const value = loadPref(keyFor(currentHost), 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
