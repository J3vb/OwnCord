/**
 * Opens the user profile popup for a user id, from any surface that shows a
 * user (the member list, a message's author or an @mention chip).
 *
 * One popup exists at a time: opening another closes the first. The popup
 * module is loaded on first use, so it stays out of the main-page bundle. The
 * card is built from the live `membersStore` entry rather than from whatever
 * snapshot the caller rendered, so a presence change since the row was drawn
 * does not show a stale dot.
 */

import { authStore } from "../../stores/auth.store";
import { membersStore, memberDisplayName, type Member } from "../../stores/members.store";
import type {
  ProfileRoleControl,
  ProfileRolesControl,
  UserProfileData,
  UserProfilePopupComponent,
  UserProfilePopupOptions,
} from "./userProfileTypes";
import { showToast } from "../../lib/ui/toast";
import { isPhoneLayout } from "../../lib/ui/bottomSheet";
import { reportEntryText } from "../../i18n/reportEntry";
import { requestsText } from "../../i18n/requests";
import { formatDate } from "../../i18n/format";
import { blocksStore } from "../../stores/blocks.store";
import { uiStore } from "../../stores/ui.store";
import { buildRoleControl, buildRolesControl } from "./profileRoleControls";
import { createNoteBinding, currentNotesContext, type NoteBinding } from "./userNotes";

/** What the popup's action buttons do. Each is omitted when the caller has no
 *  handler for it, and all are withheld for the signed-in user's own card. */
export interface UserProfilePopupCallbacks {
  readonly onMessage?: (userId: number) => void;
  readonly onCall?: (userId: number) => void;
  /** Receives the display name the popup shows, for the report dialog. */
  readonly onReport?: (userId: number, name: string) => void;
  /** Block (`block` true) or Unblock, with the display name for the confirm. */
  readonly onToggleBlock?: (userId: number, name: string, block: boolean) => void;
  /** Change the member's role (MANAGE_ROLES). Omitted: no role picker. It
   *  reports its own failures; the card follows the roster, not this call. */
  readonly onChangeRole?: (userId: number, username: string, newRole: string) => Promise<void>;
  /** Add / remove one role. Both set on a server that advertises
   *  `multi_role`: the role area becomes chips. They report their own failures. */
  readonly onAddRole?: (userId: number, username: string, roleId: number) => Promise<void>;
  readonly onRemoveRole?: (userId: number, username: string, roleId: number) => Promise<void>;
}

export interface OpenUserProfilePopupOptions {
  readonly userId: number;
  /** Anchor point, usually the click's clientX/clientY. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Where focus goes on close when the opener has left the document. */
  readonly fallbackFocus?: () => HTMLElement | null;
  readonly callbacks?: UserProfilePopupCallbacks;
  /** Used when the user is not in `membersStore` (for example one who has left). */
  readonly fallbackUser?: Member;
  /** A popup still loading when this aborts is dropped instead of mounted. */
  readonly signal?: AbortSignal;
}

/**
 * Why Message and Call cannot be used with `userId` right now: the socket is
 * down, or either side has blocked the other (the store learns the other
 * direction only once a send was refused). Undefined when nothing is in the
 * way. Said in a tooltip rather than letting the click fail.
 */
export function callUnavailableReason(userId: number): string | undefined {
  if (uiStore.getState().connectionStatus !== "connected") {
    return requestsText("profile.offlineReason");
  }
  const { blockedByMe, blockedByThem } = blocksStore.getState();
  return blockedByMe.has(userId) || blockedByThem.has(userId)
    ? requestsText("profile.blockedReason")
    : undefined;
}

let activePopup: UserProfilePopupComponent | null = null;
/** Bumped by every open and close, so a popup still loading when the user
 *  moves on is dropped instead of mounted. */
let popupSeq = 0;

/** "Member since" text for an RFC3339 account-creation time; null when absent
 *  or unparseable (older server), which hides the section. */
function formatJoinDate(createdAt: string | undefined): string | null {
  if (createdAt === undefined) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return formatDate(date, { year: "numeric", month: "long", day: "numeric" });
}

/** Close the open popup, if any, and cancel one that is still loading. */
export function closeUserProfilePopup(): void {
  popupSeq++;
  if (activePopup !== null) {
    activePopup.destroy?.();
    activePopup = null;
  }
}

interface PopupInputs {
  readonly live: Member;
  readonly joinDate: string | null;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly roleControl: ProfileRoleControl;
  readonly rolesControl: ProfileRolesControl | undefined;
  readonly note: NoteBinding | undefined;
  /** The caller's buttons; empty for the signed-in user's own card. */
  readonly actions: UserProfilePopupCallbacks;
  readonly blocked: boolean;
  readonly unavailableReason: string | undefined;
  readonly fallbackFocus: (() => HTMLElement | null) | undefined;
}

