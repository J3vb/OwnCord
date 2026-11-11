/**
 * The voice state shape: the roster, local control and session types the
 * voice store holds, and the fresh state it starts from. voice.store.ts is the
 * facade that holds the state and re-exports the types.
 */

export interface VoiceUser {
  readonly userId: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
  /** Moderator-imposed (MUTE_MEMBERS). muted/deafened are always set alongside
   *  these, so they only change how the row is presented. The store always sets
   *  them; optional only so the inline VoiceUser test fixtures need not restate
   *  them (same convention as VoiceState.peerVerifications). */
  readonly serverMuted?: boolean;
  readonly serverDeafened?: boolean;
}

/** Observable voice-session lifecycle status, surfaced so the UI can
 *  distinguish "connecting to the room" (joining) from "securing E2EE"
 *  (securing) from a live, encrypted call (connected). Written from
 *  livekitSession.ts. See docs/architecture/ux/voice-and-e2ee.md §1–2. */
export type VoiceStatus = "idle" | "joining" | "securing" | "connected" | "reconnecting";

export interface VoiceConfig {
  readonly quality: string;
  readonly bitrate: number;
  readonly threshold_mode: string;
  readonly mixing_threshold: number;
  readonly top_speakers: number;
  readonly max_users: number;
}

/** Per-peer E2EE identity verification result, surfaced so the voice
 *  panel can show a verified/unverified badge and the out-of-band safety number.
 *  Written from livekitSession.ts as each peer's announce is verified.
 *   - "verified":   announce signature checked against the peer's pinned key.
 *   - "changed":    as "verified", but the peer's key differed from the pin
 *                   earlier this session and was accepted (and re-pinned)
 *                   automatically; kept for the rest of the session.
 *   - "unverified": peer published no identity key (legacy) — pin-pending.
 *   - "mismatch":   a pinned peer's identity key is no longer delivered, or
 *                   the announce signature did not verify; the peer is blocked.
 *   - "unknown":    the local pin store could not be read (keyring error), so
 *                   no trust decision was possible — the announce was rejected
 *                   (fail closed). Distinct from "unverified" so a
 *                   storage fault never reads as "never pinned". */
export interface PeerVerification {
  readonly userId: number;
  readonly status: "verified" | "changed" | "unverified" | "mismatch" | "unknown";
  /** Safety number (identity-key fingerprint) for out-of-band verification;
   *  null for legacy/unverified/mismatch/unknown peers. */
  readonly safetyNumber: string | null;
  /** Fingerprint of the peer's ephemeral session key. Set whenever
   *  the announce was accepted (verified or unverified), null when it was
   *  rejected. Changes every call, so it is NOT an identity — it is the only
   *  thing an unverified peer has that can be compared out of band. */
  readonly sessionFingerprint: string | null;
}

