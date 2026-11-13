/** Shows the sign-in alert, loading it on first use so it stays out of the MainPage chunk. */

import type { SessionInfo } from "@lib/api";
import { createLogger } from "@lib/logger";
import { showActionToast } from "@lib/ui/toast";
import { openSettings } from "@stores/ui.store";
import { shellText } from "../../i18n/shell";

const log = createLogger("sign-in-notice");

interface SignInNoticeModule {
  readonly showSignInNotice: (unseen: readonly SessionInfo[]) => void;
}

/** As long as the full alert stays, so the plain one is as easy to catch. */
const PLAIN_NOTICE_MS = 12_000;

/** The alert without its details, for when its code cannot be loaded: the
 *  listing that reported the sign-in is not repeated, so this is the one
 *  chance to tell the user. */
function showPlainNotice(): void {
  showActionToast(
    shellText("signIn.plain"),
    "info",
    {
      label: shellText("signIn.review"),
      // i18n-exempt: Settings request id; opens the Account tab's devices list
      run: () => openSettings("Devices"),
    },
    PLAIN_NOTICE_MS,
  );
}

/** Shows nothing when `signal` aborts (logout, page teardown) before the code
 *  arrives. A failed load falls back to the plain alert. */
export function notifySignIn(
  unseen: readonly SessionInfo[],
  signal: AbortSignal,
  load: () => Promise<SignInNoticeModule> = () => import("./signInNotice"),
): Promise<void> {
  return load().then(
    (notice) => {
      if (!signal.aborted) notice.showSignInNotice(unseen);
    },
    (err: unknown) => {
      log.warn("Failed to load the sign-in notice", err);
      if (!signal.aborted) showPlainNotice();
    },
  );
}
