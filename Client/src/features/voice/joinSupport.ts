// Synchronous checkpoint and queue helpers of the voice join orchestration,
// split from joinOrchestration.ts. Every helper is a whole synchronous step
// that reads the session only through JoinHost; the awaits and the ownership
// checks that guard them stay in JoinOrchestration.
import { createLogger } from "../../lib/logger";
import type { PendingVoiceJoin, SessionState } from "./sessionState";
import { detachRoom, releaseRoom } from "./releaseRoom";
import type { JoinHost } from "./joinHost";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

// Same logger tag as before the extraction, so the join log lines are unchanged.
const log = createLogger("livekitSession");

/** The join a connect attempt carries. */
export interface JoinRequest {
  token: string;
  url: string;
  channelId: number;
  directUrl?: string;
}

/** Helper to check state is "connected" for this exact room and channel, reading
 *  through a method call so TS control-flow narrowing cannot cache the result.
 *  Used in connectAndSetup() checkpoints after setState() transitions. */
export function isStateConnected(host: JoinHost, channelId: number, room: VoiceRoom): boolean {
  const s: SessionState = host.getState();
  return s.type === "connected" && s.channelId === channelId && s.room === room;
}

export function ownsConnectAttempt(host: JoinHost, generation: number): boolean {
  const s = host.getState();
  return s.type === "connecting" && s.joinGeneration === generation;
}

/** A join is queued on the attempt connecting now. */
export function hasQueuedJoin(host: JoinHost): boolean {
  const s = host.getState();
  return s.type === "connecting" && s.pendingJoin !== null;
}

export function currentGeneration(host: JoinHost): number | "n/a" {
  const s = host.getState();
  return s.type === "connecting" ? s.joinGeneration : "n/a";
}

/** Checkpoint cleanup for a superseded connectAndSetup attempt, used at
 *  every "return \"superseded\"" site in that function. By the time one of
 *  these fires, a NEWER attempt may have already claimed `_state` (and torn
 *  down THIS attempt's room via its own entry-point leaveVoice(false)) — so
 *  this must disconnect only the passed-in localRoom and must never call
 *  the global leaveVoice()/touch `_state`, or it tears down whichever
 *  session currently occupies `_state`, which now belongs to the newer
 *  attempt.
 *
 *  Also re-syncs the extracted modules (DeviceManager/AudioPipeline
 *  /AudioElements) when nobody newer owns `_state`. Earlier checkpoints
 *  (1/2, the key-exchange failure, and the retry-backoff check) fire before
 *  this attempt ever reaches "connected" — if the supersession was a plain
 *  leaveVoice() (state now "idle") that landed while this attempt's own
 *  lines above had already wired the modules to `localRoom`, that leave's
 *  own syncModuleRooms() ran too early and got undone by the later wiring,
 *  leaving DeviceManager's devicechange listener armed on a Room that will
 *  never connect. The condition is required — an unconditional sync would
 *  null the modules out from under a newer attempt that already ran its own
 *  wiring but has not yet reached "connected" (it never re-wires after that
 *  point). */
export function disconnectSupersededLocalRoom(host: JoinHost, localRoom: VoiceRoom): void {
  releaseRoom(localRoom).catch((err) => log.debug("Failed to disconnect superseded room", err));
  if (host.getState().type === "idle") host.syncModuleRooms();
}

/** Drop the room of an attempt a checkpoint found superseded. */
export function dropSuperseded(host: JoinHost, localRoom: VoiceRoom): "superseded" {
  disconnectSupersededLocalRoom(host, localRoom);
  return "superseded";
}

/** Tear down what a new attempt must not inherit. Also tear down (and
 *  abort) an in-flight reconnect: `_room` reads null for the whole
 *  "reconnecting" state, so a join issued while the LiveKit auto-reconnect
 *  loop is running would otherwise skip leaveVoice(false) entirely —
 *  meaning _e2ee.clearState() never runs, and setupKeyExchange inherits
 *  the PREVIOUS channel's residual _isKeyHolder via its OR-with-server-value
 *  guard, joining the new channel as a phantom key holder the server never
 *  elected. */
export function clearForNewAttempt(host: JoinHost): void {
  if (host.getRoom() !== null || host.getState().type === "reconnecting") {
    host.leaveVoice(false, true);
  } else if (host.getState().type === "connecting") {
    // The pending-join drain loop (handleVoiceToken) re-enters
    // connectAndSetup while `_state` is still "connecting" — there is no
    // room to disconnect and no reconnect AC to abort, so the branch above
    // never fires, but a discarded prior attempt (e.g. the e2ee_timeout /
    // checkpoint-2 queued-join paths) can still leave residual E2EE
    // state (_isKeyHolder, keypair, peer keys) behind for THIS attempt to
    // inherit via setupKeyExchange's OR-with-server-value guard. Clear it
    // explicitly since leaveVoice() itself never runs on this path.
    host.getE2EE().clearState({ keepHeldAnnounces: true });
  }
}

