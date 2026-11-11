/** Helpers the DM profile panel and sheet share (moved down from the main page's pageShared). */
import { dmStore, type DmChannel } from "@stores/dm.store";
import { membersStore, type Member } from "@stores/members.store";
import type { DmProfileData } from "./DmProfileSidebar";

/** What the DM profile panel repaints from a member's song. */
export function listeningKey(l: DmProfileData["listening"] | undefined): string {
  return l == null ? "" : `${l.title}|${l.artist}|${l.player}|${l.startedAt}|${l.durationMs}`;
}

/** Saved preference: the 1:1 DM profile panel opens with the conversation. */
export const DM_PROFILE_PREF = "dmProfileOpen";

type DmRecipient = DmChannel["recipient"];

/** The live member's status, else the DM list's own copy (a partner who is not
 *  a member of this server); anything unknown reads offline. */
function profileStatus(
  member: Member | undefined,
  recipient: DmRecipient,
): DmProfileData["status"] {
  const rawStatus = member?.status ?? recipient.status;
  return rawStatus === "online" ||
    rawStatus === "idle" ||
    rawStatus === "dnd" ||
    rawStatus === "offline"
    ? rawStatus
    : "offline";
}

/** The live copy first, as for the status; the DM list's own copy covers a
 *  partner who is not a member of this server. */
function profilePresence(
  member: Member | undefined,
  recipient: DmRecipient,
): Pick<DmProfileData, "mobile" | "activity" | "listening"> {
  return {
    mobile: member === undefined ? recipient.mobile === true : member.mobile === true,
    activity: member === undefined ? (recipient.activity ?? null) : (member.activity ?? null),
    listening: member === undefined ? (recipient.listening ?? null) : (member.listening ?? null),
  };
}

/**
 * Build the profile panel's data from the live stores for a 1:1 DM channel.
 * Null for a group (no single "recipient" -- see the caller) or a channel
 * that is no longer a DM. Shared by the initial open and by the live
 * refresh below so the two can never disagree on how a status/name is
 * derived.
 */
export function buildDmProfileUser(channelId: number): DmProfileData | null {
  const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
  // A group has no single "recipient" — dm.store.ts documents .recipient as
  // just the first of .participants for a group, with group-correct code
  // expected to read .participants instead. A 1:1 profile panel built from
  // it would present one arbitrary member's identity as the conversation.
  if (dmChannel === undefined || dmChannel.isGroup) return null;

  const recipient = dmChannel.recipient;
  // Prefer membersStore's status, like the chat header's refreshDmHeader
  // does (ChannelController.ts) -- falling back to dmStore's own copy keeps
  // this correct even for a DM partner who isn't a guild member.
  const member = membersStore.getState().members.get(recipient.id);

  return {
    id: recipient.id,
    username: recipient.username,
    // The DM header this panel opens from renders through dmDisplayName,
    // which prefers the nickname -- drop it here and the panel shows a
    // different identity from the header the reader just clicked.
    displayName: recipient.displayName ?? null,
    avatar: recipient.avatar || null,
    status: profileStatus(member, recipient),
    customStatus: member?.customStatus ?? null,
    ...profilePresence(member, recipient),
    about: null,
    joinDate: null,
    banner: member?.banner ?? null,
    banner_color: member?.banner_color ?? null,
  };
}