/** The member the card shows, built from the live roster entry. */
function profileUserOf(live: Member, joinDate: string | null): UserProfileData {
  return {
    id: live.id,
    username: live.username,
    avatar: live.avatar,
    role: live.role,
    status: live.status,
    ...(live.mobile === true ? { mobile: true } : {}),
    displayName: live.displayName,
    customStatus: live.customStatus,
    activity: live.activity ?? null,
    listening: live.listening ?? null,
    // Absent (older server) hides the sections, as before.
    ...(live.about === undefined ? {} : { about: live.about }),
    banner: live.banner ?? null,
    banner_color: live.banner_color ?? null,
    ...(joinDate === null ? {} : { joinDate }),
  };
}

/** The popup options for one open, minus `onClose`, which needs the popup. */
function buildPopupOptions(i: PopupInputs): UserProfilePopupOptions {
  const { live, note, fallbackFocus } = i;
  const { onMessage, onCall, onReport, onToggleBlock } = i.actions;
  return {
    user: profileUserOf(live, i.joinDate),
    anchorX: i.anchorX,
    anchorY: i.anchorY,
    ...(i.rolesControl === undefined
      ? { roleControl: i.roleControl }
      : { rolesControl: i.rolesControl }),
    ...(note === undefined ? {} : { note, onNoteFlush: () => note.destroy() }),
    ...(onMessage === undefined ? {} : { onMessage: (id: number) => onMessage(id) }),
    ...(onCall === undefined ? {} : { onCall: (id: number) => onCall(id) }),
    ...(onReport === undefined
      ? {}
      : { onReport: (id: number) => onReport(id, memberDisplayName(live)) }),
    ...(onToggleBlock === undefined
      ? {}
      : {
          blocked: i.blocked,
          onToggleBlock: (id: number, block: boolean) =>
            onToggleBlock(id, memberDisplayName(live), block),
        }),
    ...(i.unavailableReason === undefined ? {} : { unavailableReason: i.unavailableReason }),
    ...(fallbackFocus === undefined ? {} : { fallbackFocus }),
    sheet: isPhoneLayout(),
  };
}

/** The viewer's note about the member, none on their own card. Captured at
 *  open, not when the card mounts or closes: a flush on close must use the
 *  session that opened the card, whatever has been switched to since. */
function openNoteBinding(userId: number, isSelf: boolean): NoteBinding | undefined {
  const notesContext = isSelf ? null : currentNotesContext();
  return notesContext === null ? undefined : createNoteBinding(notesContext, userId);
}

/**
 * Open the profile popup for `options.userId`. Returns a cleanup that closes
 * (or cancels) this popup, and does nothing if another popup has replaced it.
 */
export function openUserProfilePopup(options: OpenUserProfilePopupOptions): () => void {
  const { userId, anchorX, anchorY, callbacks, signal } = options;
  const live = membersStore.getState().members.get(userId) ?? options.fallbackUser;
  closeUserProfilePopup();
  if (live === undefined) return () => undefined;

  const joinDate = formatJoinDate(live.createdAt);
  const isSelf = userId === (authStore.getState().user?.id ?? 0);
  const actions = isSelf ? {} : (callbacks ?? {});
  const blocked = blocksStore.getState().blockedByMe.has(userId);
  const unavailableReason = callUnavailableReason(userId);
  const fallbackFocus = options.fallbackFocus;
  const roleControl = buildRoleControl(userId, live, callbacks?.onChangeRole);
  const rolesControl = buildRolesControl(
    userId,
    live,
    callbacks?.onAddRole,
    callbacks?.onRemoveRole,
  );
  const note = openNoteBinding(userId, isSelf);
  const seq = ++popupSeq;

  import("./userProfilePopup").then(
    ({ createUserProfilePopup }) => {
      if (seq !== popupSeq || signal?.aborted === true) {
        note?.destroy();
        return;
      }
      const popup: UserProfilePopupComponent = createUserProfilePopup({
        ...buildPopupOptions({
          live,
          joinDate,
          anchorX,
          anchorY,
          roleControl,
          rolesControl,
          note,
          actions,
          blocked,
          unavailableReason,
          fallbackFocus,
        }),
        onClose: () => {
          if (activePopup === popup) activePopup = null;
        },
      });
      activePopup = popup;
      popup.mount(document.body);
    },
    () => {
      note?.destroy();
      showToast(reportEntryText("profileLoadFailed"), "error");
    },
  );

  return () => {
    if (seq === popupSeq) closeUserProfilePopup();
  };
}
