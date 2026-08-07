/**
 * Voice store — holds voice channel state, local audio controls, and per-user voice info.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
} from "@lib/types";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";

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

/** Per-peer E2EE identity verification result (F3 TOFU), surfaced so the voice
 *  panel can show a verified/unverified badge and the out-of-band safety number.
 *  Written from livekitSession.ts as each peer's announce is verified.
 *   - "verified":   announce signature checked against the peer's pinned key.
 *   - "unverified": peer published no identity key (legacy) — pin-pending.
 *   - "mismatch":   the delivered identity key differs from the pinned one
 *                   (possible server MITM); the peer is blocked until re-pin.
 *   - "unknown":    the local pin store could not be read (keyring error), so
 *                   no trust decision was possible — the announce was rejected
 *                   (fail closed, DC-08). Distinct from "unverified" so a
 *                   storage fault never reads as "never pinned". */
export interface PeerVerification {
  readonly userId: number;
  readonly status: "verified" | "unverified" | "mismatch" | "unknown";
  /** Safety number (identity-key fingerprint) for out-of-band verification;
   *  null for legacy/unverified/mismatch/unknown peers. */
  readonly safetyNumber: string | null;
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
  /** True while push-to-talk is bound and the key is NOT currently held —
   *  i.e. the mic should be gated (silenced) for PTT reasons. This is
   *  deliberately a separate flag from localMuted: PTT must never write the
   *  flag that represents the user's own explicit mute (see ptt.ts and
   *  livekitSession.setMuted), so a hot-mic press can't undo a self-mute and
   *  a PTT release can't corrupt the mute toggle's state. Always written by
   *  the store; optional only for the same fixture reason as localServerMuted. */
  readonly pttGated?: boolean;
  readonly localCamera: boolean;
  readonly localScreenshare: boolean;
  /** Epoch ms when the local user joined the current voice channel (for elapsed timer). */
  readonly joinedAt: number | null;
  /** True when joined in listen-only mode (mic permission denied or no mic found). */
  readonly listenOnly: boolean;
  /** Voice-session lifecycle status (drives the widget's connecting/securing/
   *  secured indicators). Written from livekitSession.ts. */
  readonly voiceStatus: VoiceStatus;
  /** Per-peer E2EE identity verification (F3 TOFU), keyed by userId. The store
   *  always sets it; optional only so the many inline VoiceState test fixtures
   *  need not restate it. */
  readonly peerVerifications?: ReadonlyMap<number, PeerVerification>;
}

const INITIAL_STATE: VoiceState = {
  currentChannelId: null,
  voiceUsers: new Map(),
  voiceConfigs: new Map(),
  localMuted: false,
  localDeafened: false,
  localServerMuted: false,
  localServerDeafened: false,
  pttGated: false,
  localCamera: false,
  localScreenshare: false,
  joinedAt: null,
  listenOnly: false,
  voiceStatus: "idle",
  peerVerifications: new Map(),
};

export const voiceStore = createStore<VoiceState>(INITIAL_STATE);

/** Reset voice store to initial state (e.g. on logout). */
export function resetVoiceStore(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localServerMuted: false,
    localServerDeafened: false,
    pttGated: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "idle",
    peerVerifications: new Map(),
  }));
}

/** Bulk set voice states from the ready payload. */
export function setVoiceStates(states: readonly ReadyVoiceState[]): void {
  const channelMap = new Map<number, Map<number, VoiceUser>>();

  for (const vs of states) {
    let userMap = channelMap.get(vs.channel_id);
    if (!userMap) {
      userMap = new Map();
      channelMap.set(vs.channel_id, userMap);
    }
    const member = membersStore.getState().members.get(vs.user_id);
    userMap.set(vs.user_id, {
      userId: vs.user_id,
      username: member?.username ?? "",
      muted: vs.muted,
      deafened: vs.deafened,
      speaking: false,
      // The ready payload carries the authoritative DB flags; blanking them
      // on a mid-call resync would hide a peer's live camera/screenshare
      // until they toggled it. Absent (older server) still defaults false.
      camera: vs.camera ?? false,
      screenshare: vs.screenshare ?? false,
      serverMuted: vs.server_muted ?? false,
      serverDeafened: vs.server_deafened ?? false,
    });
  }

  // Check if current user is in any voice channel, and capture their own
  // row so the moderator-imposed flags below can be derived from it — a
  // full-ready reconnect (mustFullResync / replay-buffer miss) that
  // preserves a live voice session must not leave localServerMuted/
  // localServerDeafened stuck at their pre-reconnect values (v049).
  const currentUserId = authStore.getState().user?.id ?? 0;
  let autoJoinChannel: number | null = null;
  let selfState: ReadyVoiceState | undefined;
  if (currentUserId !== 0) {
    for (const vs of states) {
      if (vs.user_id === currentUserId) {
        autoJoinChannel = vs.channel_id;
        selfState = vs;
        break;
      }
    }
  }

  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: channelMap,
    // If user is in a voice channel per ready payload, use that channel.
    // Otherwise preserve prev — user may be mid-join and server hasn't
    // registered them yet. Stale IDs are cleared by leaveVoiceChannel()
    // or resetVoiceStore() on logout.
    currentChannelId: autoJoinChannel ?? prev.currentChannelId,
    localServerMuted: selfState?.server_muted ?? false,
    localServerDeafened: selfState?.server_deafened ?? false,
  }));
}

