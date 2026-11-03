/**
 * The composer's "+": a menu of tiles. On a phone it is a bottom sheet with
 * Take photo, Gallery and Files, each backed by its own hidden file input so
 * the phone opens its camera, its photo picker or its file manager. Elsewhere
 * it is a small grid above the chat bar that starts with Upload. Every file
 * tile hands the chosen files to the same upload path. The owner adds tiles
 * of its own after those (Poll, Sticker), so the chat bar keeps only what is
 * used most.
 */

import { appendChildren, createElement, setOwnedTimeout } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon, type IconName } from "@lib/icons";
import { isImeCommit } from "@lib/text/ime";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";
import { isPhoneLayout, openBottomSheet } from "@lib/ui/bottomSheet";
import { messagingText } from "../../i18n/messaging";

export type AttachSource = "camera" | "gallery" | "files";

/** A tile that is not a file source: it runs its own action. */
export interface AttachAction {
  /** Names the tile's test id, `attach-sheet-<id>`. */
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  /** Read when the menu opens: false leaves the tile out. */
  readonly available: () => boolean;
  /** Only in this layout; in both when left out. */
  readonly layout?: "phone" | "desktop";
  readonly run: () => void;
}

export interface AttachPickersOptions {
  readonly onFile: (file: File) => void;
  /** Read at tap time: false when attaching is off (gated, or uploads disabled). */
  readonly canAttach: () => boolean;
  /** The composer's lifetime: listeners go, and an open menu closes. */
  readonly signal: AbortSignal;
  /** Tiles after the file sources. */
  readonly actions?: readonly AttachAction[];
  /** Where the desktop menu mounts; it sits above this element's top edge. */
  readonly menuHost?: () => HTMLElement | null;
}

export interface AttachPickers {
  /** Hidden inputs for the owner to mount; the Files one comes first. */
  readonly inputs: readonly HTMLInputElement[];
  /** The "+" button: opens the menu, or closes it when it is open. `trigger`
   *  gets focus back when the desktop menu closes with Escape. */
  open(trigger?: HTMLElement): void;
  /** Closes an open menu (a no-op when none is open). */
  close(): void;
  /** Whether the menu has a tile besides the file sources right now. */
  hasActions(): boolean;
  /** Straight to the file picker, whatever the layout. */
  openFiles(): void;
}

const PHONE_SOURCES: readonly { source: AttachSource; icon: IconName }[] = [
  { source: "camera", icon: "camera" },
  { source: "gallery", icon: "image" },
  { source: "files", icon: "file-text" },
];

const INPUT_ATTRS: Record<AttachSource, Record<string, string>> = {
  files: { multiple: "" },
  camera: { accept: "image/*", capture: "environment" },
  gallery: { accept: "image/*,video/*", multiple: "" },
};

const LABEL_KEYS = {
  camera: "attach.camera",
  gallery: "attach.gallery",
  files: "attach.files",
} as const;

const DESKTOP_COLUMNS = 2;

interface Tile {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly run: () => void;
}

/** One tile button; `close` runs before the tile's own action. */
function tileButton(tile: Tile, close: () => void, tileSignal: AbortSignal): HTMLButtonElement {
  const badge = createElement("span", {
    class: `attach-sheet-icon attach-sheet-icon-${tile.id}`,
    "aria-hidden": "true",
  });
  badge.appendChild(createIcon(tile.icon, 22));
  const btn = createElement("button", {
    type: "button",
    class: "attach-sheet-tile",
    "data-testid": `attach-sheet-${tile.id}`,
  });
  appendChildren(btn, badge, createElement("span", {}, tile.label));
  // The tile's signal ends on close, so a second tap runs nothing.
  btn.addEventListener(
    "click",
    () => {
      close();
      tile.run();
    },
    { signal: tileSignal },
  );
  return btn;
}

