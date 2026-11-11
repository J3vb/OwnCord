// The DM profile panel's public shapes: what it paints and how it is opened.
import type { MountableComponent } from "@lib/text/safeRender";
import type { UserStatus } from "@lib/types";
import type { ListeningSong } from "../members/listeningLine";
import type { NotesContext } from "../profiles/userNotes";

export interface DmProfileData {
  readonly id: number;
  readonly username: string;
  /** Nickname, when set. The DM header this panel opens from renders through
   *  `dmDisplayName`, which prefers this over `username` -- without it here
   *  the panel would show a different identity from the header just clicked. */
  readonly displayName?: string | null;
  readonly avatar: string | null;
  readonly status: UserStatus;
  /** The person's own status line under the name. Null or absent = none. */
  readonly customStatus?: string | null;
  /** On the Android app: the status dot becomes a phone. */
  readonly mobile?: boolean;
  /** The game being played: "Playing <game> · for N min" under the status. */
  readonly activity?: { readonly name: string; readonly startedAt: number } | null;
  /** The song being listened to, with a progress bar that ticks while open. */
  readonly listening?: ListeningSong | null;
  readonly about?: string | null;
  readonly joinDate?: string | null;
  /** Banner image path and colour; absent or null = no strip. */
  readonly banner?: string | null;
  readonly banner_color?: string | null;
}

export interface DmProfileSidebarOptions {
  readonly user: DmProfileData;
  readonly onClose: () => void;
  /** Block (`block` true) or Unblock this user. The owner confirms a
   *  Block; the label follows `blocksStore`. Omitted: no button. */
  readonly onToggleBlock?: (userId: number, block: boolean) => void;
  /** Open the report form for this user. Omitted: no button. */
  readonly onReport?: (userId: number) => void;
  /**
   * The connected server's host, used to scope the note's localStorage key.
   * User ids are per-server, so without this a note about user 5 on one
   * server is shown for, and overwritten by, the unrelated user 5 on
   * another — real in the multi-profile client (see profiles.ts). Optional,
   * and falls back to the legacy unscoped key, so a caller that has not
   * been updated to pass it yet keeps today's single-profile behavior
   * exactly (including any note already saved under the old key).
   */
  readonly host?: string;
  /**
   * Where the note is kept: the session that opened the panel, captured at open
   * so a flush on close or on a DM switch uses its API client. Omitted: the note
   * stays in localStorage under `host`, as before the server kept notes.
   */
  readonly notes?: NotesContext;
  /**
   * Move focus to the panel on mount. True (the default) when the user opened
   * it; false when it opened by itself with the conversation, so it never takes
   * focus from the composer or whatever the user was typing in.
   */
  readonly focus?: boolean;
}

export type DmProfileSidebarComponent = MountableComponent & {
  readonly isOpen: () => boolean;
  /**
   * Repaint the name, avatar initial and status (dot + label, both the
   * avatar-corner one and the inline one) from a fresher `DmProfileData`,
   * in place -- without rebuilding the panel and losing the note textarea's
   * focus/selection. The panel itself has no subscription to any store (it
   * is intentionally presentational); the owner is expected to call this
   * when the underlying user's presence or identity changes while the panel
   * stays open, mirroring how ChannelController keeps the DM chat header
   * live across the same events (see ChannelController.ts's refreshDmHeader).
   * A no-op before mount() or after destroy().
   */
  readonly update: (user: DmProfileData) => void;
};
