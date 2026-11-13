/** Shows the sign-in alert, loading it on first use so it stays out of the MainPage chunk. */

import type { SessionInfo } from "@lib/api";
import { createLogger } from "@lib/logger";

const log = createLogger("sign-in-notice");

interface SignInNoticeModule {
  readonly showSignInNotice: (unseen: readonly SessionInfo[]) => void;
}

/** Shows nothing when `signal` aborts (logout, page teardown) before the code arrives. */
export function notifySignIn(
  unseen: readonly SessionInfo[],
  signal: AbortSignal,
  load: () => Promise<SignInNoticeModule> = () => import("./signInNotice"),
): Promise<void> {
  return load().then(
    (notice) => {
      if (!signal.aborted) notice.showSignInNotice(unseen);
    },
    (err: unknown) => log.warn("Failed to load the sign-in notice", err),
  );
}
