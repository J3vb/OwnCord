// Opens a URL in a new browser tab: the web build's stand-in for the native
// shell opener. It takes the schemes the desktop command does
// (external_open.rs), cuts the new tab's link back to this page, and rejects
// when the browser blocks the tab so the caller can say it did not open.
import type { UrlOpener } from "../contracts/opener";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const urlOpener: UrlOpener = {
  // No await before window.open: the click's user activation must still hold,
  // or the popup blocker refuses the tab.
  async open(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // i18n-exempt: internal diagnostic, logged by callers, never rendered
      throw new Error("not an absolute url");
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      // i18n-exempt: internal diagnostic, logged by callers, never rendered
      throw new Error(`url scheme not allowed: ${parsed.protocol}`);
    }
    const tab = window.open(parsed.href, "_blank");
    if (tab === null) {
      // i18n-exempt: internal diagnostic, logged by callers, never rendered
      throw new Error("the browser blocked the new tab");
    }
    tab.opener = null;
  },
};
