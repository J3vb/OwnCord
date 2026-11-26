import type { ScreenLayoutOption } from "./screenLayoutSeed";

/**
 * Runs at the start of the document that follows a fresh native launch's first
 * load: clears storage once, then stores the layout. The clear removes what the
 * first load and its unload wrote, so none of it reads as an earlier install.
 * The `sessionStorage` guard keeps a later `page.reload()` in a spec from
 * clearing again; a process relaunch starts a new session and attaches no
 * script. Serialised into the page, so it uses nothing from this module.
 */
export function seedNativeDocument(layout: string): void {
  if (window.top !== window) return;
  if (sessionStorage.getItem("owncord-e2e-layout-seeded") !== null) return;
  sessionStorage.setItem("owncord-e2e-layout-seeded", "1");
  localStorage.clear();
  localStorage.setItem("owncord:settings:screenLayout", JSON.stringify(layout));
}

/** What the app shows after the seeded load; read in the page. */
export interface SeededState {
  deck: boolean;
  layout: string | null;
  level: string | null;
}

/** The in-page read, as source for the WebDriver path and as a function for CDP. */
export function readSeededState(): SeededState {
  return {
    deck: document.documentElement.classList.contains("layout-deck"),
    layout: localStorage.getItem("owncord:settings:screenLayout"),
    level: localStorage.getItem("owncord:settings:notificationLevel"),
  };
}

/** Why `state` is not a clean seeded launch of `layout`, or null when it is. */
export function seedMismatch(layout: ScreenLayoutOption, state: SeededState): string | null {
  const problems: string[] = [];
  if (state.deck !== (layout === "deck"))
    problems.push(`html.layout-deck is ${state.deck}, the seed asked for ${layout}`);
  if (state.layout !== JSON.stringify(layout))
    problems.push(`the stored layout is ${state.layout}, the seed asked for ${layout}`);
  if (state.level !== JSON.stringify("mentions"))
    problems.push(
      `the stored notification level is ${state.level}, not "mentions": a key survived the clear`,
    );
  return problems.length === 0 ? null : problems.join("; ");
}

/**
 * Polls the seeded launch until it matches or `timeoutMs` passes, then throws
 * naming what differed. The level key is written when the bundle first runs, so
 * a null level is "not started yet", not a mismatch, until the deadline.
 */
export async function expectSeededLaunch(
  layout: ScreenLayoutOption,
  read: () => Promise<SeededState>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no state read";
  for (;;) {
    try {
      const state = await read();
      const problem = seedMismatch(layout, state);
      if (problem === null) return;
      last = problem;
    } catch (error) {
      // The document may be navigating; the next poll reads the new one.
      last = String(error);
    }
    if (Date.now() > deadline)
      throw new Error(`the ${layout} layout seed did not take on the fresh profile: ${last}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}
