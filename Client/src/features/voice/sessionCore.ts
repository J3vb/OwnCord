// The session's connection state and its typed accessors: the base of the
// `LiveKitSession` facade, which layers each concern on top of this one. The
// state machine has a single writer (`setState`); every other layer reads it
// through the accessors here.
import type { WsClient } from "@lib/ws";
import { voiceStore } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import type { SessionState } from "./sessionState";
import type { LostMedia } from "./mediaLostNotice";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

const log = createLogger("livekitSession");

export abstract class SessionCore {
  /** Single source of truth for all connection-lifecycle state. */
  protected _state: SessionState = { type: "idle" };

  /** The ONLY source of join generations. Must never be
   *  re-derived from `_state` — a transition through "idle" (e.g. leaveVoice()
   *  during an in-flight connect) would reset a derived counter back to the
   *  same value a still-running stale attempt is holding, letting the two
   *  attempts collide on one generation and defeating every supersession
   *  checkpoint. Monotonic increments here guarantee every connectAndSetup()
   *  call gets a value no other attempt has ever held, regardless of how
   *  many times the session has bounced through "idle" in between. */
  protected _joinGenerationCounter = 0;

  /** P2-T5: the latest token and when it arrived, so a long reconnect knows
   *  when it needs a fresh one (server TTL 5 minutes). */
  protected _stampedToken: string | null = null;
  protected _tokenReceivedAt = 0;
  /** The reconnect attempt waiting for a voice_token_refresh reply. */
  protected _tokenWaiter: (() => void) | null = null;
  /** P2-T5: the reconnect loop sent voice_join and awaits the server's answer. */
  protected _rejoinPending = false;

  /** The reconnect loop cleared the session for a join the user had already
   *  sent for another channel, and that join has no answer yet. The server may
   *  still hold the old call (a join refused before it moves the member leaves
   *  it in place), so the refusal has to end it. Cleared when the join starts
   *  connecting and by every leave. */
  protected _yieldedToJoin = false;
  /** Bounds that wait: an answer that never comes ends as a give-up. */
  protected _yieldTimer: ReturnType<typeof setTimeout> | null = null;

  protected ws: WsClient | null = null;
  protected onErrorCallback: ((message: string) => void) | null = null;
  protected serverHost: string | null = null;

  /** An explicit unmute waiting for this room's SFU publishing grant. */
  protected pendingMicrophoneRoom: VoiceRoom | null = null;

  /** What teardownForReconnect stopped, restored once the reconnect (or its
   *  rejoin) lands. Cleared by leaveVoice, so a give-up restores nothing. */
  protected _lostOnReconnect: LostMedia | null = null;
  /** The app whose music share a drop stopped; shared again once the call
   *  is back. Merged across drops like `_lostOnReconnect`. */
  protected _lostMusicApp: string | null = null;

  /** Temporary holding field: populated by setRoom(null) in handleDisconnected's
   *  callback sequence so setReconnectAc can form the "reconnecting" state atomically. */
  protected _pendingReconnectFields: {
    channelId: number;
    latestToken: string;
    lastUrl: string;
    lastDirectUrl: string | undefined;
  } | null = null;

  /** The join a reconnect was cleared for has its answer, or the call ended. */
  protected clearYield(): void {
    this._yieldedToJoin = false;
    if (this._yieldTimer !== null) clearTimeout(this._yieldTimer);
    this._yieldTimer = null;
  }

  // --- State transition (single writer) ---

  protected setState(next: SessionState): void {
    const prev = this._state.type;
    this._state = next;
    if (
      (next.type === "connected" || next.type === "reconnecting") &&
      next.latestToken !== this._stampedToken
    ) {
      this._stampedToken = next.latestToken;
      this._tokenReceivedAt = Date.now();
    }
    log.debug("Session state transition", { from: prev, to: next.type });
  }

  // --- Typed state accessors (replace scattered field reads) ---

  /** Room from state, or null when idle/connecting/reconnecting. */
  protected get _room(): VoiceRoom | null {
    return this._state.type === "connected" ? this._state.room : null;
  }

  /** Channel ID from state, or null when idle/connecting. */
  protected get _currentChannelId(): number | null {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.channelId
      : null;
  }

  /** The channel's configured audio encoding, or undefined when no
   *  voice_config has arrived for it yet (LiveKit's own audio default then
   *  applies, because the caller omits audioPreset entirely).
   *
   *  The server computes an audio bitrate from the channel's voice
   *  quality and delivers it via voice_config (setVoiceConfig ->
   *  voiceStore.voiceConfigs).
   *
   *  createRoom folds this into publishDefaults, but it runs
   *  synchronously from the voice_token handler and the server sends
   *  voice_config only afterwards — an ordering frozen by the epoch-1 golden
   *  transcripts, so it cannot be swapped on the wire. On a channel's first
   *  join the Room is therefore built before any config arrived. Every
   *  microphone publish happens later, past the LiveKit connect round-trip, so
   *  re-reading here picks up the bitrate the Room missed; publishDefaults
   *  stays the fallback for every other track. */
  protected configuredAudioOptions(
    channelId: number | null,
  ): { audioPreset: { maxBitrate: number } } | undefined {
    if (channelId === null) return undefined;
    const bitrate = voiceStore.getState().voiceConfigs.get(channelId)?.bitrate;
    return bitrate === undefined ? undefined : { audioPreset: { maxBitrate: bitrate } };
  }

  /** Latest token from state, or null when idle/connecting. */
  protected get _latestToken(): string | null {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.latestToken
      : null;
  }

  /** Last URL from state, or null when idle/connecting. */
  protected get _lastUrl(): string | null {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.lastUrl
      : null;
  }

  /** Last direct URL from state. */
  protected get _lastDirectUrl(): string | undefined {
    return this._state.type === "connected" || this._state.type === "reconnecting"
      ? this._state.lastDirectUrl
      : undefined;
  }

  /** True while a connect attempt is running. */
  protected get _connecting(): boolean {
    return this._state.type === "connecting";
  }

  /** The abort controller for an in-flight reconnect, or null. */
  protected get _reconnectAc(): AbortController | null {
    return this._state.type === "reconnecting" ? this._state.ac : null;
  }

  /** True while the auto-reconnect loop owns the session. */
  isAutoReconnecting(): boolean {
    return this._state.type === "reconnecting";
  }

  getRoom(): VoiceRoom | null {
    return this._room;
  }

  /** True while a join/connect attempt is in flight OR a room is live (any
   *  state but "idle"). Unlike `getRoom() !== null`, this also
   *  covers "connecting" (no Room object exists yet) and "reconnecting" (the
   *  `_room` getter reads null there too): a caller that only
   *  wants to know "should we tear anything down" must not miss those. Also
   *  true, in "idle", for a call the reconnect loop handed to a join still
   *  waiting for its answer: nothing is left here, but the server may still
   *  hold it. */
  hasActiveSession(): boolean {
    return this._state.type !== "idle" || this._yieldedToJoin;
  }
}
