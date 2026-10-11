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

/** What the popup's action buttons do. Each is omitted when the caller has no
 *  handler for it, and all are withheld for the signed-in user's own card. */
export interface UserProfilePopupCallbacks {
  readonly onMessage?: (userId: number) => void;
  readonly onCall?: (userId: number) => void;
  /** Receives the display name the popup shows, for the report dialog. */
  readonly onReport?: (userId: number, name: string) => void;
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

let activePopup: UserProfilePopupComponent | null = null;
/** Bumped by every open and close, so a popup still loading when the user
 *  moves on is dropped instead of mounted. */
let popupSeq = 0;

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

  const isSelf = userId === (authStore.getState().user?.id ?? 0);
  const onMessage = isSelf ? undefined : callbacks?.onMessage;
  const onCall = isSelf ? undefined : callbacks?.onCall;
  const onReport = isSelf ? undefined : callbacks?.onReport;
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
        },
        anchorX,
        anchorY,
        ...(onMessage === undefined ? {} : { onMessage: (id: number) => onMessage(id) }),
        ...(onCall === undefined ? {} : { onCall: (id: number) => onCall(id) }),
        ...(onReport === undefined
          ? {}
          : { onReport: (id: number) => onReport(id, memberDisplayName(live)) }),
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
