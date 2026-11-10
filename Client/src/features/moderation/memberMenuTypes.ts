/** Options for the member right-click menu (see AdminActions). */

import type { VoiceModMenuOptions } from "../channels/sidebar/volumeMenu";

export interface MemberContextMenuOptions {
  /** Where the menu opens, in viewport pixels. */
  x: number;
  y: number;
  userId: number;
  username: string;
  currentRole: string;
  availableRoles: readonly string[];
  /** When false, only the non-admin actions (block/unblock) are rendered. */
  showAdminActions: boolean;
  /**
   * Per-action gates, each defaulting to `showAdminActions`. They mirror the
   * server's KICK_MEMBERS / BAN_MEMBERS / MANAGE_ROLES bits so a moderator
   * sees only the actions its role actually holds. canKick gates "Force
   * Logout" — the KICK_MEMBERS bit buys session revocation, not removal.
   */
  canKick?: boolean;
  canBan?: boolean;
  canManageRoles?: boolean;
  /** MODERATE_MEMBERS plus outrank; defaults to `showAdminActions`. The items
   *  also need their callbacks, so a caller that wires none shows none. */
  canTimeout?: boolean;
  /** MANAGE_NICKNAMES plus outrank plus the server capability; defaults to
   *  `showAdminActions`. The item also needs `onChangeNickname`. */
  canManageNicknames?: boolean;
  /** The menu's target is the signed-in user: no Block and no moderation. */
  isSelf?: boolean;
  /** Whether the target is timed out, from the server's timeout view: `unknown`
   *  (an older server, no view) offers both Timeout and Remove Timeout. */
  timeoutState?: "active" | "none" | "unknown";
  /** Optional items: each is absent when its option is left out. */
  onProfile?(): void;
  onMention?(): void;
  /** Why Mention is greyed (no composer to write into); absent means usable. */
  mentionDisabledReason?: string;
  onMessage?(): void;
  onCall?(): void;
  /** Voice moderation rows for a target in a server voice channel; a string is
   *  why they are unavailable and renders them greyed with that reason. */
  voiceMod?: VoiceModMenuOptions | string;
  /** Time the member out for `seconds` (one of the six presets). */
  onTimeout?(seconds: number): Promise<void>;
  onRemoveTimeout?(): Promise<void>;
  /** Opens the Change Nickname dialog. The menu closes first. */
  onChangeNickname?(): void;
  /** Runs once when the menu goes away, by any path. */
  onClosed?(): void;
  /** Where focus goes on close when the opener row is gone. */
  restoreFocusTo?(): HTMLElement | null;
  /** Whether the local user currently blocks this member (labels the toggle). */
  isBlocked: boolean;
  onToggleBlock(): Promise<void>;
  /** Revokes every session the target holds (the "Force Logout" item). */
  onKick(): Promise<void>;
  /** Opens the Ban dialog (reason, length, message history). The menu closes
   *  first, so the dialog returns focus to the member row. */
  onBan(): void;
  onChangeRole(newRole: string): Promise<void>;
}