export interface VoiceState {
  readonly currentChannelId: number | null;
  readonly voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>; // channelId -> userId -> VoiceUser
  readonly voiceConfigs: ReadonlyMap<number, VoiceConfig>; // channelId -> VoiceConfig
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
  /** Set from the local user's own voice_state: while true the widget refuses
   *  to send an unmute, which the server would reject anyway. Always written by
   *  the store; optional for the same fixture reason as peerVerifications. */
  readonly localServerMuted?: boolean;
  readonly localServerDeafened?: boolean;
  /** True while the current channel is the server's AFK channel, which is
   *  listen-only: the mic is not published and its control is locked muted.
   *  Derived from the channel store (see syncInAfkChannel); optional for the
   *  fixture reason above. */
  readonly inAfkChannel?: boolean;
  /** The local deafen in effect is the one a moderator's deafen applied, not
   *  the member's own: the moderator's lift releases it, while a deafen the
   *  member chose survives the lift. Follows localDeafened, so it outlives a
   *  leave (a moderator move) and clears on any undeafen. */
  readonly moderatorDeafened?: boolean;
  /** The member was already muted when they deafened, so undeafening restores
   *  that mute instead of lifting it. Written by the widget's deafen toggle and
   *  cleared by the widget's undeafen. Like localDeafened it outlives a leave, so a
   *  re-join restates the same pair. Optional for the fixture reason above. */
  readonly mutedBeforeDeafen?: boolean;
  /** True while push-to-talk is bound and the key is NOT currently held —
   *  i.e. the mic processor's push-to-talk gate is closed. Deliberately a
   *  separate flag from localMuted: PTT never writes the flag that represents
   *  the user's own explicit mute (livekitSession.setPttGated only closes and
   *  opens the gate), so a press can't undo a self-mute and a release can't
   *  corrupt the mute toggle's state. Always written by the store; optional
   *  only for the same fixture reason as localServerMuted. */
  readonly pttGated?: boolean;
  readonly localCamera: boolean;
  readonly localScreenshare: boolean;
  /** Bumped when the live camera's capture is replaced without the camera
   *  going off (a device switch): the self tile redraws on the new track. */
  readonly localCameraRev?: number;
  /** Bumped when the live share changes source or quality without stopping:
   *  its preview and the stream card redraw. */
  readonly localShareRev?: number;
  /** The SFU grant leaves out screen share (no Share Screen permission here).
   *  Absent reads as allowed. Written from the voice session. */
  readonly shareDenied?: boolean;
  /** Epoch ms when the local user joined the current voice channel (for elapsed timer). */
  readonly joinedAt: number | null;
  /** The channel a switch out of a live call asked for, while the server has
   *  not acted on it yet. The server keeps the old call until the switch passes
   *  its checks (password, capacity), so currentChannelId keeps naming that
   *  call: the first sign the switch went ahead (the old call's voice_leave or
   *  the new voice_token) moves it, and a refusal just clears this. Null at any
   *  other time. Optional for the fixture reason above. */
  readonly switchingTo?: number | null;
  /** True when joined in listen-only mode (mic permission denied or no mic found). */
  readonly listenOnly: boolean;
  /** Voice-session lifecycle status (drives the widget's connecting/securing/
   *  secured indicators). Written from livekitSession.ts. */
  readonly voiceStatus: VoiceStatus;
  /** True once livekit-client reports a live E2EE encryption failure
   *  (RoomEvent.EncryptionError — the per-room worker died after the room key
   *  exchange already succeeded, e.g. a lazily-loaded worker chunk blocked by
   *  CSP or a WASM load failure). voiceStatus alone reaches "connected" in
   *  that case, so the Secured badge must also read this flag rather than
   *  deriving "secured" from voiceStatus === "connected" in isolation.
   *  Written from roomEventHandlers.ts; latches until the next join/leave.
   *  Always written by the store; optional only so the many inline VoiceState
   *  test fixtures need not restate it (same convention as localServerMuted). */
  readonly encryptionDegraded?: boolean;
  /** Per-peer E2EE identity verification, keyed by userId. The store
   *  always sets it; optional only so the many inline VoiceState test fixtures
   *  need not restate it. */
  readonly peerVerifications?: ReadonlyMap<number, PeerVerification>;
  /** Video codecs each peer reported decoding in its `voice_e2ee_announce`,
   *  keyed by userId; no entry means the baseline (VP8, H.264). Written only
   *  from the dispatcher's announce handler, and deliberately not cleared with
   *  peerVerifications (that runs at key setup, after a list may have arrived).
   *  Reset at session end. Optional for the same fixture reason. */
  readonly peerVideoDecode?: ReadonlyMap<number, readonly string[]>;
  /** Peers whose last `voice_e2ee_announce` said `key_slots`: they stage a new
   *  room key in its own slot and switch to it a moment later. The key holder
   *  rotates that way only when every peer is in here. Same writer and
   *  lifetime as peerVideoDecode. */
  readonly peerKeySlots?: ReadonlySet<number>;
  /** Peers whose last `voice_e2ee_announce` said `bound_offers`: the key
   *  holder sends them offers that bind sender and recipient. Same writer and
   *  lifetime as peerKeySlots. */
  readonly peerBoundOffers?: ReadonlySet<number>;
  /** Whose screen share each member of the current channel watches, from
   *  their `voice_watching` frames (sorted user ids). Written only from the
   *  dispatcher's handler; removeVoiceUser drops a member, leaveVoiceChannel
   *  and resetVoiceStore clear it. Your own watching is read from the local
   *  RemoteTracks set, not from here. Optional for the fixture reason above. */
  readonly peerWatching?: ReadonlyMap<number, readonly number[]>;
  /** Fingerprint of the local user's own ephemeral session key, so
   *  it can be read out to a peer who sees us as unverified. Null outside a
   *  voice session. Optional for the same fixture reason as peerVerifications. */
  readonly localSessionFingerprint?: string | null;
  /** The local user's own safety number (identity-key fingerprint), the
   *  number peers see on our shield, so it can be compared out of band. Null
   *  outside a voice session or when our announce went out unsigned. Optional
   *  for the same fixture reason as peerVerifications. */
  readonly localSafetyNumber?: string | null;
  /** The input-sensitivity gate's verdict (true = open = above the slider's
   *  threshold), or null when no gate runs (sensitivity 100).
   *  When set it, not LiveKit, drives the local speaking ring, so the ring,
   *  the slider and what transmits agree. Optional for the fixture reason above. */
  readonly localGateSpeaking?: boolean | null;
}

/** A fresh state with its own empty collections, for the store's first state
 *  and for every reset. */
export function createVoiceState(): VoiceState {
  return {
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localServerMuted: false,
    localServerDeafened: false,
    moderatorDeafened: false,
    mutedBeforeDeafen: false,
    pttGated: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    switchingTo: null,
    listenOnly: false,
    voiceStatus: "idle",
    encryptionDegraded: false,
    peerVerifications: new Map(),
    peerVideoDecode: new Map(),
    peerKeySlots: new Set(),
    peerBoundOffers: new Set(),
    peerWatching: new Map(),
    localGateSpeaking: null,
  };
}
