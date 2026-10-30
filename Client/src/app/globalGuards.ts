// Document-level guards installed once at startup: the context menu, the
// F5/Ctrl+R/DevTools keys, the file-drop guard and external/masked links.
// Nothing here runs at import time; main.ts calls installGlobalGuards() at the
// point in the boot order where these guards used to be inline (before
// installGlobalErrorHandlers).

import { wantsNativeMenu } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { installFileDropGuard } from "../features/messaging/fileDropGuard";
import { desktop } from "../platform/desktop";
import { connectText } from "../i18n/connect";

const log = createLogger("main");

export function installGlobalGuards(): void {
  // Disable the default browser context menu everywhere but text fields.
  document.addEventListener("contextmenu", (e) => {
    if (!wantsNativeMenu(e.target)) e.preventDefault();
  });

  // Long-press menus, tap-to-show message actions and the keyboard-aware app
  // height live in a chunk loaded only where a touch pointer exists.
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(any-pointer: coarse)").matches
  ) {
    import("@lib/ui/touchInput").then(
      (m) => m.installTouchInput(new Disposable().signal),
      (err: unknown) => log.warn("touch input failed to load", err),
    );
  }

  // F12 or Ctrl+Shift+I opens WebView2 DevTools in development builds only.
  // F5 and Ctrl+R are blocked to prevent accidental page reloads which cause
  // ghost voice state (user appears in channel with no LiveKit connection).
  document.addEventListener("keydown", (e) => {
    // KeyboardEvent.key carries the shifted/CapsLock-cased character, so
    // Ctrl+Shift+R (and Ctrl+R with CapsLock on) would fall through this guard
    // as "R" without the lowercase compare.
    if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
      e.preventDefault();
      return;
    }
    if (import.meta.env.DEV && (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.key === "I"))) {
      e.preventDefault();
      desktop.devTools.open().catch((err: unknown) => log.warn("devtools open failed", err));
    }
  });

  // A file dropped where no composer listens must not navigate the webview.
  installFileDropGuard(new Disposable().signal);

  // Open external links (target="_blank") in the user's default browser. A
  // masked link ([text](url): the visible text is not the address) asks first,
  // through a dialog loaded only when one is clicked.
  document.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest("a[target='_blank']");
    if (link === null) return;
    e.preventDefault();
    const href = (link as HTMLAnchorElement).href;
    if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
      const open = (url: string): void => {
        desktop.urlOpener
          .open(url)
          .catch((err: unknown) => log.warn("external link open failed", err));
      };
      if (!link.classList.contains("masked")) {
        open(href);
        return;
      }
      import("@components/MaskedLinkGuard").then(
        (m) => m.guardMaskedLink(href, open),
        (err: unknown) => {
          log.warn("masked link warning failed to load", err);
          showToast(connectText("link.openFailed"), "error");
        },
      );
    }
  });
}
