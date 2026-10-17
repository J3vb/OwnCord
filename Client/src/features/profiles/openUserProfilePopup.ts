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
import type { UserProfilePopupComponent } from "../../components/UserProfilePopup";
import { showToast } from "../../lib/toast";
import { reportEntryText } from "../../i18n/reportEntry";
import { requestsText } from "../../i18n/requests";
import { formatDate } from "../../i18n/format";
import { blocksStore } from "../../stores/blocks.store";
import { uiStore } from "../../stores/ui.store";

/** What the popup's action buttons do. Each is omitted when the caller has no
 *  handler for it, and all are withheld for the signed-in user's own card. */
export interface UserProfilePopupCallbacks {
  readonly onMessage?: (userId: number) => void;
  readonly onCall?: (userId: number) => void;
  /** Receives the display name the popup shows, for the report dialog. */
  readonly onReport?: (userId: number, name: string) => void;
  /** Block (`block` true) or Unblock, with the display name for the confirm. */
  readonly onToggleBlock?: (userId: number, name: string, block: boolean) => void;
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
  const blocked = blocksStore.getState().blockedByMe.has(userId);
  const unavailableReason = callUnavailableReason(userId);
  const fallbackFocus = options.fallbackFocus;
  const seq = ++popupSeq;

  import("../../components/UserProfilePopup").then(
    ({ createUserProfilePopup }) => {
      if (seq !== popupSeq || signal?.aborted === true) return;
      const popup = createUserProfilePopup({
        user: {
          id: live.id,
          username: live.username,
          avatar: live.avatar,
          role: live.role,
          status: live.status,
          displayName: live.displayName,
          customStatus: live.customStatus,
          // Absent (older server) hides the sections, as before.
          ...(live.about === undefined ? {} : { about: live.about }),
          ...(joinDate === null ? {} : { joinDate }),
        },
        anchorX,
        anchorY,
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
    () => showToast(reportEntryText("profileLoadFailed"), "error"),
  );

  return () => {
    if (seq === popupSeq) closeUserProfilePopup();
  };
}
