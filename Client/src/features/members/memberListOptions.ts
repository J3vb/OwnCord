/**
 * MemberList options: the admin action callbacks the owner passes in.
 */

import type { VoiceUser } from "@stores/voice.store";
import type { VoiceModMenuOptions } from "../channels/sidebar/volumeMenu";

/** Options for configuring admin action callbacks on the member list. */
export interface MemberListOptions {
  /** Role name of the signed-in user; resolved against the server's role list
   *  to get the permission mask that gates the moderation menu items. */
  readonly currentUserRole: string;
  /** Force logout: revokes the target's sessions (KICK_MEMBERS). */
  readonly onKick: (userId: number, username: string) => Promise<void>;
  /** Open the Ban dialog for a member; `displayName` names them in its title. */
  readonly onBan: (userId: number, username: string, displayName: string) => void;
  readonly onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
  /** Open the Change Nickname dialog (MANAGE_NICKNAMES); `current` is the
   *  member's nickname now, null when they have none. Absent hides the item. */
  readonly onChangeNickname?: (userId: number, username: string, current: string | null) => void;
  /** Add / remove one role from the profile popup's chips. */
  readonly onAddRole?: (userId: number, username: string, roleId: number) => Promise<void>;
  readonly onRemoveRole?: (userId: number, username: string, roleId: number) => Promise<void>;
  readonly onToggleBlock: (userId: number, username: string, block: boolean) => Promise<void>;
  /** Block / Unblock from the profile popup, which confirms a Block in a
   *  dialog (the row menu confirms inline). Omitted: the popup has no button. */
  readonly onBlockFromPopup?: (userId: number, username: string, block: boolean) => void;
  /** Start a DM with a user (wires the profile popup's Message button). */
  readonly onMessageUser?: (userId: number) => void;
  /** Call a user: open (or create) the 1:1 DM with them and start a call in
   *  it (wires the profile popup's Call button). */
  readonly onCallUser?: (userId: number) => void;
  /** Report a user to this server's moderators (the profile popup's Report button). */
  readonly onReportUser?: (userId: number, name: string) => void;
  /** Time a member out for `seconds` (MODERATE_MEMBERS); absent hides Timeout. */
  readonly onTimeoutMember?: (userId: number, username: string, seconds: number) => Promise<void>;
  /** End a member's timeout early; absent hides Remove Timeout. */
  readonly onRemoveTimeout?: (userId: number, username: string) => Promise<void>;
  /** Voice moderation rows for a member in a server voice channel: the options,
   *  a string saying why they are unavailable, or undefined for none. Absent
   *  hides the rows. */
  readonly voiceModFor?: (
    channelId: number,
    user: VoiceUser,
  ) => VoiceModMenuOptions | string | undefined;
}
