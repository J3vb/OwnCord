/** The DM call panel's view model (which call state to draw) and the small helpers its renderers share. */

import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { AvatarSubject } from "@lib/ui/avatar";
import type { RingState, OutgoingCallState } from "@lib/voice/callRing";
import { voiceStore } from "@stores/voice.store";
import type { VoiceState, VoiceUser } from "@stores/voice.store";
import { dmDisplayName } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { dmCallText as d } from "../i18n/dmCall";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type DmCallView =
  | { readonly kind: "none" }
  | { readonly kind: "incoming"; readonly dm: DmChannel; readonly ring: RingState }
  | {
      readonly kind: "live";
      readonly dm: DmChannel;
      /** Everyone in the DM's room (you are not). */
      readonly inRoom: readonly number[];
      /** The voice channel you would leave by joining, or null. */
      readonly otherChannelId: number | null;
    }
  | { readonly kind: "outgoing"; readonly dm: DmChannel; readonly pending: readonly number[] }
  | {
      readonly kind: "unanswered";
      readonly dm: DmChannel;
      readonly reason: "declined" | "no-answer" | "offline";
    }
  | {
      readonly kind: "connected";
      readonly dm: DmChannel;
      readonly inRoom: readonly number[];
      /** Someone was in the call and you are now alone in it. */
      readonly peerLeft: boolean;
      /** Ring again is offered: you are alone after a peer left, or a group
       *  has a member who is not in the call. */
      readonly canRingAgain: boolean;
    };

export interface DmCallViewInput {
  readonly activeChannelId: number | null;
  readonly dms: readonly DmChannel[];
  readonly voice: Pick<VoiceState, "currentChannelId" | "voiceUsers">;
  readonly selfId: number;
  readonly incoming: RingState | null;
  readonly outgoing: OutgoingCallState | null;
  /** Someone else has been in this call's room since you joined. */
  readonly peerWasHere?: boolean;
}

/** The members of a group DM who are not in the call (everyone but you is in
 *  `dm.participants`), in the DM's order. A 1:1 has no roster to grey out. */
export function absentMembers(dm: DmChannel, present: readonly number[]): number[] {
  if (!dm.isGroup) return [];
  return dm.participants.map((p) => p.id).filter((id) => !present.includes(id));
}

/** Which panel, if any, the open channel shows. Pure: the whole decision. */
export function deriveCallView(input: DmCallViewInput): DmCallView {
  const { activeChannelId, voice, selfId } = input;
  if (activeChannelId === null) return { kind: "none" };
  const dm = input.dms.find((c) => c.channelId === activeChannelId);
  if (dm === undefined) return { kind: "none" };

  const inCall = voice.currentChannelId === dm.channelId;
  const roster = voice.voiceUsers.get(dm.channelId);
  const others = roster === undefined ? [] : [...roster.keys()].filter((id) => id !== selfId);

  if (!inCall && input.incoming !== null && input.incoming.channelId === dm.channelId) {
    return { kind: "incoming", dm, ring: input.incoming };
  }
  if (inCall) {
    const out = input.outgoing;
    // Anyone else in the room means the call is up, whatever the ring said.
    if (others.length === 0 && out !== null && out.channelId === dm.channelId) {
      if (out.phase === "ringing") return { kind: "outgoing", dm, pending: out.pending };
      return { kind: "unanswered", dm, reason: out.phase };
    }
    const inRoom = [selfId, ...others];
    const peerLeft = !dm.isGroup && others.length === 0 && input.peerWasHere === true;
    return {
      kind: "connected",
      dm,
      inRoom,
      peerLeft,
      canRingAgain: peerLeft || absentMembers(dm, inRoom).length > 0,
    };
  }
  if (others.length > 0) {
    return { kind: "live", dm, inRoom: others, otherChannelId: voice.currentChannelId };
  }
  return { kind: "none" };
}

interface Person {
  readonly name: string;
  readonly subject: AvatarSubject;
}

export interface AvatarRef {
  readonly wrap: HTMLElement;
  readonly badge: HTMLElement;
  /** The peer's identity shield, drawn once their announce resolves;
   *  on your own avatar, the shield that shows your own safety number. */
  verify: HTMLElement | null;
  verifyKey: string;
}

export interface ControlRefs {
  mute: HTMLButtonElement | null;
  deafen: HTMLButtonElement | null;
  camera: HTMLButtonElement | null;
  share: HTMLButtonElement | null;
}

/** Resolve a user the way every other identity surface does: the members
 *  store first, then the DM's own participant copy, then the voice roster. */
export function resolvePerson(
  userId: number,
  dm: DmChannel,
  voice: VoiceState,
  selfId: number,
): Person {
  if (userId === selfId) {
    const me = authStore.getState().user;
    return {
      name: d("you"),
      subject: {
        username: me?.username ?? "",
        displayName: me?.display_name ?? null,
        avatar: me?.avatar ?? null,
      },
    };
  }
  const member = membersStore.getState().members.get(userId);
  if (member !== undefined) {
    return {
      name: memberDisplayName(member),
      subject: {
        username: member.username,
        displayName: member.displayName,
        avatar: member.avatar,
      },
    };
  }
  const p = dm.participants.find((x) => x.id === userId);
  if (p !== undefined) {
    return {
      name: (p.displayName ?? "") || p.username,
      subject: { username: p.username, displayName: p.displayName ?? null, avatar: p.avatar },
    };
  }
  const username = voice.voiceUsers.get(dm.channelId)?.get(userId)?.username ?? "";
  return { name: username, subject: { username } };
}

/** What a call is called: the other person in a 1:1 (resolved like the
 *  stage labels and the ring banner), the DM's own name for a group. */
export function callName(dm: DmChannel, selfId: number): string {
  if (dm.isGroup) return dmDisplayName(dm);
  return (
    resolvePerson(dm.recipient.id, dm, voiceStore.getState(), selfId).name || dmDisplayName(dm)
  );
}

export function voiceUser(
  voice: VoiceState,
  channelId: number,
  userId: number,
): VoiceUser | undefined {
  return voice.voiceUsers.get(channelId)?.get(userId);
}

export function swapIcon(btn: HTMLElement, name: IconName, size: number): void {
  const current = btn.querySelector("svg");
  if (current?.getAttribute("data-icon") === name) return;
  current?.remove();
  btn.insertBefore(createIcon(name, size), btn.firstChild);
}

export function currentUserId(): number {
  return authStore.getState().user?.id ?? 0;
}

export function caption(main: string, sub: string): HTMLElement[] {
  return [
    createElement("div", { class: "dcp-caption", "data-testid": "dcp-caption" }, main),
    createElement("div", { class: "dcp-sub" }, sub),
  ];
}
