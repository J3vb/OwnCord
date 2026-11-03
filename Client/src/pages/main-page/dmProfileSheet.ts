/**
 * The DM partner's profile on a phone, and the report form the DM profile
 * offers on both layouts. Loaded on first use, so it stays out of the eager
 * main page chunk.
 */
import { showToast } from "@lib/ui/toast";
import type { ApiClient } from "@lib/api";
import type { Member } from "@stores/members.store";
import { shellText } from "../../i18n/shell";
import { reportEntryText } from "../../i18n/reportEntry";
import { openUserProfilePopup } from "../../features/profiles/openUserProfilePopup";
import { buildDmProfileUser } from "./pageShared";

export interface DmProfileSheetDeps {
  readonly api: ApiClient;
  /** Dialogs opened from here live as long as this. */
  readonly signal: AbortSignal;
  /** The header button; the sheet anchors on it and focus returns to it. */
  readonly button: () => HTMLButtonElement | null;
  readonly startCall: () => void;
}

/** The report form for a DM partner; focus goes back to the header button. */
export function openDmPartnerReport(deps: DmProfileSheetDeps, userId: number, name: string): void {
  void import("../../features/reports/openers").then(
    ({ openUserReport }) => {
      if (deps.signal.aborted) return;
      openUserReport({
        api: deps.api,
        userId,
        name,
        signal: deps.signal,
        fallbackFocus: deps.button,
      });
    },
    () => showToast(reportEntryText("reportLoadFailed"), "error"),
  );
}

/**
 * The 1:1 partner in the member profile sheet, with their @username, custom
 * status, roles, Call, Report and Block. Built from the live member entry; a
 * partner who is not a member of this server falls back to what the DM list
 * knows.
 */
export function openDmProfileSheet(deps: DmProfileSheetDeps, channelId: number): void {
  const user = buildDmProfileUser(channelId);
  if (user === null || deps.signal.aborted) return;
  const fallbackUser: Member = {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    role: "member",
    status: user.status,
    mobile: user.mobile === true,
    displayName: user.displayName ?? null,
  };
  const rect = deps.button()?.getBoundingClientRect();
  openUserProfilePopup({
    userId: user.id,
    anchorX: rect?.left ?? 0,
    anchorY: rect?.bottom ?? 0,
    fallbackUser,
    signal: deps.signal,
    fallbackFocus: deps.button,
    callbacks: {
      onCall: () => deps.startCall(),
      onReport: (userId, name) => openDmPartnerReport(deps, userId, name),
      onToggleBlock: (userId, name, block) => {
        void import("../../features/blocks/blockActions").then(
          ({ confirmAndToggleBlock }) =>
            confirmAndToggleBlock({ api: deps.api, notify: showToast }, userId, name, block),
          () =>
            showToast(shellText(block ? "members.blockFailed" : "members.unblockFailed"), "error"),
        );
      },
    },
  });
}
