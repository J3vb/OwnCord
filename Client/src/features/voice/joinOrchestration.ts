// Voice join orchestration — extracted from livekitSession.ts.
// Owns the session-attempt state machine: the connect-with-retry path, its
// supersession checkpoints, and the pending-join drain loop. The session
// state, the join-generation counter and every collaborator stay owned by
// LiveKitSession (single writer); this module reads and writes them only
// through JoinHost, so the class stays the facade the suites drive. The
// synchronous checkpoint, failure and queue helpers live in joinSupport.ts
// and joinFailures.ts; every await and the ownership check that guards it
// stay in this file.
import type { Room } from "livekit-client";
import { voiceStore, setVoiceStatus } from "../../stores/voice.store";
import { loadPref } from "@lib/prefs/preferences";
import { createLogger } from "../../lib/logger";
import type { AudioPipeline } from "../../lib/voice/audioPipeline";
import type { DeviceManager } from "../../lib/voice/deviceManager";
import type { E2EEManager } from "../../lib/voice/livekitE2EE";
import { ROOM_CONNECT_OPTIONS, type SessionState } from "./sessionState";
import { detachRoom } from "./releaseRoom";
import {
  abandonJoinAttempt,
  advanceJoinStage,
  beginJoinAttempt,
  classifyJoinUrl,
  redactTunnelUrl,
  countJoinRetry,
  finishJoinAttempt,
  setJoinUrlKind,
} from "../../lib/voice/voiceJoinTrace";
import { noteJoinSucceeded } from "./joinBackoff";
import type { JoinHost } from "./joinHost";
import {
  clearForNewAttempt,
  disconnectSupersededLocalRoom,
  discardForQueuedJoin,
  dropSuperseded,
  hasQueuedJoin,
  isRefreshFor,
  isStateConnected,
  currentGeneration,
  ownsConnectAttempt,
  queueJoin,
  takePendingVoiceJoin,
  wireModules,
} from "./joinSupport";
import { claimSession, onConnectFailed, onKeyExchangeFailed } from "./joinFailures";

export type { JoinHost } from "./joinHost";

// Same logger tag as before the extraction, so the join log lines are unchanged.
const log = createLogger("livekitSession");

export class JoinOrchestration {
  constructor(private readonly host: JoinHost) {}

  // --- Host views, named as the pre-extraction fields so the body reads the same ---

  private get _state(): SessionState {
    return this.host.getState();
  }
  private get _connecting(): boolean {
    return this.host.getState().type === "connecting";
  }
  private get _e2ee(): Pick<E2EEManager, "setupKeyExchange"> {
    return this.host.getE2EE();
  }
  private get _audioPipeline(): AudioPipeline {
    return this.host.getAudioPipeline();
  }
  private get _deviceManager(): DeviceManager {
    return this.host.getDeviceManager();
  }
  private get _onError(): ((message: string) => void) | null {
    return this.host.getOnError();
  }
  private setState(next: SessionState): void {
    this.host.setState(next);
  }
  private createRoom(channelId: number): Promise<Room> {
    return this.host.createRoom(channelId);
  }
  private resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string> {
    return this.host.resolveLiveKitUrl(proxyPath, directUrl);
  }
  private restoreLocalVoiceState(mode: "join"): Promise<void> {
    return this.host.restoreLocalVoiceState(mode);
  }
  private reapplyMuteGain(): void {
    this.host.reapplyMuteGain();
  }
  private startTokenRefreshTimer(): void {
    this.host.startTokenRefreshTimer();
  }
  private handleVoiceTokenRefresh(token: string): void {
    this.host.handleVoiceTokenRefresh(token);
  }

  /** Whether state is "connected" for this exact room and channel (see joinSupport). */
  isStateConnected(channelId: number, room: Room): boolean {
    return isStateConnected(this.host, channelId, room);
  }

  /** Checkpoint cleanup for a superseded attempt (see joinSupport). */
  disconnectSupersededLocalRoom(localRoom: Room): void {
    disconnectSupersededLocalRoom(this.host, localRoom);
  }

  private ownsConnectAttempt(generation: number): boolean {
    return ownsConnectAttempt(this.host, generation);
  }

