/** Constants and small helpers the main page modules share. */
import { shellText } from "../../i18n/shell";
import { createLogger } from "@lib/logger";
import { authStore } from "@stores/auth.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import type { DmProfileData } from "@components/DmProfileSidebar";

export const log = createLogger("main-page");

/** Long enough to read which sign-in it names (cf. toast.ts PARTIAL_SUCCESS_TOAST_MS). */
export const SESSION_NOTICE_TOAST_MS = 12_000;

/**
 * The call notification and missed-call notice. They are re-exported by the
 * DM call panel, which the page already loads at mount, so the ring's OS alert
 * costs no second dynamic chunk here.
 */
export const callAlerts = () => import("../../features/direct-messages/DmCallPanel");

// ---------------------------------------------------------------------------
// MainPage
// ---------------------------------------------------------------------------

/** The person's name as every identity surface shows it, or undefined. */
export function personName(userId: number): string | undefined {
  const voice = voiceStore.getState();
  const channelId = voice.currentChannelId;
  const channelUsers = channelId !== null ? voice.voiceUsers.get(channelId) : undefined;
  const voiceUser = channelUsers?.get(userId);
  const member = membersStore.getState().members.get(userId);
  return (member !== undefined ? memberDisplayName(member) : "") || voiceUser?.username;
}

/** What the DM profile panel repaints from a member's song. */
export function listeningKey(l: DmProfileData["listening"] | undefined): string {
  return l == null ? "" : `${l.title}|${l.artist}|${l.player}|${l.startedAt}|${l.durationMs}`;
}

/** Saved preference: the 1:1 DM profile panel opens with the conversation. */
export const DM_PROFILE_PREF = "dmProfileOpen";

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
  const rawStatus = member?.status ?? recipient.status;
  const status =
    rawStatus === "online" || rawStatus === "idle" || rawStatus === "dnd" || rawStatus === "offline"
      ? rawStatus
      : ("offline" as const);

  return {
    id: recipient.id,
    username: recipient.username,
    // The DM header this panel opens from renders through dmDisplayName,
    // which prefers the nickname -- drop it here and the panel shows a
    // different identity from the header the reader just clicked.
    displayName: recipient.displayName ?? null,
    avatar: recipient.avatar || null,
    status,
    // The live copy first, as for the status; the DM list's own copy covers a
    // partner who is not a member of this server.
    activity: member === undefined ? (recipient.activity ?? null) : (member.activity ?? null),
    listening: member === undefined ? (recipient.listening ?? null) : (member.listening ?? null),
    about: null,
    joinDate: null,
    banner: member?.banner ?? null,
    banner_color: member?.banner_color ?? null,
  };
}

/**
 * Resolve a channel's display name. A DM is named by who is in it (or, for a
 * group, by its name), and the store is the authority on that — the channels
 * store carries a synthesised copy that can lag a rename or a departure.
 */
export function resolveChannelName(
  channelId: number,
  channelName: string,
  channelType?: string,
): string {
  if (channelType === "dm") {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm !== undefined) return dmDisplayName(dm);
  }
  return channelName;
}

export function getCurrentUserId(): number {
  return authStore.getState().user?.id ?? 0;
}

/**
 * The device's own network fact, apart from the server's reachability: a LAN
 * server with no internet still answers `onLine`. `undefined` where the host
 * does not expose the API, so a notice never claims the internet is required.
 */
export function deviceNetworkOffline(): boolean | undefined {
  return typeof navigator.onLine === "boolean" ? !navigator.onLine : undefined;
}

// The label shown on a video tile: memberDisplayName when known —
// the same identity a rename shows everywhere else (ChannelSidebar's
// voice roster, message rows, the member list) — falling back to the
// voice roster's (possibly frozen) username, then a placeholder. Single
// writer so tile creation (setOnRemoteVideo below) and tile relabeling
// on a mid-call rename (the voiceStore subscriber below) cannot disagree.
//
// Self-aware, because the relabel loop walks the whole voice roster and the
// roster includes you: VideoModeController registers the local tiles as
// "<name> (You)" / "Your Screen", and a bare remote label written over them
// leaves your own tile indistinguishable from a participant's.
// These two branches must keep matching VideoModeController's addStream
// labels — that is what the test pins.
export function tileLabel(userId: number, isScreenshare: boolean): string {
  const name = personName(userId);
  const isSelf = userId === getCurrentUserId();
  if (name === undefined || name === "") {
    if (isSelf) return isScreenshare ? shellText("tile.yourScreen") : shellText("tile.you");
    return isScreenshare
      ? shellText("tile.userScreen", { id: String(userId) })
      : shellText("tile.user", { id: String(userId) });
  }
  if (isScreenshare) return shellText("tile.nameScreen", { name });
  return isSelf ? shellText("tile.nameYou", { name }) : name;
}
