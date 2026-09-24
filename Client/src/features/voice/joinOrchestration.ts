// Voice join orchestration — extracted from livekitSession.ts.
// Owns the session-attempt state machine: the connect-with-retry path, its
// supersession checkpoints, and the pending-join drain loop. The session
// state, the join-generation counter and every collaborator stay owned by
// LiveKitSession (single writer); this module reads and writes them only
// through JoinHost, so the class stays the facade the suites drive.
import type { Room } from "livekit-client";
import { voiceStore, leaveVoiceChannel, setVoiceStatus } from "../../stores/voice.store";
import { loadPref } from "../../components/settings/helpers";
import { createLogger } from "../../lib/logger";
import { logIceConnectionInfo } from "../../lib/livekitDiagnostics";
import type { AudioPipeline } from "../../lib/audioPipeline";
import type { AudioElements } from "../../lib/audioElements";
import type { DeviceManager } from "../../lib/deviceManager";
import type { E2EEManager } from "../../lib/livekitE2EE";
import type { SessionState } from "./sessionState";
import { detachRoom, releaseRoom } from "./releaseRoom";
import { voiceText } from "../../i18n/voice";

// Same logger tag as before the extraction, so the join log lines are unchanged.
const log = createLogger("livekitSession");

/** Everything the join orchestration needs from LiveKitSession. Collaborators
 *  are read through getters on every use, never captured, so the session (and
 *  the suites that reach into it) stay the single owner of each one. */
export interface JoinHost {
  getState(): SessionState;
  setState(next: SessionState): void;
  /** Draw the next value from the session's monotonic join-generation counter. */
  nextJoinGeneration(): number;
  getRoom(): Room | null;
  getE2EE(): Pick<E2EEManager, "clearState" | "setupKeyExchange">;
  getAudioPipeline(): AudioPipeline;
  getAudioElements(): AudioElements;
  getDeviceManager(): DeviceManager;
  getOnError(): ((message: string) => void) | null;
  createRoom(channelId: number): Promise<Room>;
  resolveLiveKitUrl(proxyPath: string, directUrl?: string): Promise<string>;
  restoreLocalVoiceState(mode: "join"): Promise<void>;
  reapplyMuteGain(): void;
  startTokenRefreshTimer(): void;
  syncModuleRooms(): void;
  leaveVoice(sendWs: boolean): void;
  handleVoiceTokenRefresh(token: string): void;
  /** The session's own connectAndSetup, so the drain loop re-enters through it. */
  connectAndSetup(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<boolean | "superseded">;
}

export class JoinOrchestration {
  constructor(private readonly host: JoinHost) {}

  // --- Host views, named as the pre-extraction fields so the body reads the same ---