  private dropSuperseded(localRoom: Room): "superseded" {
    return dropSuperseded(this.host, localRoom);
  }

  /** The connect-with-retry loop; on success it claims the session in the
   *  same tick as its checkpoint. `attempt.room` always holds the room this
   *  attempt owns now (the catch in connectAndSetup releases it); it is null
   *  when the connected room was discarded for a queued request. Resolves
   *  "superseded" when a checkpoint found a newer join. */
  private async connectWithRetry(
    attempt: { room: Room | null },
    join: { token: string; url: string; channelId: number; directUrl?: string },
    resolvedUrl: string,
    myGeneration: number,
    traceId: number,
  ): Promise<"connected" | "superseded"> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    const { token, channelId } = join;
    for (let tries = 1; tries <= MAX_RETRIES; tries++) {
      if (tries > 1) countJoinRetry(traceId);
      const room = attempt.room!;
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential retry: must attempt connect before checking result
        await room.connect(resolvedUrl, token, ROOM_CONNECT_OPTIONS);
        // Checkpoint 2: after room.connect() — the primary race window.
        if (!this.ownsConnectAttempt(myGeneration)) {
          log.info("connectAndSetup: superseded after room.connect() — aborting", {
            channelId,
            myGeneration,
            currentGeneration: currentGeneration(this.host),
          });
          return this.dropSuperseded(room);
        }
        // Belt-and-suspenders: also keep existing pending-join token check
        // for logging clarity when a newer request arrived via pendingJoin.
        if (discardForQueuedJoin(this.host, room, join)) attempt.room = null;
        break;
      } catch (connectErr) {
        if (tries >= MAX_RETRIES) throw connectErr;
        log.warn("LiveKit connect failed, retrying", {
          attempt: tries,
          maxRetries: MAX_RETRIES,
          url: redactTunnelUrl(resolvedUrl),
          error: connectErr,
        });
        // oxlint-disable-next-line no-await-in-loop -- intentional backoff delay between retry attempts
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        // Generation check inside retry loop: a superseding join may arrive
        // during the backoff delay.
        if (!this.ownsConnectAttempt(myGeneration)) {
          log.info("connectAndSetup: superseded during retry backoff — aborting", {
            channelId,
            attempt: tries,
          });
          return this.dropSuperseded(room);
        }
        detachRoom(room);
        // oxlint-disable-next-line no-await-in-loop -- sequential retry: must arm E2EE before the next connect attempt
        attempt.room = await this.createRoom(channelId);
        if (!this.ownsConnectAttempt(myGeneration)) {
          this.disconnectSupersededLocalRoom(attempt.room);
          return "superseded";
        }
        wireModules(this.host, attempt.room);
      }
    }
    // Outside the retry catch, so a throw here fails the join as before
    // instead of retrying the connect.
    if (attempt.room !== null) claimSession(this.host, attempt.room, join, resolvedUrl, traceId);
    return "connected";
  }

  /** Bring the call up on the claimed session (the rest of the "activate"
   *  phase: device switches, local voice state, pipeline). */
  private async activateRoom(
    localRoom: Room,
    channelId: number,
    traceId: number,
  ): Promise<true | "superseded"> {
    // Point capture at the saved input BEFORE the mic is first
    // enabled. With no mic track yet this only records the capture
    // constraint (native: the backend's capture device), so the join opens
    // the saved mic once instead of publishing on the default and then
    // switching. Non-exact, so a saved mic that is gone degrades to the
    // default rather than failing the publish into listen-only.
    const savedInput = loadPref<string>("audioInputDevice", "");
    if (savedInput) {
      try {
        await localRoom.switchActiveDevice("audioinput", savedInput, false);
      } catch (err) {
        log.warn("Saved input device unavailable, using default", err);
      }
    }

    // Checkpoint 4: after audioinput switchActiveDevice.
    if (!this.isStateConnected(channelId, localRoom)) {
      log.info("connectAndSetup: superseded after audioinput switch — aborting", { channelId });
      return this.dropSuperseded(localRoom);
    }

    await this.restoreLocalVoiceState("join");

    // Checkpoint 3: after restoreLocalVoiceState (mic acquisition can be slow).
    if (!this.isStateConnected(channelId, localRoom)) {
      log.info("connectAndSetup: superseded after restoreLocalVoiceState — aborting", {
        channelId,
      });
      return this.dropSuperseded(localRoom);
    }

    const savedOutput = loadPref<string>("audioOutputDevice", "");
    if (savedOutput) {
      try {
        await localRoom.switchActiveDevice("audiooutput", savedOutput);
      } catch (err) {
        log.warn("Saved output device unavailable, using default", err);
      }
    }

    // Checkpoint 5: after audiooutput switchActiveDevice.
    if (!this.isStateConnected(channelId, localRoom)) {
      log.info("connectAndSetup: superseded after audiooutput switch — aborting", { channelId });
      return this.dropSuperseded(localRoom);
    }

    this._audioPipeline.setupAudioPipeline();
    this.reapplyMuteGain();
    // A join the user already switched away from leaves the restate to
    // the switch's own join, and keeps the switch's wait.
    const stillHere = voiceStore.getState().currentChannelId === channelId;
    if (stillHere) this.host.restateSelfVoiceState();
    this.startTokenRefreshTimer();
    log.info("Voice session active", { channelId });
    finishJoinAttempt(traceId);
    if (voiceStore.getState().currentChannelId === channelId) noteJoinSucceeded();
    return true;
  }

  /** Shared connect-with-retry + post-connect setup used by both the primary
   *  handleVoiceToken path and the pending-join drain loop.
   *  Returns true if the room ended up connected and set up,
   *  false on error, or "superseded" if a newer join generation invalidated
   *  this attempt (caller should re-read pendingJoin immediately). */
  async connectAndSetup(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<boolean | "superseded"> {
    clearForNewAttempt(this.host);
    // Draw the next generation from the monotonic instance counter (never
    // re-derived from `_state`) and embed it into the "connecting" state.
    // Any newer call to connectAndSetup() will produce a strictly larger
    // generation, making myGeneration !== currentGeneration at each
    // checkpoint even if this attempt's own state transitioned through
    // "idle" in the meantime.
    const myGeneration = this.host.nextJoinGeneration();
    this.setState({ type: "connecting", pendingJoin: null, joinGeneration: myGeneration });
    // "joining" = connecting to the room; the E2EE "securing" phase is set below.
    setVoiceStatus("joining");
    // SRE-M2: one timeline line per attempt. beginJoinAttempt abandons any
    // unfinished previous attempt without recording it — a superseded join is
    // normal churn, not a failure.
    const traceId = beginJoinAttempt(channelId);
    const join = { token, url, channelId, directUrl };
    let resolvedUrl = "";
    // Track the room being built in this attempt so we can disconnect it on
    // supersession without touching the shared state (which may already have
    // been claimed by a newer attempt).
    const attempt: { room: Room | null } = { room: null };
    try {
      const firstRoom = await this.createRoom(channelId);
      attempt.room = firstRoom;
      if (!this.ownsConnectAttempt(myGeneration)) {
        this.disconnectSupersededLocalRoom(firstRoom);
        return "superseded";
      }
      wireModules(this.host, firstRoom);
      this._deviceManager.setOnError(this._onError);
      this._deviceManager.setOnToast(this._onError);
      // SRE-M2: the failure stage a URL-resolution failure lands at is
      // "resolve" (the stage beginJoinAttempt opens on), so a resolve throw is
      // recorded as a resolve failure by the catch below without moving on.
      resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);
      setJoinUrlKind(traceId, classifyJoinUrl(resolvedUrl, directUrl, url));

      // Checkpoint 1: after URL resolution (may be slow for TLS proxy init).
      if (!this.ownsConnectAttempt(myGeneration)) {
        log.info("connectAndSetup: superseded after URL resolution — aborting", {
          channelId,
          myGeneration,
          currentGeneration: currentGeneration(this.host),
        });
        return this.dropSuperseded(firstRoom);
      }

      // ── Client-side E2EE key exchange (ECDH) ──────────────────────────
      // "securing" — until the room key is ready the call is not yet private.
      // Non-key-holders block here waiting for the key holder's offer (up to
      // ~15s); key holders pass through near-instantly.
      setVoiceStatus("securing");
      advanceJoinStage(traceId, "keyExchange");
      const keyExchangeOk = await this._e2ee.setupKeyExchange(isKeyHolder ?? false, channelId);
      if (!keyExchangeOk) {
        return onKeyExchangeFailed(this.host, firstRoom, channelId, myGeneration, traceId);
      }

      // SRE-M2: entering "connect" ends the key-exchange phase; the connect
      // phase start is set once, before the first attempt, so a retry re-runs
      // the connect without resetting the phase clock.
      advanceJoinStage(traceId, "connect");
      const connected = await this.connectWithRetry(
        attempt,
        join,
        resolvedUrl,
        myGeneration,
        traceId,
      );
      if (connected === "superseded") return "superseded";
      // If the room was discarded (stale join superseded by pending), skip setup.
      const room = attempt.room;
      if (room === null) return false;
      return await this.activateRoom(room, channelId, traceId);
    } catch (err) {
      onConnectFailed(this.host, err, resolvedUrl, attempt.room, channelId, myGeneration, traceId);
      return false;
    } finally {
      // Only clear "connecting" back to "idle" if we are still in the connecting
      // state for this generation — never overwrite a "connected" state that was
      // set by the success path above (guards against risk #4 in the analysis).
      // If a pendingJoin was queued while this attempt ran, leave the state as
      // "connecting" so handleVoiceToken's drain loop can read and consume it.
      if (this.ownsConnectAttempt(myGeneration) && !hasQueuedJoin(this.host)) {
        this.setState({ type: "idle" });
      }
      // SRE-M2: every exit path that did not record the attempt (success or a
      // placed failure) leaves it superseded — drop it silently rather than
      // report a live join as failed.
      abandonJoinAttempt(traceId);
    }
  }

  async handleVoiceToken(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<void> {
    if (isRefreshFor(this.host, channelId)) {
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this._connecting) {
      queueJoin(this.host, token, url, channelId, directUrl, isKeyHolder);
      return;
    }
    // A voice_token can arrive after the user already left this
    // channel (e.g. Disconnect fired before the voice_join/voice_token round
    // trip returned) — `_state` alone cannot tell, since a leave that landed
    // before any connectAndSetup() ever started leaves `_state` at "idle"
    // either way. voiceStore.currentChannelId is the one place the leave is
    // recorded independent of this session's own lifecycle: joinVoiceChannel()
    // always sets it before the request that produced this token was sent,
    // and leaveVoiceChannel() nulls it, so a mismatch here means the token is
    // stale. Connecting anyway would silently rejoin the SFU and republish
    // the mic for a call the UI, store, and server all consider ended.
    if (voiceStore.getState().currentChannelId !== channelId) {
      log.info("handleVoiceToken: voice_token for a channel we already left — ignoring", {
        channelId,
      });
      return;
    }
    await this.host.connectAndSetup(token, url, channelId, directUrl, isKeyHolder);
    // Drain pending joins iteratively to avoid unbounded recursion when
    // rapid channel switches queue multiple requests.
    // A "superseded" result means connectAndSetup() already aborted early;
    // we still drain pendingJoin so the latest request always wins.
    let pendingJoin = takePendingVoiceJoin(this.host);
    while (pendingJoin !== null) {
      const {
        token: pToken,
        url: pUrl,
        channelId: pChannelId,
        directUrl: pDirectUrl,
        isKeyHolder: pIsKeyHolder,
      } = pendingJoin;
      const cur = this._state;
      if (
        cur.type === "connected" &&
        cur.channelId === pChannelId &&
        cur.room.state !== "disconnected"
      ) {
        this.handleVoiceTokenRefresh(pToken);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- sequential drain of pending joins to avoid unbounded recursion
        await this.host.connectAndSetup(pToken, pUrl, pChannelId, pDirectUrl, pIsKeyHolder);
        // If this attempt was itself superseded (another join arrived during the
        // await), the loop will naturally pick it up via the updated pendingJoin.
      }
      pendingJoin = takePendingVoiceJoin(this.host);
    }
  }
}
