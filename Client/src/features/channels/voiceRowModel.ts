/**
 * Pure builders for the voice row models: a state snapshot in, the
 * drawn values out. No builder reads a store; the sidebar's one `select`
 * hands them a `VoiceRowInputs` snapshot, and
 * `tests/unit/voice-row-model.test.ts` runs them under the store-read guard.
 *
 * Rule kept from the renderer these replace: an unverified peer is never
 * shown as verified. `verify` comes only from the snapshot's
 * `peerVerifications` entry for that user, through `verifyPresentation`; with
 * no entry it is null, never a default.
 */

import type { Channel } from "../../stores/channels.store";
import type { Member } from "../../stores/members.store";
import { memberDisplayName } from "../../stores/members.store";
import type { UiState } from "../../stores/ui.store";
import type { PeerVerification, VoiceState, VoiceUser } from "../../stores/voice.store";
import type { SafetyState } from "../safety/store";
import { resolveDisplayName } from "../../lib/ui/avatar";
import { shellText } from "../../i18n/shell";
import { formatUntil, safetyText } from "../../i18n/safety";
import { ownIdentityTitle, verifyPresentation } from "../voice/peerVerification";
import type {
  VoiceAudioModel,
  VoiceChannelChromeModel,
  VoiceUserRowModel,
  VoiceVerifyModel,
} from "./voiceRow.view";

/** Everything the voice rows draw from, as one snapshot of several stores. */
export interface VoiceRowInputs {
  readonly voiceUsers: VoiceState["voiceUsers"];
  readonly currentChannelId: number | null;
  readonly peerVerifications: ReadonlyMap<number, PeerVerification>;
  readonly localSessionFingerprint: string | null;
  readonly localSafetyNumber: string | null;
  /** The members now in voice, by user id. */
  readonly voiceMembers: ReadonlyMap<number, Member>;
  /** The signed-in user's id, or null when signed out. */
  readonly selfId: number | null;
  readonly connectionStatus: UiState["connectionStatus"];
  readonly timeout: SafetyState["timeout"];
  /** Sorted ids of the voice channels whose `canMoveVoice` is true: the rows a drag may move from. */
  readonly movable: readonly number[];
  /** A fresh token per local-mute event: `localSilenced` answers differ after it. */
  readonly localMute: object;
}

/** What a participant row needs beyond the snapshot, injected by the sidebar. */
export interface VoiceUserContext {
  /** The letter avatar's colour for a username (`pickAvatarColor`). */
  readonly avatarColor: (username: string) => string;
  /** Muted for this client only: the local Mute, or a volume of 0. */
  readonly localSilenced: (userId: number) => boolean;
  /** The page wired voice moderation (drag to move needs it). */
  readonly moderation: boolean;
}

/** The participants of one channel in the snapshot, in the store's order. */
export function channelVoiceUsers(inputs: VoiceRowInputs, channelId: number): readonly VoiceUser[] {
  const users = inputs.voiceUsers.get(channelId);
  return users === undefined ? [] : Array.from(users.values());
}

/** The one mute/deafen icon. Deafen implies mute, so a deafened user shows
 *  only headphones-off, and that icon still carries a moderator's mute. A
 *  missing serverMuted/serverDeafened (an older server) counts as false. */
function audioModel(user: VoiceUser): VoiceAudioModel | null {
  const serverMuted = user.serverMuted === true;
  const serverDeafened = user.serverDeafened === true;
  if (user.deafened) {
    let title = shellText("channel.deafened");
    if (serverDeafened) title = shellText("channel.deafenedByModerator");
    else if (serverMuted) title = shellText("channel.mutedByModerator");
    return { icon: "headphones-off", server: serverDeafened || serverMuted, title };
  }
  if (user.muted) {
    return {
      icon: "mic-off",
      server: serverMuted,
      title: serverMuted ? shellText("channel.mutedByModerator") : null,
    };
  }
  return null;
}

/** The badge for this user's entry in the snapshot, or null without one. */
function verifyModel(v: PeerVerification | undefined): VoiceVerifyModel | null {
  if (v === undefined) return null;
  const { icon, color, title } = verifyPresentation(v);
  return { cls: v.status, icon, color, title };
}

/** One participant row's model, from the snapshot. */
export function voiceUserModel(
  user: VoiceUser,
  channelId: number,
  inputs: VoiceRowInputs,
  ctx: VoiceUserContext,
): VoiceUserRowModel {
  const self = inputs.selfId !== null && inputs.selfId === user.userId;
  // The identity a rename shows everywhere else: the nickname, else the
  // username. Security-sensitive surfaces (the mismatch modal, the moderation
  // menu) keep the username and read it at event time.
  const member = inputs.voiceMembers.get(user.userId);
  const resolved = member !== undefined ? memberDisplayName(member) : user.username;
  return {
    userId: user.userId,
    name: resolved || shellText("common.unknown"),
    avatarName: resolveDisplayName({ username: user.username, displayName: resolved }),
    avatarColor: ctx.avatarColor(user.username),
    avatarUrl: member?.avatar ?? null,
    speaking: user.speaking,
    camera: user.camera,
    live: user.screenshare,
    audio: audioModel(user),
    localMuted: !self && ctx.localSilenced(user.userId),
    ownFingerprintTitle: self
      ? ownIdentityTitle(inputs.localSafetyNumber, inputs.localSessionFingerprint)
      : null,
    verify: verifyModel(inputs.peerVerifications.get(user.userId)),
    draggable:
      ctx.moderation &&
      !self &&
      inputs.connectionStatus === "connected" &&
      inputs.movable.includes(channelId),
    self,
  };
}

/** A voice channel's own row model, from the snapshot. */
export function voiceChannelChrome(
  channel: Channel,
  inputs: VoiceRowInputs,
): VoiceChannelChromeModel {
  const joined = inputs.currentChannelId === channel.id;
  // A timeout refuses a join (TIMED_OUT) but never a leave.
  const timeoutReason =
    joined || inputs.timeout === null
      ? null
      : safetyText("timeout.voice", { time: formatUntil(inputs.timeout.expiresAt) });
  // Frozen while the socket is not live, else while timed out.
  let frozenReason = timeoutReason;
  if (inputs.connectionStatus !== "connected") {
    frozenReason = shellText(
      inputs.connectionStatus === "reconnecting" ? "channel.reconnecting" : "channel.notConnected",
    );
  }
  // A readout only: the server owns capacity and refuses a join over it.
  const connected = inputs.voiceUsers.get(channel.id)?.size ?? 0;
  const max = channel.voiceMaxUsers;
  return {
    channelId: channel.id,
    name: channel.name,
    nsfw: channel.nsfw,
    private: channel.isPrivate,
    passwordProtected: channel.passwordProtected === true,
    afk: channel.afk === true,
    joined,
    frozenReason,
    timeoutReason,
    capacity:
      max > 0
        ? {
            label: `${connected}/${max}`,
            title: shellText("channel.voiceCapacity", { connected, max }),
          }
        : null,
    mentionCount: channel.mentionCount,
  };
}
