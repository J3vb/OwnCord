/**
 * Back closes the overlays on a phone: Settings, a content view (Requests,
 * Moderation Center) and any dialog (the quick switcher, a confirm, the image
 * viewer). Each claims the Back button while it is up, through the same
 * history entry the sheets and the drawer use, so the one opened last is the
 * one Back closes. Phone layout only; elsewhere nothing is claimed.
 *
 * Settings and views are read from the stores. Dialogs are plain nodes added
 * to the page, so a childList observer on the body and the page root asks
 * again whenever one comes or goes. Sheets claim for themselves and are
 * skipped here.
 *
 * Back on Settings presses Escape in it, so it takes the same path as the
 * keyboard: a prompt in the panel closes first, an open section goes back to
 * the list, and Settings stays open while a one-time secret is on its way.
 */

import { Disposable } from "@lib/disposable";
import { claimBack, type BackClaim } from "@lib/ui/backHistory";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { dismissTopDialog, displayedDialogs, pressEscapeIn } from "@lib/ui/dialogOpen";
import { closeSettings, uiStore } from "@stores/ui.store";

/** Dialogs that have their own Back claim, or are tracked by the stores. */
const OWN_CLAIM = ".bottom-sheet-overlay, .settings-overlay";

export interface OverlayBackOptions {
  readonly signal: AbortSignal;
  /** The page root: its children include the quick switcher and other dialogs. */
  readonly root: HTMLElement;
  /** Close the open content view and take its back path. */
  readonly closeView: () => void;
}

export function installOverlayBack(opts: OverlayBackOptions): void {
  const owner = new Disposable();
  opts.signal.addEventListener("abort", () => owner.destroy(), { once: true });

  let settings: BackClaim | null = null;
  let view: BackClaim | null = null;
  let dialog: BackClaim | null = null;

  const ensure = (
    held: BackClaim | null,
    wanted: boolean,
    onBack: () => void,
  ): BackClaim | null => {
    if (wanted && held === null) return claimBack(onBack, owner.signal);
    if (!wanted && held !== null) {
      held.release();
      return null;
    }
    return held;
  };

  const syncDialog = (): void => {
    dialog = ensure(dialog, isPhoneLayout() && displayedDialogs(OWN_CLAIM).length > 0, () => {
      dialog = null;
      dismissTopDialog(OWN_CLAIM);
      // A dialog that stayed (it asked first, or refused) still owns Back.
      syncDialog();
    });
  };
  const syncStores = (): void => {
    const { settingsOpen, activeView } = uiStore.getState();
    settings = ensure(settings, isPhoneLayout() && settingsOpen, () => {
      settings = null;
      const panel = document.querySelector<HTMLElement>(".settings-overlay");
      if (panel === null) closeSettings();
      else pressEscapeIn(panel);
      // Settings that stayed open (a section or prompt closed instead, or a
      // secret is on its way) still owns Back.
      syncStores();
    });
    view = ensure(view, isPhoneLayout() && activeView !== null, () => {
      view = null;
      opts.closeView();
    });
  };

  owner.onStoreChange(uiStore, (s) => s.settingsOpen, syncStores);
  owner.onStoreChange(uiStore, (s) => s.activeView, syncStores);
  const observer = new MutationObserver(syncDialog);
  observer.observe(document.body, { childList: true });
  observer.observe(opts.root, { childList: true });
  owner.addCleanup(() => observer.disconnect());
  // Turning the device moves the window onto or off the phone layout.
  owner.onEvent(window, "resize", () => {
    syncStores();
    syncDialog();
  });
  syncStores();
  syncDialog();
}