/** Point the extracted modules at the room this attempt is building. */
export function wireModules(host: JoinHost, room: VoiceRoom): void {
  host.getAudioPipeline().setRoom(room);
  host.getAudioElements().setRoom(room);
  host.getDeviceManager().setRoom(room);
  host.getDeviceManager().setAudioPipeline(host.getAudioPipeline());
}

export function unwireModules(host: JoinHost): void {
  host.getAudioPipeline().setRoom(null);
  host.getAudioElements().setRoom(null);
  host.getDeviceManager().setRoom(null);
  host.getDeviceManager().setAudioPipeline(null);
}

/** A newer request queued while this attempt connected, and it differs
 *  from this one (an identical one is a duplicate frame). */
function queuedDifferentJoin(
  host: JoinHost,
  token: string,
  url: string,
  channelId: number,
  directUrl: string | undefined,
): PendingVoiceJoin | null {
  const s = host.getState();
  const queuedJoin = s.type === "connecting" ? s.pendingJoin : null;
  if (queuedJoin === null) return null;
  const same =
    queuedJoin.token === token &&
    queuedJoin.url === url &&
    queuedJoin.channelId === channelId &&
    queuedJoin.directUrl === directUrl;
  return same ? null : queuedJoin;
}

/** A different join queued while this attempt connected: drop this
 *  attempt's room and unwire the modules, so the drain runs the queued
 *  one. True when it did. */
export function discardForQueuedJoin(host: JoinHost, room: VoiceRoom, join: JoinRequest): boolean {
  const { token, url, channelId, directUrl } = join;
  const queuedJoin = queuedDifferentJoin(host, token, url, channelId, directUrl);
  if (queuedJoin === null) return false;
  log.info("Discarding stale voice join in favor of queued request", {
    channelId,
    queuedChannelId: queuedJoin.channelId,
  });
  detachRoom(room);
  room.disconnect().catch((err) => log.debug("Failed to disconnect room during cleanup", err));
  unwireModules(host);
  return true;
}

/** A token for the session already up (or reconnecting) on this channel.
 *  livekit-client's own internal reconnect (network blip on the SFU
 *  signal socket) moves Room.state through "signalReconnecting" /
 *  "reconnecting" without ever emitting RoomEvent.Disconnected — the only
 *  event this session listens for — so `_state` stays "connected" the
 *  whole time. A routine 4-minute refresh token landing in that window
 *  must still take the lightweight refresh path instead of falling
 *  through to a full teardown+rejoin of a session that is about to
 *  recover on its own; only a room the SDK has fully given up on
 *  ("disconnected") should be treated as needing a real reconnect here.
 *  P2-T5: the same for our own auto-reconnect — the token answers its
 *  voice_token_refresh, and the loop connects with it on its next attempt;
 *  a full join here would eject the user if the SFU is still down. */
export function isRefreshFor(host: JoinHost, channelId: number): boolean {
  const s = host.getState();
  return (
    (s.type === "connected" && s.channelId === channelId && s.room.state !== "disconnected") ||
    (s.type === "reconnecting" && s.channelId === channelId)
  );
}

/** Read and clear the queued join, if any. */
export function takePendingVoiceJoin(host: JoinHost): PendingVoiceJoin | null {
  const s = host.getState();
  const pendingJoin = s.type === "connecting" ? s.pendingJoin : null;
  if (s.type === "connecting") {
    host.setState({ ...s, pendingJoin: null });
  }
  return pendingJoin;
}

/** Queue the latest join on the attempt already connecting. */
export function queueJoin(
  host: JoinHost,
  token: string,
  url: string,
  channelId: number,
  directUrl?: string,
  isKeyHolder?: boolean,
): void {
  // Update the pendingJoin on the existing "connecting" state immutably.
  const s = host.getState();
  if (s.type === "connecting") {
    host.setState({
      ...s,
      pendingJoin: { token, url, channelId, directUrl, isKeyHolder },
    });
    // The server has already moved us to this channel: from here on the
    // announces it relays are the queued channel's peers, whose exchange
    // starts only when the drain re-enters connectAndSetup. Hold them for
    // that session; the attempt in flight is about to be discarded, and
    // retargeting drops what a superseded queued channel had collected.
    // Set synchronously, before any await: correctness relies on the voice_token
    // and voice_e2ee_announce handlers resolving their dynamic imports in order.
    host.getE2EE().holdAnnouncesForQueuedJoin(channelId);
  }
  log.warn("handleVoiceToken: already connecting, queued latest join request", { channelId });
}
