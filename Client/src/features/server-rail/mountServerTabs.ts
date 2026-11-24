/**
 * Loading Command Deck's server tabs into the top bar on demand. Everything the
 * tabs subscribe or observe belongs to one child of the frame's owner, so the
 * frame's teardown, or a failed load, releases all of it and leaves the bar as
 * Phase 3 drew it.
 */
import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { onPrefChange } from "@lib/prefs/preferences";
import type { RailController } from "./railController";
import type { ServerTabs } from "./serverTabsRenderer";
import { switcherOptions, type ServerSwitcherDeps } from "./switcherOptions";

const log = createLogger("deck");

/** Refits on what widens the tabs without resizing the row: width changes, the web font, the text size. */
function watchFit(tabs: ServerTabs, child: Disposable): void {
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => tabs.fit());
    observer.observe(tabs.nav);
    child.addCleanup(() => observer.disconnect());
  }
  // A FontFaceSet is not an element, so not through onEvent.
  document.fonts?.addEventListener("loadingdone", tabs.fit, { signal: child.signal });
  // The size is applied right after the preference is saved.
  onPrefChange(["fontSize", "largeFont"], () => queueMicrotask(tabs.fit), child.signal);
  child.onEvent(window, "resize", tabs.closeMenu);
}

/** Loads the tabs on demand and mounts them into the Deck top bar. Logs and leaves the bar as it is on failure. */
export function mountServerTabs(
  deps: ServerSwitcherDeps,
  bar: HTMLElement,
  owner: Disposable,
): void {
  const child = new Disposable();
  owner.addCleanup(() => child.destroy());
  let ctl: RailController | null = null;
  let tabs: ServerTabs | null = null;
  child.addCleanup(() => {
    tabs?.destroy();
    ctl?.destroy();
    tabs?.nav.remove();
    tabs?.servers.remove();
    bar.classList.remove("has-server-tabs", "has-tabs-row");
  });
  // Row 2 is held from the first frame, so the page does not move when the tabs arrive.
  bar.classList.add("has-tabs-row");
  void Promise.all([import("./railController"), import("./serverTabsRenderer")])
    .then(([{ createRailController }, { createServerTabs }]) => {
      if (child.signal.aborted || deps.isTornDown()) {
        child.destroy();
        return;
      }
      ctl = createRailController(switcherOptions(deps));
      tabs = createServerTabs(ctl);
      ctl.start(tabs.render, tabs.focusFallback);
      bar.prepend(tabs.servers);
      const direct = bar.querySelector(":scope > .deck-direct");
      bar.insertBefore(tabs.nav, direct);
      bar.classList.add("has-server-tabs");
      // The first render ran detached, where the row has no width to fit.
      tabs.fit();
      watchFit(tabs, child);
      return;
    })
    .catch((err: unknown) => {
      log.warn("Server tabs failed to load", err);
      try {
        child.destroy();
      } catch (cleanupErr: unknown) {
        log.warn("Server tabs cleanup failed", cleanupErr);
      }
    });
}
