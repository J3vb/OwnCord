/** The shapes a DM list row is drawn from, and the options the DM sidebar takes. */

import type { IconName } from "@lib/icons";

/** One member of a group DM, as far as the sidebar needs to draw them. */
export interface DmParticipant {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
}

export interface DmConversation {
  /** The DM channel. The row's identity — see the module comment. */
  readonly channelId: number;
  /** The other party of a 1:1 DM; for a group, the first participant. */
  readonly userId: number;
  /** What the row is labelled: a group's name or joined members, else a user. */
  readonly username: string;
  readonly avatar: string | null;
  readonly avatarColor?: string;
  readonly status?: "online" | "idle" | "dnd" | "offline";
  /** The other party of a 1:1 DM is on the Android app (draws the phone shape). */
  readonly mobile?: boolean;
  /** The game the other party of a 1:1 DM is playing, or else the
   *  music they listen to; never set for a group. Drawn as "Playing
   *  <game>" or "Listening to <player>" under the name. */
  readonly activity?: string | null;
  /** The icon for `activity`; the controller when absent. */
  readonly activityIcon?: IconName;
  /** True for a group DM: draws stacked avatars and a participant count. */
  readonly isGroup?: boolean;
  /** A group whose server reports an owner; drives the leave copy. */
  readonly hasOwner?: boolean;
  /** The group's uploaded icon: a server file path; absent for none. */
  readonly icon?: string;
  /** Everyone but the current user. Drives the stack and the count. */
  readonly participants?: readonly DmParticipant[];
  readonly lastMessage: string;
  readonly timestamp: string;
  readonly unread: boolean;
  /** Unread message count. Drives the numeric badge; a conversation marked
   *  `unread` with no count still shows the plain dot (older payloads). */
  readonly unreadCount?: number;
  /** Unread messages here that mention the current user. Outranks the unread
   *  badge, exactly as it does in the channel list. */
  readonly mentionCount?: number;
  /** Muted: the unread badge renders dimmed. The mention badge does not —
   *  a mute silences chatter, never something addressed to you. */
  readonly muted?: boolean;
  /** When a timed mute ends (epoch ms); absent or null for an untimed mute. */
  readonly mutedUntil?: number | null;
  readonly active?: boolean;
  /** Someone is in this DM's call: the row shows a phone glyph. */
  readonly inCall?: boolean;
}

export interface DmSidebarOptions {
  readonly conversations: readonly DmConversation[];
  readonly onSelectConversation: (channelId: number) => void;
  readonly onNewDm: () => void;
  /** Close a 1:1 DM / leave a group. The component does not distinguish —
   *  which one it is is the server's call, and the label says so. */
  readonly onCloseDm?: (channelId: number) => void;
  readonly onToggleMute?: (channelId: number) => void;
  /** Row menu: set the mute outright (see `DmMenuActions.onSetMute`). */
  readonly onSetMute?: (channelId: number, muted: boolean) => void;
  /** Row menu: mute for a fixed time. */
  readonly onMuteFor?: (channelId: number, durationMs: number) => void;
  /** Row menu: mark the conversation read. Offered only while it is unread. */
  readonly onMarkRead?: (channelId: number) => void;
  /** Row menu, 1:1 only: open this person's profile panel. */
  readonly onOpenProfile?: (channelId: number) => void;
  /** Row menu, 1:1 only: start a call in this DM. */
  readonly onCall?: (channelId: number) => void;
  /** Row menu, 1:1 only: Block (`block` true) or Unblock the other person. The
   *  owner confirms a Block. */
  readonly onToggleBlock?: (userId: number, username: string, block: boolean) => void;
  readonly onRenameGroup?: (channelId: number) => void;
  /** Row menu, groups on a 3B-10 server: pick and upload a new group icon. */
  readonly onChangeGroupIcon?: (channelId: number) => void;
  /** Row menu: remove the group icon. Offered only while one is set. */
  readonly onRemoveGroupIcon?: (channelId: number) => void;
  readonly onBack?: () => void;
  readonly serverName?: string;
}
