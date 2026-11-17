/** The alert for a sign-in the user has not reviewed, with a way to the devices list. */

import type { SessionInfo } from "@lib/api";
import { createIcon } from "@lib/icons";
import { deviceLabel } from "@lib/net/deviceLabel";
import { formatMessageTimestamp } from "@lib/text/formatting";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { showActionToast } from "@lib/ui/toast";
import { openSettings } from "@stores/ui.store";
import { accountText } from "../../i18n/account";

/** Long enough to read which sign-in it names (cf. toast.ts PARTIAL_SUCCESS_TOAST_MS). */
export const SIGN_IN_NOTICE_MS = 12_000;

/** No line break inside one part of the detail line, only between parts. */
function keepTogether(part: string): string {
  return part.replace(/ /g, "\u00a0");
}

/** The second line for one listing's unreviewed sign-ins (newest first):
 *  "Chrome on Windows · 203.0.113.7 · Today at 9:09 AM", plus how many more
 *  there are. The address is what the server saw, so it stays whenever known. */
export function signInNoticeDetail(unseen: readonly SessionInfo[]): string {
  const [newest] = unseen;
  if (newest === undefined) return "";
  const device = keepTogether(deviceLabel(newest.device, accountText));
  const time = keepTogether(formatMessageTimestamp(newest.created_at));
  const detail =
    newest.ip === ""
      ? accountText("notice.detailNoIp", { device, time })
      : accountText("notice.detail", { device, ip: newest.ip, time });
  return unseen.length > 1
    ? accountText("notice.detailMore", { detail, count: unseen.length - 1 })
    : detail;
}

export function showSignInNotice(unseen: readonly SessionInfo[]): void {
  if (unseen.length === 0) return;
  showActionToast(
    accountText(isPhoneLayout() ? "notice.titleShort" : "notice.title"),
    "info",
    {
      label: accountText("notice.review"),
      // i18n-exempt: Settings request id; opens the Account tab's devices list
      run: () => openSettings("Devices"),
    },
    SIGN_IN_NOTICE_MS,
    { detail: signInNoticeDetail(unseen), icon: createIcon("shield-alert", 20), closable: true },
  );
}
