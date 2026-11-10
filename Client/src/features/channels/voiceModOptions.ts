/**
 * What a participant row's volume menu offers a moderator: the verdict gates
 * and the section `buildVoiceModOptions` hands the menu. Read when the menu
 * opens, so a role or override change since the last render counts.
 */

import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import type { VoiceUser } from "@stores/voice.store";
import { currentUserRoleHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import { voiceText } from "../../i18n/voice";
import type { VoiceModMenuOptions } from "./sidebar/volumeMenu";
import type { VoiceModerationCallbacks } from "./channelSidebarTypes";

/** Whether the signed-in user's role holds MUTE_MEMBERS. Channel overrides can
 *  take that away or keep it, so the voice menu follows each channel's
 *  server-computed can_moderate_voice instead; this role-level answer only
 *  decides whether a channel with no verdict says why moderation is missing.
 *  Derived through the same helper as the member-list moderation gates. */
export function canModerateVoice(): boolean {
  return currentUserRoleHasPermission(Permission.MUTE_MEMBERS);
}

/** Whether the signed-in user's role holds MOVE_MEMBERS; like
 *  canModerateVoice, only used to explain a channel with no verdict. */
function canMoveVoiceByRole(): boolean {
  return currentUserRoleHasPermission(Permission.MOVE_MEMBERS);
}

/** No usable verdict: explain, to roles that could hold one, when the server
 *  gave none at all. */
function noVerdictReason(
  verdict: boolean | undefined,
  moveVerdict: boolean | undefined,
): string | undefined {
  if (verdict !== undefined || moveVerdict !== undefined) return undefined;
  return canModerateVoice() || canMoveVoiceByRole() ? voiceText("volume.modUnknown") : undefined;
}

/** The other voice channels, as Move to's targets. */
function moveTargetsFor(channelId: number): { id: number; name: string }[] {
  return Array.from(channelsStore.getState().channels.values())
    .filter((ch) => ch.type === "voice" && ch.id !== channelId)
    .map((ch) => ({ id: ch.id, name: ch.name }));
}

/** Greyed with a reason rather than hidden while the socket is down: the
 *  actions are server commands, and a click would be dropped silently. */
function disabledReasonNow(): string | undefined {
  const connectionStatus = uiStore.getState().connectionStatus;
  return connectionStatus === "connected"
    ? undefined
    : voiceText(
        connectionStatus === "reconnecting" ? "volume.modReconnecting" : "volume.modNotConnected",
      );
}

/** Moderation section for one participant row, from the channel's
 *  server-computed can_moderate_voice: undefined when it is false
 *  (which hides the section entirely), and the reason it is unavailable when
 *  the server gave no verdict to a role that holds MUTE_MEMBERS or
 *  MOVE_MEMBERS. A channel whose can_moderate_voice is false but whose
 *  can_move_voice is true (a Move Members-only role) gets a section
 *  with only Move to: mute, deafen and disconnect are left out. Move to needs
 *  can_move_voice: can_moderate_voice alone gets no move targets. Read when the
 *  menu opens, so a role or override change since the last render counts. Move
 *  targets are the other voice channels; the server re-checks timeouts and
 *  that the TARGET may connect to the one picked. */
export function buildVoiceModOptions(
  channelId: number,
  user: VoiceUser,
  cb?: VoiceModerationCallbacks,
): VoiceModMenuOptions | string | undefined {
  if (cb === undefined) return undefined;
  const channel = channelsStore.getState().channels.get(channelId);
  const verdict = channel?.canModerateVoice;
  const moveVerdict = channel?.canMoveVoice;
  const full = verdict === true;
  if (!full && moveVerdict !== true) return noVerdictReason(verdict, moveVerdict);
  // Only MOVE_MEMBERS opens a move: a mute-only verdict gets no "Move to".
  const moveTargets = moveVerdict === true ? moveTargetsFor(channelId) : [];
  const disabledReason = disabledReasonNow();
  if (!full) {
    return {
      ...(disabledReason !== undefined ? { disabledReason } : {}),
      moveTargets,
      onMove: (toChannelId) => cb.onMove(user.userId, toChannelId),
    };
  }
  return {
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    serverMuted: user.serverMuted === true,
    serverDeafened: user.serverDeafened === true,
    moveTargets,
    onServerMute: (muted) => cb.onServerMute(channelId, user.userId, muted),
    onServerDeafen: (deafened) => cb.onServerDeafen(channelId, user.userId, deafened),
    onMove: (toChannelId) => cb.onMove(user.userId, toChannelId),
    onDisconnect: () => cb.onDisconnect(user.userId),
  };
}