/** Update or add a user's voice state from a voice_state event. When the event
 *  describes the signed-in user it also mirrors the moderator-imposed flags
 *  into localServerMuted/localServerDeafened, which gate the widget controls. */
export function updateVoiceState(payload: VoiceStatePayload): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  const serverMuted = payload.server_muted ?? false;
  const serverDeafened = payload.server_deafened ?? false;
  voiceStore.setState((prev) => {
    const nextChannels = new Map(prev.voiceUsers);
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    const nextUsers = new Map(existingChannel ?? []);

    nextUsers.set(payload.user_id, {
      userId: payload.user_id,
      username: payload.username,
      muted: payload.muted,
      deafened: payload.deafened,
      speaking: payload.speaking,
      camera: payload.camera,
      screenshare: payload.screenshare,
      serverMuted,
      serverDeafened,
    });

    nextChannels.set(payload.channel_id, nextUsers);
    if (payload.user_id !== currentUserId) {
      return { ...prev, voiceUsers: nextChannels };
    }
    return {
      ...prev,
      voiceUsers: nextChannels,
      localServerMuted: serverMuted,
      localServerDeafened: serverDeafened,
    };
  });
}

/** Remove a user from a voice channel. */
export function removeVoiceUser(payload: VoiceLeavePayload): void {
  voiceStore.setState((prev) => {
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    if (!existingChannel || !existingChannel.has(payload.user_id)) return prev;

    const nextChannels = new Map(prev.voiceUsers);
    const nextUsers = new Map(existingChannel);
    nextUsers.delete(payload.user_id);

    if (nextUsers.size === 0) {
      nextChannels.delete(payload.channel_id);
    } else {
      nextChannels.set(payload.channel_id, nextUsers);
    }

    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Set the current voice channel (local join) and record the join timestamp.
 *  Only resets joinedAt if the user is joining a different channel (or was not in one). */
export function joinVoiceChannel(channelId: number): void {
  voiceStore.setState((prev) => {
    // Already in this channel — don't reset the timer
    if (prev.currentChannelId === channelId) return prev;
    return {
      ...prev,
      currentChannelId: channelId,
      joinedAt: Date.now(),
      // Optimistic: the widget shows "Connecting…" the moment the user clicks,
      // before the voice_token round-trip. livekitSession advances it from here.
      voiceStatus: "joining",
    };
  });
}

/** Clear the current voice channel and remove current user from voice users. */
export function leaveVoiceChannel(): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  voiceStore.setState((prev) => {
    const cleared = {
      currentChannelId: null,
      joinedAt: null,
      voiceStatus: "idle" as const,
      // Server mute lives with the voice session; a new session starts clean.
      localServerMuted: false,
      localServerDeafened: false,
    };
    const channelId = prev.currentChannelId;
    if (channelId === null || currentUserId === 0) {
      return { ...prev, ...cleared };
    }
    const existingChannel = prev.voiceUsers.get(channelId);
    if (!existingChannel || !existingChannel.has(currentUserId)) {
      return { ...prev, ...cleared };
    }
    const nextChannels = new Map(prev.voiceUsers);
    const nextUsers = new Map(existingChannel);
    nextUsers.delete(currentUserId);
    if (nextUsers.size === 0) {
      nextChannels.delete(channelId);
    } else {
      nextChannels.set(channelId, nextUsers);
    }
    return { ...prev, ...cleared, voiceUsers: nextChannels };
  });
}

/** Set the voice-session lifecycle status. Single-writer from livekitSession.ts
 *  at each connection-lifecycle transition. */
export function setVoiceStatus(status: VoiceStatus): void {
  voiceStore.setState((prev) =>
    prev.voiceStatus === status ? prev : { ...prev, voiceStatus: status },
  );
}

/** Toggle local mute state. */
export function setLocalMuted(muted: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localMuted: muted,
  }));
}

/** Toggle local deafen state. */
export function setLocalDeafened(deafened: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localDeafened: deafened,
  }));
}

/** Record whether push-to-talk is currently gating (silencing) the mic —
 *  i.e. the bound key is not held. Written only from ptt.ts. Deliberately
 *  separate from localMuted so PTT can never write the flag that represents
 *  the user's own explicit mute (see the VoiceState.pttGated doc comment). */
export function setPttGated(gated: boolean): void {
  voiceStore.setState((prev) => (prev.pttGated === gated ? prev : { ...prev, pttGated: gated }));
}

/** Whether the Rust-side PTT key poller is actually able to report key state
 *  on this platform. Module-level rather than store state: it is a process-wide
 *  platform capability, not per-session voice state, so `resetVoiceStore()` on
 *  logout must NOT clear it.
 *
 *  It lives here rather than in livekitSession.ts so `ptt.ts` can write it
 *  during startup without importing that module — livekitSession pulls in the
 *  ~1.3 MB livekit-client SDK, which is deliberately kept off the startup path.
 *
 *  Defaults to false so an un-wired or unsupported poller never causes a
 *  join-time mute that nothing can later lift. */
