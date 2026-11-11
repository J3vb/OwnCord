/**
 * The shapes the user profile popup takes and reads: the member it shows, the
 * live role sources, and the options a caller passes to open it.
 */
import type { MountableComponent } from "@lib/text/safeRender";
import type { UserStatus } from "@lib/types";
import type { NoteBinding } from "./userNotes";
import type { ListeningSong } from "../members/listeningLine";

export interface UserProfileData {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  /** On the Android app: the status dot becomes a phone. */
  readonly mobile?: boolean;
  /** Nickname. When set the popup shows it as the heading and the username
   *  underneath, because the username is still the handle you @mention. */
  readonly displayName?: string | null;
  readonly about?: string | null;
  /** Free-text status line, shown under the name. */
  readonly customStatus?: string | null;
  /** The game being played, shown as "Playing <game> · for N min". */
  readonly activity?: { readonly name: string; readonly startedAt: number } | null;
  /** The song being listened to: a card under the game with a
   *  progress bar that ticks while the popup is open. */
  readonly listening?: ListeningSong | null;
  readonly joinDate?: string | null;
  /** Banner image path and colour; absent or null = the gradient. */
  readonly banner?: string | null;
  readonly banner_color?: string | null;
  readonly isDeleted?: boolean;
}

/** What the role area shows right now, read live while the popup is open. */
export interface ProfileRoleState {
  readonly role: string;
  /** Roles the viewer may assign; null when they may not change this role,
   *  which leaves the plain read-only badge. */
  readonly choices: readonly string[] | null;
}

/** The role picker's live source. Re-read on every `subscribe` callback,
 *  so a role change on either side re-filters or removes the picker. */
export interface ProfileRoleControl {
  read(): ProfileRoleState;
  subscribe(listener: () => void): () => void;
  /** Assign `role`. Reports its own failures; the shown role changes only when
   *  the server's echo reaches the store. */
  change(role: string): Promise<void>;
}

/** One role the member holds, as a chip. */
export interface ProfileRoleChip {
  readonly id: number;
  readonly name: string;
  /** Server colour; null = the seeded fallback for the name. */
  readonly color: string | null;
  /** The viewer may take this role away: MANAGE_ROLES and the role is below
   *  their own top role. The popup still hides the x on the last chip. */
  readonly removable: boolean;
}

/** What the multi-role area shows right now. */
export interface ProfileRolesState {
  /** Held roles, highest first. */
  readonly chips: readonly ProfileRoleChip[];
  /** Roles the viewer may add that the member does not hold; empty hides "+". */
  readonly addable: readonly { readonly id: number; readonly name: string }[];
}

/** The multi-role chips' live source, used instead of `ProfileRoleControl` on a
 *  server that advertises `multi_role`. Re-read on every `subscribe` callback. */
export interface ProfileRolesControl {
  read(): ProfileRolesState;
  subscribe(listener: () => void): () => void;
  /** Add / remove one role. Report their own failures; the chips change only
   *  when the server's echo reaches the store. */
  add(roleId: number): Promise<void>;
  remove(roleId: number): Promise<void>;
}

export interface UserProfilePopupOptions {
  readonly user: UserProfileData;
  /** Anchor point — the click event's clientX/clientY. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Called when the user clicks "Message". */
  readonly onMessage?: (userId: number) => void;
  /** Called when the user clicks "Call". */
  readonly onCall?: (userId: number) => void;
  /** Called when the user clicks "Report"; the popup closes first. */
  readonly onReport?: (userId: number) => void;
  /** Called when the user clicks Block / Unblock; the popup closes
   *  first. `block` is the state asked for. Omitted: no button. */
  readonly onToggleBlock?: (userId: number, block: boolean) => void;
  /** Whether the viewer has blocked this user: picks Block or Unblock. */
  readonly blocked?: boolean;
  /** Why Message and Call cannot be used right now (offline, or blocked).
   *  Set: both render disabled with this as their tooltip. */
  readonly unavailableReason?: string;
  /** Live role and role picker. Absent: the badge shows `user.role` as given. */
  readonly roleControl?: ProfileRoleControl;
  /** Role chips with remove and add. Set on a multi-role server; it
   *  replaces the single-role picker. Absent: `roleControl` as before. */
  readonly rolesControl?: ProfileRolesControl;
  /** The viewer's private note about this member. Absent: no Note
   *  section (the viewer's own card, or no session to keep a note in). */
  readonly note?: NoteBinding;
  /** Called when the popup is destroyed, before `onClose`, so an edit still
   *  waiting on its debounce is sent. The opener binds it to the session that
   *  opened the card. */
  readonly onNoteFlush?: () => void;
  /** Called once when the popup closes, however it was closed. */
  readonly onClose?: () => void;
  /** Where focus goes on close when the opener has left the document. */
  readonly fallbackFocus?: () => HTMLElement | null;
  /** Open as a phone bottom sheet instead of a card beside the anchor. */
  readonly sheet?: boolean;
}

export type UserProfilePopupComponent = MountableComponent & {
  /** Check if the popup is currently visible. */
  isOpen(): boolean;
};
