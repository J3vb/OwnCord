/**
 * Shares from other apps while the main page is up: each opens the "Send to"
 * sheet, and the picked channel or DM opens with the files and text waiting
 * in its composer (shareInbox.ts). A newer share closes a sheet still open
 * and opens its own. Started by the main page, so a share that arrives while
 * signed out waits on the host until sign-in, and a server switch drops a
 * share still waiting for its channel.
 */

import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { jumpToMessage } from "@lib/nav/messageNavigation";
import type { ReceivedShare, ShareSheet } from "../../platform/contracts/shareSheet";
import { sendShareTo } from "./shareInbox";

const log = createLogger("share-in");

export function startShareIn(sheet: ShareSheet): () => void {
  let open: Disposable | null = null;
  let stopped = false;

  function show(share: ReceivedShare): void {
    open?.destroy();
    const sheetOpen = new Disposable();
    open = sheetOpen;
    import("./SharePicker")
      .then(({ openSharePicker }) => {
        if (stopped || sheetOpen.signal.aborted) return;
        openSharePicker({
          share,
          signal: sheetOpen.signal,
          onPick: (target) => {
            sendShareTo(target.id, share);
            jumpToMessage(target.id);
          },
        });
      })
      .catch((err: unknown) => log.warn("Send to sheet did not load", err));
  }

  const unsubscribe = sheet.onReceived(show);
  return () => {
    stopped = true;
    unsubscribe();
    open?.destroy();
  };
}
