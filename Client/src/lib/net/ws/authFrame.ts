// What the client puts in its `auth` frame, and the providers that fill it.

import { isAndroidHost } from "../../hostPlatform";
import { PROTOCOL_EPOCH } from "../../protocolTypes";
import { IDENTITY_KEY_WAIT_MS } from "../../wsConfig";
import type { WsState } from "./wsState";

/**
 * What this client can render, declared in every `auth` frame. The
 * server withholds the matching channels and frames from a socket that does not
 * declare them, so an older client never shows a broken forum. `call_sync`:
 * this client ends a ring when its own account declines on another device.
 */
const CLIENT_FEATURES: readonly string[] = ["forums", "call_sync"];

/** CLIENT_FEATURES plus `mobile` in the Android app (and only there: a phone's
 *  browser is a web client and counts as a desktop). It tells the server to show
 *  other members the phone shape on this account's status. Read per auth frame,
 *  since the host does not change but tests stub it. */
function clientFeatures(): readonly string[] {
  return isAndroidHost() ? [...CLIENT_FEATURES, "mobile"] : CLIENT_FEATURES;
}

/** The server's host name for the event log: no port, and nothing for an IP address. */
export function eventHost(host: string): string | null {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return /^[\d.]+$/.test(name) || name.includes(":") ? null : name;
}

/**
 * Supplies the channel the user currently has open, so the auth frame can
 * declare it on a resume.
 *
 * Registered rather than imported: the transport is deliberately
 * dependent on nothing but types and the logger, which is what lets the tests
 * drive it with minimal mocks.
 *
 * Without this the resumed connection holds no ChannelTopic subscription until
 * the post-auth_ok `channel_focus` round trip completes, and every message
 * broadcast to that channel in the meantime is lost with no way to ask for it
 * back (the client only reports max(seq)). The server still READ-gates the id
 * before honouring it, and `channel_focus` is still sent on auth_ok — this
 * only shrinks the window to zero.
 */
let activeChannelProvider: (() => number | null) | null = null;

export function setActiveChannelProvider(fn: (() => number | null) | null): void {
  activeChannelProvider = fn;
}

/**
 * Supplies this device's identity public key (base64) for the host being
 * dialled, so the auth frame can tell the server which key this connection
 * signs its voice announces with (encryption key per device). Resolves null
 * when the key is unavailable (keyring failure, no signed-in user yet): the
 * frame then goes out without it. Registered rather than imported, like
 * `setActiveChannelProvider`, to keep this module free of store and keyring
 * imports.
 */
let identityKeyProvider: ((host: string) => Promise<string | null>) | null = null;

export function setIdentityKeyProvider(
  fn: ((host: string) => Promise<string | null>) | null,
): void {
  identityKeyProvider = fn;
}

export function hasIdentityKeyProvider(): boolean {
  return identityKeyProvider !== null;
}

/** The auth payload, minus the identity key, for the open socket. */
export function buildAuthFrame(
  s: WsState,
  token: string,
): {
  token: string;
  last_seq: number;
  epoch: typeof PROTOCOL_EPOCH;
  active_channel_id?: number;
  wake?: true;
  full_state?: true;
  features: readonly string[];
} {
  // active_channel_id only matters on a resume (last_seq > 0); on a
  // fresh connect the ready payload re-establishes everything anyway.
  // Omitted when unknown so the frame stays byte-identical to before
  // for callers that never register a provider.
  const lastSeq = s.lastSeq;
  const activeChannelId = lastSeq > 0 ? (activeChannelProvider?.() ?? null) : null;
  // After an unreadable frame the dial asks for the full state with
  // `full_state` and keeps its real last_seq: last_seq 0 would read as a
  // reload, and the server ends a reloaded session's voice call. A server
  // that predates the flag ignores it and replays, which skips only the
  // frame this client could not read anyway.
  // A wake dial carries `wake: true`. The server refuses it
  // (ANOTHER_DEVICE_ACTIVE) when another device holds the session, and
  // accepts it otherwise — so a lone device wakes silently while a woken
  // laptop cannot displace the desktop's call. Omitted unless set, so an
  // ordinary auth frame is byte-identical to before.
  return {
    token,
    last_seq: lastSeq,
    epoch: PROTOCOL_EPOCH,
    ...(activeChannelId !== null ? { active_channel_id: activeChannelId } : {}),
    ...(s.pendingWake ? { wake: true as const } : {}),
    ...(s.fullStateOwed ? { full_state: true as const } : {}),
    features: clientFeatures(),
  };
}

// This device's identity public key for the auth frame, or null. Never
// rejects and never waits longer than IDENTITY_KEY_WAIT_MS.
export async function resolveIdentityKey(s: WsState, host: string): Promise<string | null> {
  const provider = identityKeyProvider;
  if (provider === null) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = s.clock.setTimeout(() => resolve(null), IDENTITY_KEY_WAIT_MS);
  });
  try {
    return await Promise.race([provider(host).catch(() => null), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== null) s.clock.clearTimeout(timer);
  }
}