let pttPollingLive = false;

/** Report whether the PTT key-polling backend can actually observe key state.
 *  Callers MUST reflect REAL backend capability (the `ptt_polling_supported`
 *  Tauri command), not merely whether a key is bound in preferences: on macOS
 *  `is_key_down` is a stub returning false and on pure-Wayland Linux
 *  `DeviceState::checked_new()` returns None, so no `ptt-state` event can ever
 *  arrive to lift a join-time mute. */
export function setPttPollingLive(live: boolean): void {
  pttPollingLive = live;
}

/** Whether the PTT poller is live (see `setPttPollingLive`). */
export function isPttPollingLive(): boolean {
  return pttPollingLive;
}

/** Toggle local camera state. */
export function setLocalCamera(enabled: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localCamera: enabled,
  }));
}

/** Toggle local screenshare state. */
export function setLocalScreenshare(enabled: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    localScreenshare: enabled,
  }));
}

/** Set listen-only mode (mic permission denied or no mic found). */
export function setListenOnly(listenOnly: boolean): void {
  voiceStore.setState((prev) => ({
    ...prev,
    listenOnly,
  }));
}

/** Update the current user's speaking state for local VAD feedback. */
export function setLocalSpeaking(speaking: boolean): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  if (currentUserId === 0) return;
  voiceStore.setState((prev) => {
    const channelId = prev.currentChannelId;
    if (channelId === null) return prev;
    const channelUsers = prev.voiceUsers.get(channelId);
    if (!channelUsers) return prev;
    const user = channelUsers.get(currentUserId);
    if (!user || user.speaking === speaking) return prev;
    const nextUsers = new Map(channelUsers);
    nextUsers.set(currentUserId, { ...user, speaking });
    const nextChannels = new Map(prev.voiceUsers);
    nextChannels.set(channelId, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Store voice config for a channel from a voice_config event. */
export function setVoiceConfig(payload: VoiceConfigPayload): void {
  voiceStore.setState((prev) => {
    const nextConfigs = new Map(prev.voiceConfigs);
    nextConfigs.set(payload.channel_id, {
      quality: payload.quality,
      bitrate: payload.bitrate,
      threshold_mode: payload.threshold_mode,
      mixing_threshold: payload.mixing_threshold,
      top_speakers: payload.top_speakers,
      max_users: payload.max_users,
    });
    return { ...prev, voiceConfigs: nextConfigs };
  });
}

/** Update speaking state for users from a voice_speakers event or
 *  LiveKit's ActiveSpeakersChanged. Updates ALL users including local
 *  (LiveKit is now the sole authority for speaking detection). */
export function setSpeakers(payload: VoiceSpeakersPayload): void {
  voiceStore.setState((prev) => {
    const existingChannel = prev.voiceUsers.get(payload.channel_id);
    if (!existingChannel) return prev;

    const speakerSet = new Set(payload.speakers);
    const nextUsers = new Map<number, VoiceUser>();

    for (const [userId, user] of existingChannel) {
      const isSpeaking = speakerSet.has(userId);
      if (user.speaking !== isSpeaking) {
        nextUsers.set(userId, { ...user, speaking: isSpeaking });
      } else {
        nextUsers.set(userId, user);
      }
    }

    const nextChannels = new Map(prev.voiceUsers);
    nextChannels.set(payload.channel_id, nextUsers);
    return { ...prev, voiceUsers: nextChannels };
  });
}

/** Record a peer's E2EE identity verification result (F3 TOFU). Written from
 *  livekitSession.ts as each peer's ephemeral-key announce is verified. */
export function setPeerVerification(v: PeerVerification): void {
  voiceStore.setState((prev) => {
    const next = new Map(prev.peerVerifications);
    next.set(v.userId, v);
    return { ...prev, peerVerifications: next };
  });
}

/** Drop a single peer's verification (e.g. when they leave the channel). */
export function clearPeerVerification(userId: number): void {
  voiceStore.setState((prev) => {
    if (!prev.peerVerifications?.has(userId)) return prev;
    const next = new Map(prev.peerVerifications);
    next.delete(userId);
    return { ...prev, peerVerifications: next };
  });
}

/** Drop all peer verifications (on voice leave). */
export function clearPeerVerifications(): void {
  voiceStore.setState((prev) =>
    (prev.peerVerifications?.size ?? 0) === 0 ? prev : { ...prev, peerVerifications: new Map() },
  );
}

/** Selector: a peer's verification result, or null if not yet resolved. */
export function getPeerVerification(userId: number): PeerVerification | null {
  return voiceStore.select((s) => s.peerVerifications?.get(userId) ?? null);
}

/** Selector: get all voice users in a specific channel. */
export function getChannelVoiceUsers(channelId: number): readonly VoiceUser[] {
  return voiceStore.select((s) => {
    const channelUsers = s.voiceUsers.get(channelId);
    if (!channelUsers) return [];
    return Array.from(channelUsers.values());
  });
}
