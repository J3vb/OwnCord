/**
 * The people in a voice channel as the phone call bar and the join sheet draw
 * them: the roster from the voice store with each name and picture resolved
 * through the member list, the way the sidebar's voice rows resolve them.
 */

import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { createAvatarElement, pickAvatarColor } from "@components/message-list/avatar";
import { shellText } from "../i18n/shell";

export interface CallParticipant {
  readonly userId: number;
  readonly name: string;
  readonly username: string;
  readonly avatar: string | null;
  readonly camera: boolean;
  readonly screenshare: boolean;
  /** Deafen wins over mute, as in the sidebar's rows. */
  readonly audio: "mic-off" | "headphones-off" | null;
}

function audioOf(user: VoiceUser): CallParticipant["audio"] {
  if (user.deafened) return "headphones-off";
  return user.muted ? "mic-off" : null;
}

/** Everyone now in `channelId`, in the store's order. */
export function callParticipants(channelId: number): CallParticipant[] {
  const users = voiceStore.getState().voiceUsers.get(channelId);
  if (users === undefined) return [];
  const members = membersStore.getState().members;
  return Array.from(users.values(), (user) => {
    const member = members.get(user.userId);
    const name = (member !== undefined ? memberDisplayName(member) : "") || user.username;
    return {
      userId: user.userId,
      name: name || shellText("common.unknown"),
      username: user.username,
      avatar: member?.avatar ?? null,
      camera: user.camera,
      screenshare: user.screenshare,
      audio: audioOf(user),
    };
  });
}

/** What an avatar shows for a person, as one comparable key. */
export function participantKey(p: CallParticipant): string {
  return `${p.userId}|${p.name}|${p.avatar ?? ""}`;
}

/** The person's avatar. The name sits beside it, so it is decorative. */
export function participantAvatar(p: CallParticipant, className: string): HTMLElement {
  return createAvatarElement(
    { username: p.username, displayName: p.name, avatar: p.avatar },
    { className, background: pickAvatarColor(p.username), decorative: true },
  );
}
