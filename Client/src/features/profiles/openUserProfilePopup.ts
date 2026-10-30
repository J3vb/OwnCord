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
  UserProfilePopupComponent,
} from "../../components/UserProfilePopup";
import { showToast } from "../../lib/ui/toast";
import { reportEntryText } from "../../i18n/reportEntry";
import { requestsText } from "../../i18n/requests";
import { formatDate } from "../../i18n/format";
import { blocksStore } from "../../stores/blocks.store";
import { uiStore } from "../../stores/ui.store";
import { channelsStore } from "../../stores/channels.store";
import { memberRolesState, roleChangeChoices } from "../moderation/roleAssignment";
import { multiRoleEnabled } from "../../lib/net/serverCapabilities";
import { createNoteBinding, currentNotesContext } from "./userNotes";

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
  const onMessage = isSelf ? undefined : callbacks?.onMessage;
  const onCall = isSelf ? undefined : callbacks?.onCall;
  const onReport = isSelf ? undefined : callbacks?.onReport;
  const onToggleBlock = isSelf ? undefined : callbacks?.onToggleBlock;
  const onChangeRole = callbacks?.onChangeRole;
  const onAddRole = callbacks?.onAddRole;
  const onRemoveRole = callbacks?.onRemoveRole;
  const blocked = blocksStore.getState().blockedByMe.has(userId);
  const unavailableReason = callUnavailableReason(userId);
  const fallbackFocus = options.fallbackFocus;
  // Read from the stores every time, so a role change on either side (the
  // member's, or the viewer's own, or the role list) re-filters or removes the
  // picker while the card is open.
  const roleControl: ProfileRoleControl = {
    read: () => {
      const member = membersStore.getState().members.get(userId);
      const role = member?.role ?? live.role;
      // A member who left or was banned while the card is open has no role to change.
      return {
        role,
        choices:
          onChangeRole === undefined || member === undefined
            ? null
            : roleChangeChoices(userId, role, member.roleIds),
      };
    },
    subscribe: (listener) => {
      const unsubs = [
        membersStore.subscribeSelector((st) => st.members.get(userId)?.role, listener),
        authStore.subscribeSelector(
          (st) => `${st.user?.role ?? ""}|${st.user?.role_ids?.join(",") ?? ""}`,
          listener,
        ),
        channelsStore.subscribeSelector((st) => st.roles, listener),
      ];
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    change: async (role) => {
      const username = membersStore.getState().members.get(userId)?.username ?? live.username;
      await onChangeRole?.(userId, username, role);
    },
  };
  // The chips replace the single-role picker only on a server that holds
  // several roles per member; any other server keeps the picker above.
  const rolesControl: ProfileRolesControl | undefined =
    multiRoleEnabled() && onAddRole !== undefined && onRemoveRole !== undefined
      ? {
          read: () => {
            const member = membersStore.getState().members.get(userId);
            return memberRolesState(
              userId,
              member?.role ?? live.role,
              member === undefined ? live.roleIds : member.roleIds,
            );
          },
          subscribe: (listener) => {
            const unsubs = [
              membersStore.subscribeSelector(
                (st) => st.members.get(userId)?.roleIds ?? st.members.get(userId)?.role,
                listener,
              ),
              authStore.subscribeSelector(
                (st) => `${st.user?.role ?? ""}|${st.user?.role_ids?.join(",") ?? ""}`,
                listener,
              ),
              channelsStore.subscribeSelector((st) => st.roles, listener),
            ];
            return () => {
              for (const unsub of unsubs) unsub();
            };
          },
          add: async (roleId) => {
            const username = membersStore.getState().members.get(userId)?.username ?? live.username;
            await onAddRole(userId, username, roleId);
          },
          remove: async (roleId) => {
            const username = membersStore.getState().members.get(userId)?.username ?? live.username;
            await onRemoveRole(userId, username, roleId);
          },
        }
      : undefined;
  // Captured now, not when the card mounts or closes: a flush on close must
  // use the session that opened the card, whatever has been switched to since.
  const notesContext = isSelf ? null : currentNotesContext();
  const note = notesContext === null ? undefined : createNoteBinding(notesContext, userId);
  const seq = ++popupSeq;

  import("../../components/UserProfilePopup").then(
    ({ createUserProfilePopup }) => {
      if (seq !== popupSeq || signal?.aborted === true) {
        note?.destroy();
        return;
      }
      const popup = createUserProfilePopup({
        user: {
          id: live.id,
          username: live.username,
          avatar: live.avatar,
          role: live.role,
          status: live.status,
          displayName: live.displayName,
          customStatus: live.customStatus,
          activity: live.activity ?? null,
          listening: live.listening ?? null,
          // Absent (older server) hides the sections, as before.
          ...(live.about === undefined ? {} : { about: live.about }),
          banner: live.banner ?? null,
          banner_color: live.banner_color ?? null,
          ...(joinDate === null ? {} : { joinDate }),
        },
        anchorX,
        anchorY,
        ...(rolesControl === undefined ? { roleControl } : { rolesControl }),
        ...(note === undefined ? {} : { note, onNoteFlush: () => note.destroy() }),
        ...(onMessage === undefined ? {} : { onMessage: (id: number) => onMessage(id) }),
        ...(onCall === undefined ? {} : { onCall: (id: number) => onCall(id) }),
        ...(onReport === undefined
          ? {}
          : { onReport: (id: number) => onReport(id, memberDisplayName(live)) }),
        ...(onToggleBlock === undefined
          ? {}
          : {
              blocked,
              onToggleBlock: (id: number, block: boolean) =>
                onToggleBlock(id, memberDisplayName(live), block),
            }),
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        onClose: () => {
          if (activePopup === popup) activePopup = null;
        },
        ...(fallbackFocus === undefined ? {} : { fallbackFocus }),
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