  private get _state(): SessionState {
    return this.host.getState();
  }
  private get _room(): Room | null {
    return this.host.getRoom();
  }
  private get _connecting(): boolean {
    return this.host.getState().type === "connecting";
  }
  private get _e2ee(): Pick<E2EEManager, "clearState" | "setupKeyExchange"> {
    return this.host.getE2EE();
  }
  private get _audioPipeline(): AudioPipeline {
    return this.host.getAudioPipeline();
  }
  private get _audioElements(): AudioElements {
    return this.host.getAudioElements();
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
  private leaveVoice(sendWs: boolean): void {
    this.host.leaveVoice(sendWs);
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
  private syncModuleRooms(): void {
    this.host.syncModuleRooms();
  }
  private handleVoiceTokenRefresh(token: string): void {
    this.host.handleVoiceTokenRefresh(token);
  }

  /** Helper to check state is "connected" for this exact room and channel, reading
   *  through a method call so TS control-flow narrowing cannot cache the result.
   *  Used in connectAndSetup() checkpoints after setState() transitions. */
  isStateConnected(channelId: number, room: Room): boolean {
    const s: SessionState = this._state;
    return s.type === "connected" && s.channelId === channelId && s.room === room;
  }

  private ownsConnectAttempt(generation: number): boolean {
    return this._state.type === "connecting" && this._state.joinGeneration === generation;
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
   *  OC-0006: also re-syncs the extracted modules (DeviceManager/AudioPipeline
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
  disconnectSupersededLocalRoom(localRoom: Room): void {
    releaseRoom(localRoom).catch((err) => log.debug("Failed to disconnect superseded room", err));
    if (this._state.type === "idle") this.syncModuleRooms();
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
    // Also tear down (and abort) an in-flight reconnect: `_room` reads null
    // for the whole "reconnecting" state, so a join issued while the LiveKit
    // auto-reconnect loop is running would otherwise skip leaveVoice(false)
    // entirely — meaning _e2ee.clearState() never runs, and setupKeyExchange
    // below inherits the PREVIOUS channel's residual _isKeyHolder via its
    // OR-with-server-value guard, joining the new channel as a phantom key
    // holder the server never elected (OC-0020).
    if (this._room !== null || this._state.type === "reconnecting") {
      this.leaveVoice(false);
    } else if (this._state.type === "connecting") {
      // OC-0001: the pending-join drain loop (handleVoiceToken) re-enters
      // this function while `_state` is still "connecting" — there is no
      // room to disconnect and no reconnect AC to abort, so the branch above
      // never fires, but a discarded prior attempt (e.g. the e2ee_timeout /
      // checkpoint-2 queued-join paths below) can still leave residual E2EE
      // state (_isKeyHolder, keypair, peer keys) behind for THIS attempt to
      // inherit via setupKeyExchange's OR-with-server-value guard. Clear it
      // explicitly since leaveVoice() itself never runs on this path.
      this._e2ee.clearState();
    }
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
    let resolvedUrl = "";
    // Track the room being built in this attempt so we can disconnect it on
    // supersession without touching the shared state (which may already have
    // been claimed by a newer attempt).
    let localRoom: Room | null = null;
    try {
      localRoom = await this.createRoom(channelId);
      if (!this.ownsConnectAttempt(myGeneration)) {
        this.disconnectSupersededLocalRoom(localRoom);
        return "superseded";
      }
      this._audioPipeline.setRoom(localRoom);
      this._audioElements.setRoom(localRoom);
      this._deviceManager.setRoom(localRoom);
      this._deviceManager.setAudioPipeline(this._audioPipeline);
      this._deviceManager.setOnError(this._onError);
      this._deviceManager.setOnToast(this._onError);
      resolvedUrl = await this.resolveLiveKitUrl(url, directUrl);

      // Checkpoint 1: after URL resolution (may be slow for TLS proxy init).
      if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
        log.info("connectAndSetup: superseded after URL resolution — aborting", {
          channelId,
          myGeneration,
          currentGeneration: this._state.type === "connecting" ? this._state.joinGeneration : "n/a",
        });
        this.disconnectSupersededLocalRoom(localRoom);
        return "superseded";
      }

      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 2000;

      // ── Client-side E2EE key exchange (ECDH) ──────────────────────────
      // "securing" — until the room key is ready the call is not yet private.
      // Non-key-holders block here waiting for the key holder's offer (up to
      // ~15s); key holders pass through near-instantly.
      setVoiceStatus("securing");
      const keyExchangeOk = await this._e2ee.setupKeyExchange(isKeyHolder ?? false, channelId);
      if (!keyExchangeOk) {
        // setupKeyExchange() also returns false when clearState() aborted the
        // wait (e.g. a supersession that ran leaveVoice() while we were
        // blocked here) — indistinguishable from a genuine timeout by return
        // value alone. Check ownership before treating it as a real failure:
        // a superseded attempt must not fire a spurious toast, send
        // voice_leave (it carries no channel id and would act on whichever
        // channel the NEWER attempt just joined), or clear the store's
        // currentChannelId that the newer join just set.
        if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
          log.info("connectAndSetup: superseded during key exchange — aborting", {
            channelId,
            myGeneration,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }
        releaseRoom(localRoom).catch((err) =>
          log.debug("Failed to disconnect room after key exchange failure", err),
        );
        // OC-0010: a channel switch queued during the wait (handleVoiceToken's
        // pendingJoin branch) preserves this attempt's type/joinGeneration, so
        // the ownership check above cannot distinguish it from "no newer join
        // is coming". Treating it as a genuine failure here would send
        // voice_leave with no channel id — deleting the QUEUED join's
        // voice_states row, not this timed-out attempt's — and would drop the
        // pendingJoin itself by transitioning to idle before the drain loop
        // ever reads it. Only run the give-up cleanup when nothing is queued.
        if (this._state.pendingJoin === null) {
          this._onError?.("e2ee_timeout");
          // The exchange timed out BEFORE room.connect(): no SFU participant
          // exists, so no LiveKit webhook will ever clean up, and the server
          // registered the join when it sent voice_token. Send voice_leave and
          // leave the store's voice channel (like the reconnect-exhausted give-up
          // path) or the stale row ghosts forever and can wedge the channel's
          // key-holder election.
          this.leaveVoice(true);
          leaveVoiceChannel();
        } else {
          // Leave state as "connecting" with pendingJoin intact so the finally
          // block and handleVoiceToken's drain loop can run the queued join.
          // Clear this attempt's own E2EE residue (keypair/_isKeyHolder/etc.)
          // so the queued join does not inherit it — entry-point leaveVoice(false)
          // never runs for that next call since `_room` is null here (OC-0001).
          this._e2ee.clearState();
        }
        return false;
      }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- sequential retry: must attempt connect before checking result
          await localRoom.connect(resolvedUrl, token);

          // Checkpoint 2: after room.connect() — the primary race window.
          if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
            log.info("connectAndSetup: superseded after room.connect() — aborting", {
              channelId,
              myGeneration,
              currentGeneration:
                this._state.type === "connecting" ? this._state.joinGeneration : "n/a",
            });
            this.disconnectSupersededLocalRoom(localRoom);
            return "superseded";
          }

          // Belt-and-suspenders: also keep existing pending-join token check
          // for logging clarity when a newer request arrived via pendingJoin.
          const queuedJoin = this._state.type === "connecting" ? this._state.pendingJoin : null;
          if (
            queuedJoin !== null &&
            (queuedJoin.token !== token ||
              queuedJoin.url !== url ||
              queuedJoin.channelId !== channelId ||
              queuedJoin.directUrl !== directUrl)
          ) {
            log.info("Discarding stale voice join in favor of queued request", {
              channelId,
              queuedChannelId: queuedJoin.channelId,
            });
            detachRoom(localRoom);
            localRoom
              .disconnect()
              .catch((err) => log.debug("Failed to disconnect room during cleanup", err));
            localRoom = null;
            this._audioPipeline.setRoom(null);
            this._audioElements.setRoom(null);
            this._deviceManager.setRoom(null);
            this._deviceManager.setAudioPipeline(null);
            break;
          }
          break;
        } catch (connectErr) {
          if (attempt < MAX_RETRIES) {
            log.warn("LiveKit connect failed, retrying", {
              attempt,
              maxRetries: MAX_RETRIES,
              url: resolvedUrl,
              error: connectErr,
            });
            // oxlint-disable-next-line no-await-in-loop -- intentional backoff delay between retry attempts
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            // Generation check inside retry loop: a superseding join may arrive
            // during the backoff delay.
            if (this._state.type !== "connecting" || this._state.joinGeneration !== myGeneration) {
              log.info("connectAndSetup: superseded during retry backoff — aborting", {
                channelId,
                attempt,
              });
              if (localRoom !== null) this.disconnectSupersededLocalRoom(localRoom);
              return "superseded";
            }
            if (localRoom === null) throw connectErr;
            detachRoom(localRoom);
            // oxlint-disable-next-line no-await-in-loop -- sequential retry: must arm E2EE before the next connect attempt
            localRoom = await this.createRoom(channelId);
            if (!this.ownsConnectAttempt(myGeneration)) {
              this.disconnectSupersededLocalRoom(localRoom);
              return "superseded";
            }
            this._audioPipeline.setRoom(localRoom);
            this._audioElements.setRoom(localRoom);
            this._deviceManager.setRoom(localRoom);
            this._deviceManager.setAudioPipeline(this._audioPipeline);
          } else {
            throw connectErr;
          }
        }
      }
      // If the room was discarded (stale join superseded by pending), skip setup.
      if (localRoom !== null) {
        log.info("Connected to LiveKit room", { channelId, url: resolvedUrl });
        logIceConnectionInfo(localRoom);
        // Atomic transition to "connected" — all connection fields set together.
        this.setState({
          type: "connected",
          room: localRoom,
          channelId,
          latestToken: token,
          lastUrl: url,
          lastDirectUrl: directUrl,
        });
        // Room connected and E2EE key ready — the call is now secured.
        setVoiceStatus("connected");
        // Optimistic startAudio — may succeed if the join was triggered by a
        // recent user gesture. If not, the AudioPlaybackStatusChanged handler
        // will register a click-to-unlock fallback.
        localRoom.startAudio().catch(() => {
          log.debug("Optimistic startAudio failed — waiting for user gesture");
        });
        await this.restoreLocalVoiceState("join");

        // Checkpoint 3: after restoreLocalVoiceState (mic acquisition can be slow).
        // Cast to SessionState to escape TS control-flow narrowing that incorrectly
        // assumes _state is still "connecting" (it was set to "connected" above, but
        // TS cannot see through the setState() opaque method call).
        if (!this.isStateConnected(channelId, localRoom)) {
          log.info("connectAndSetup: superseded after restoreLocalVoiceState — aborting", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }

        const savedInput = loadPref<string>("audioInputDevice", "");
        if (savedInput) {
          try {
            await localRoom.switchActiveDevice("audioinput", savedInput);
          } catch (err) {
            log.warn("Saved input device unavailable, using default", err);
          }
        }

        // Checkpoint 4: after audioinput switchActiveDevice.
        if (!this.isStateConnected(channelId, localRoom)) {
          log.info("connectAndSetup: superseded after audioinput switch — aborting", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
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
          log.info("connectAndSetup: superseded after audiooutput switch — aborting", {
            channelId,
          });
          this.disconnectSupersededLocalRoom(localRoom);
          return "superseded";
        }

        this._audioPipeline.setupAudioPipeline();
        this.reapplyMuteGain();
        this.startTokenRefreshTimer();
        log.info("Voice session active", { channelId });
        return true;
      }
      return false;
    } catch (err) {
      log.error("Failed to connect to LiveKit", { url: resolvedUrl, error: err });
      if (localRoom !== null) {
        // Drop this attempt's listeners BEFORE disconnecting: handleDisconnected
        // acts on the shared session state, so a failed attempt's Disconnected
        // event would otherwise tear down (or spawn a reconnect loop for)
        // whichever session owns `_state` by then — which, when this attempt
        // has been superseded, is a live one that belongs to a newer join.
        try {
          void releaseRoom(localRoom);
        } catch (disconnectErr) {
          log.debug("Room disconnect during error cleanup failed (safe to ignore)", disconnectErr);
        }
        this._onError?.(voiceText("join.connectionError"));
      }
      // Only touch the shared session state if this attempt is still current.
      // A superseded attempt must not clear a newer join's server-side voice
      // membership — leaveVoice's voice_leave frame carries no channel id and
      // acts on whichever channel the user currently occupies, so sending it
      // here for a stale attempt would delete the NEW join's voice_states row
      // — nor reset a live session back to idle (CLAUDE.md: voice sessions are
      // superseded, not cancelled).
      if (
        this._state.type === "connecting" &&
        this._state.joinGeneration === myGeneration &&
        this._state.pendingJoin === null
      ) {
        // The connect attempt failed entirely: no SFU participant was ever
        // created, so no LiveKit webhook will ever clean up, and the server
        // already registered the join when it sent voice_token. Send
        // voice_leave and leave the store's voice channel (mirroring the
        // e2ee-timeout and reconnect-exhausted give-up paths) or the stale
        // voice_states row ghosts forever and can wedge the channel's
        // key-holder election.
        this.leaveVoice(true);
        leaveVoiceChannel();
      }
      return false;
    } finally {
      // Only clear "connecting" back to "idle" if we are still in the connecting
      // state for this generation — never overwrite a "connected" state that was
      // set by the success path above (guards against risk #4 in the analysis).
      // If a pendingJoin was queued while this attempt ran, leave the state as
      // "connecting" so handleVoiceToken's drain loop can read and consume it.
      if (this._state.type === "connecting" && this._state.joinGeneration === myGeneration) {
        if (this._state.pendingJoin === null) {
          this.setState({ type: "idle" });
        }
      }
    }
  }

  async handleVoiceToken(
    token: string,
    url: string,
    channelId: number,
    directUrl?: string,
    isKeyHolder?: boolean,
  ): Promise<void> {
    const s = this._state;
    // OC-0015: livekit-client's own internal reconnect (network blip on the
    // SFU signal socket) moves Room.state through "signalReconnecting" /
    // "reconnecting" without ever emitting RoomEvent.Disconnected — the only
    // event this session listens for — so `_state` stays "connected" the
    // whole time. A routine 4-minute refresh token landing in that window
    // must still take the lightweight refresh path instead of falling
    // through to a full teardown+rejoin of a session that is about to
    // recover on its own; only a room the SDK has fully given up on
    // ("disconnected") should be treated as needing a real reconnect here.
    if (s.type === "connected" && s.channelId === channelId && s.room.state !== "disconnected") {
      this.handleVoiceTokenRefresh(token);
      return;
    }
    // Prevent concurrent connect attempts (rapid channel switching).
    if (this._connecting) {
      // Update the pendingJoin on the existing "connecting" state immutably.
      if (this._state.type === "connecting") {
        this.setState({
          ...this._state,
          pendingJoin: { token, url, channelId, directUrl, isKeyHolder },
        });
      }
      log.warn("handleVoiceToken: already connecting, queued latest join request", { channelId });
      return;
    }
    // OC-0009: a voice_token can arrive after the user already left this
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
    let pendingJoin = this._state.type === "connecting" ? this._state.pendingJoin : null;
    if (this._state.type === "connecting") {
      this.setState({ ...this._state, pendingJoin: null });
    }
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
      pendingJoin = this._state.type === "connecting" ? this._state.pendingJoin : null;
      if (this._state.type === "connecting") {
        this.setState({ ...this._state, pendingJoin: null });
      }
    }
  }
}
