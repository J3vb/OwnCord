import type { BrowserContext } from "@playwright/test";

/** The layout a test profile starts on. `fresh` seeds nothing: the profile is
 *  an empty one, as a new install's is. */
export type ScreenLayoutOption = "classic" | "deck" | "fresh";

/**
 * Stores the screen layout in every page of `context` before the app's first
 * load, only when no layout is stored yet, so a spec that sets or clears its
 * own layout wins in either script order. A context script also reaches
 * pop-out windows. It also marks the one-time move to Command Deck as settled,
 * so a seeded Classic stays Classic whatever else a spec stores.
 */
export async function seedScreenLayout(
  context: BrowserContext,
  layout: ScreenLayoutOption,
): Promise<void> {
  if (layout === "fresh") return;
  await context.addInitScript((value) => {
    try {
      const key = "owncord:settings:screenLayout";
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value));
      const settled = "owncord:settings:deckSwitchDone";
      if (localStorage.getItem(settled) === null) localStorage.setItem(settled, "true");
    } catch {
      // Storage is unavailable on this document (an opaque origin): nothing to seed.
    }
  }, layout);
}