export function createAttachPickers(options: AttachPickersOptions): AttachPickers {
  const { onFile, canAttach, signal } = options;
  const actions = options.actions ?? [];
  const liveActions = (phone: boolean): AttachAction[] =>
    actions.filter(
      (a) =>
        (a.layout === undefined || a.layout === (phone ? "phone" : "desktop")) && a.available(),
    );

  function makeInput(source: AttachSource): HTMLInputElement {
    const input = createElement("input", {
      type: "file",
      style: "display: none;",
      "data-attach-source": source,
      ...INPUT_ATTRS[source],
    });
    input.addEventListener(
      "change",
      () => {
        // Copied first: clearing the value empties the live FileList.
        const files = [...(input.files ?? [])];
        input.value = "";
        for (const file of files) onFile(file);
      },
      { signal },
    );
    return input;
  }

  const bySource: Record<AttachSource, HTMLInputElement> = {
    files: makeInput("files"),
    camera: makeInput("camera"),
    gallery: makeInput("gallery"),
  };

  const pickSource = (source: AttachSource) => () => {
    if (canAttach()) bySource[source].click();
  };

  /** The tiles on offer right now; with uploads off the file tiles go. */
  function tilesFor(phone: boolean): Tile[] {
    const tiles: Tile[] = [];
    if (canAttach()) {
      if (phone) {
        for (const { source, icon } of PHONE_SOURCES) {
          tiles.push({
            id: source,
            icon,
            label: messagingText(LABEL_KEYS[source]),
            run: pickSource(source),
          });
        }
      } else {
        tiles.push({
          id: "files",
          icon: "file-text",
          label: messagingText("attach.upload"),
          run: pickSource("files"),
        });
      }
    }
    for (const action of liveActions(phone)) {
      tiles.push({
        id: action.id,
        icon: action.icon,
        label: action.label,
        run: () => {
          if (action.available()) action.run();
        },
      });
    }
    return tiles;
  }

  /** The open menu's teardown, or null when none is open. */
  let closeOpen: (() => void) | null = null;

  function openSheet(tiles: readonly Tile[]): void {
    const grid = createElement("div", { class: "attach-sheet" });
    const sheet = openBottomSheet({
      label: messagingText("attach.sheetLabel"),
      content: grid,
      className: "attach-sheet-panel",
      testId: "attach-sheet",
      signal,
      onClosed: () => {
        if (closeOpen === closeSheet) closeOpen = null;
      },
    });
    const closeSheet = (): void => {
      closeOpen = null;
      sheet.close();
    };
    closeOpen = closeSheet;
    for (const tile of tiles) grid.appendChild(tileButton(tile, closeSheet, sheet.signal));
  }

  function openMenu(tiles: readonly Tile[], host: HTMLElement, trigger?: HTMLElement): void {
    const life = new Disposable();
    signal.addEventListener("abort", () => life.destroy(), { signal: life.signal });
    const menu = createElement("div", {
      class: "attach-menu",
      role: "menu",
      "aria-label": messagingText("attach.sheetLabel"),
      "data-testid": "attach-sheet",
    });
    const closeMenu = (returnFocus = false): void => {
      if (closeOpen === closeNow) closeOpen = null;
      life.destroy();
      menu.remove();
      if (returnFocus) trigger?.focus();
    };
    const closeNow = (): void => closeMenu();
    closeOpen = closeNow;
    for (const tile of tiles) {
      const btn = tileButton(tile, closeNow, life.signal);
      btn.setAttribute("role", "menuitem");
      menu.appendChild(btn);
    }
    host.appendChild(menu);
    setRovingTabindex(menu, ".attach-sheet-tile");
    enableRovingNavigation(menu, ".attach-sheet-tile", life.signal, "grid", DESKTOP_COLUMNS);
    menu.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || isImeCommit(e)) return;
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      },
      { signal: life.signal },
    );
    menu.querySelector<HTMLElement>(".attach-sheet-tile")?.focus();
    // Deferred so the click that opened the menu does not close it at once.
    setOwnedTimeout(
      life.signal,
      () =>
        document.addEventListener(
          "mousedown",
          (e) => {
            const target = e.target as Node;
            if (menu.contains(target) || trigger?.contains(target) === true) return;
            closeMenu();
          },
          { signal: life.signal },
        ),
      0,
    );
  }

  return {
    inputs: [bySource.files, bySource.camera, bySource.gallery],
    open: (trigger) => {
      if (closeOpen !== null) {
        closeOpen();
        return;
      }
      const phone = isPhoneLayout();
      const tiles = tilesFor(phone);
      if (tiles.length === 0) return;
      if (phone) {
        openSheet(tiles);
        return;
      }
      const host = options.menuHost?.() ?? null;
      if (host !== null) openMenu(tiles, host, trigger);
      else if (canAttach()) bySource.files.click();
    },
    close: () => closeOpen?.(),
    hasActions: () => liveActions(isPhoneLayout()).length > 0,
    openFiles: () => {
      if (canAttach()) bySource.files.click();
    },
  };
}
