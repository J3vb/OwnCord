/**
 * Mounts the Command Deck bars around the page's `.app` row.
 *
 * Build first, attach last: every bar is built detached inside a `try`, so a
 * bar that fails to build leaves the page exactly as Classic would draw it
 * (the slots never leave the sidebar). Only once every bar exists are they
 * attached and the sidebar's slots moved in. The slots' components stay owned
 * by the SidebarArea, so the teardown here never moves them back.
 */
import { Disposable } from "@lib/disposable";
import { runningScreenLayout } from "@lib/prefs/screenLayout";
import { createLogger } from "@lib/logger";
import { shellText } from "../../i18n/shell";
import { createDirectButton } from "../direct-messages/directButton";
import { mountServerTabs } from "../server-rail/mountServerTabs";
import type { ServerSwitcherDeps } from "../server-rail/switcherOptions";
import { createDeckStatusBar } from "./deckStatusBar";
import { createDeckTopBar } from "./deckTopBar";

const log = createLogger("deck");

export interface DeckFrameInput {
  readonly root: HTMLElement;
  readonly slots: { readonly userBar: HTMLElement; readonly voiceWidget: HTMLElement };
  readonly notify: (text: string) => void;
  /** Opens the chat search, as the Ctrl+F keybind does. */
  readonly onSearch: () => void;
  /** Opens the sidebar drawer, where the tree sits in a narrow window. */
  readonly revealSidebar?: () => void;
  /** The server switcher's inputs; the tabs are drawn when given (null in the web portal). */
  readonly serverTabs?: ServerSwitcherDeps | null;
}

/** Writes each bar's measured height on `root`, where the overlays read it. */
function observeBars(
  root: HTMLElement,
  bars: ReadonlyMap<Element, string>,
  owner: Disposable,
): void {
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const property = bars.get(entry.target);
      const size = entry.borderBoxSize[0];
      if (property !== undefined && size !== undefined) {
        root.style.setProperty(property, `${size.blockSize}px`);
      }
    }
  });
  for (const bar of bars.keys()) observer.observe(bar);
  owner.addCleanup(() => observer.disconnect());
}

/** Appends the Direct button to the top bar. A button that fails to build releases what it
 *  subscribed, is logged, and leaves the bar as it was. */
function mountDirectButton(topBar: HTMLElement, input: DeckFrameInput, owner: Disposable): void {
  const child = new Disposable();
  owner.addCleanup(() => child.destroy());
  try {
    const button = createDirectButton({
      root: input.root,
      revealSidebar: input.revealSidebar,
      owner: child,
    });
    topBar.appendChild(button);
    topBar.classList.add("has-deck-direct");
  } catch (err: unknown) {
    child.destroy();
    log.warn("Command Deck Direct button failed to build", err);
  }
}

/** Mounts the Deck bars when runningScreenLayout() is "deck" and returns their teardown.
 *  Returns null in Classic, and when a bar fails to build; then nothing was attached
 *  and the slots never left the sidebar. */
export function mountDeckFrame(input: DeckFrameInput): (() => void) | null {
  if (runningScreenLayout() !== "deck") return null;
  const owner = new Disposable();
  let topBar: HTMLDivElement;
  let statusBar: HTMLDivElement;
  try {
    // The top bar first: it subscribes to stores on `owner`, which a later
    // failure releases with the destroy below.
    topBar = createDeckTopBar({ onSearch: input.onSearch, owner });
    statusBar = createDeckStatusBar();
  } catch (err: unknown) {
    owner.destroy();
    log.error("Command Deck bars failed to build", err);
    input.notify(shellText("deck.fallback"));
    return null;
  }

  const { root, slots } = input;
  root.prepend(topBar);
  root.appendChild(statusBar);
  for (const slot of [slots.userBar, slots.voiceWidget]) {
    slot.classList.add("deck-slot");
    statusBar.appendChild(slot);
  }
  try {
    observeBars(
      root,
      new Map([
        [topBar, "--deck-top-measured"],
        [statusBar, "--deck-status-measured"],
      ]),
      owner,
    );
  } catch (err: unknown) {
    log.warn("Command Deck bar sizes are not observed", err);
  }
  mountDirectButton(topBar, input, owner);
  if (input.serverTabs !== undefined && input.serverTabs !== null) {
    mountServerTabs(input.serverTabs, topBar, owner);
  }
  owner.addCleanup(() => {
    root.style.removeProperty("--deck-top-measured");
    root.style.removeProperty("--deck-status-measured");
  });
  return () => owner.destroy();
}
