/**
 * Keyboard support for a flat tree: every row is its own `role="treeitem"`
 * under one `role="tree"`, and the hierarchy is stamped from DOM order rather
 * than nested, so a row that joins or leaves rebuilds no sibling.
 *
 * Views draw three things on an item and nothing else: `role`,
 * `data-tree-kind` (`head` folds, `row` opens, `child` hangs under the row
 * before it) and `tabindex="-1"`. `data-tree-group` on a container puts the
 * rows inside it one level under their header. `refresh()` stamps
 * `aria-level`, `aria-setsize` and `aria-posinset` and keeps exactly one item
 * tabbable; the keys walk the items the way a file tree is walked.
 *
 * Nothing here reads a class name, owns a timer or touches a store.
 */

import { setRovingTabindex } from "./a11y";
import { isTypedCharacter } from "./typeAhead";

const ITEM = "[role=treeitem]";
const TYPE_AHEAD_RESET_MS = 500;
const NAME_PARTS = ".ch-name, .vu-name, .dm-nav-row-label";

export interface TreeNavigation {
  /** Stamp levels and sets and repair the Tab stop. Call after every render of the rows. */
  readonly refresh: () => void;
}

interface Placed {
  readonly item: HTMLElement;
  readonly level: number;
  readonly parent: HTMLElement | null;
}

/** Write an attribute only when its value differs, so an unchanged tree causes no writes. */
function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function levelOf(item: HTMLElement, tree: HTMLElement, lastRowLevel: number): number {
  const kind = item.dataset.treeKind;
  if (kind === "head") return 1;
  if (kind === "child") return lastRowLevel + 1;
  const group = item.closest("[data-tree-group]");
  return group !== null && tree.contains(group) && group !== tree ? 2 : 1;
}

/** Each item with its level and its tree parent: the nearest earlier item at a lower level, never the DOM parent. */
function place(tree: HTMLElement, items: readonly HTMLElement[]): Placed[] {
  const placed: Placed[] = [];
  const open: Placed[] = [];
  let lastRowLevel = 1;
  for (const item of items) {
    const level = levelOf(item, tree, lastRowLevel);
    if (item.dataset.treeKind !== "child") lastRowLevel = level;
    while (open.length > 0 && open[open.length - 1]!.level >= level) open.pop();
    const entry: Placed = { item, level, parent: open[open.length - 1]?.item ?? null };
    placed.push(entry);
    open.push(entry);
  }
  return placed;
}

function stampSets(placed: readonly Placed[]): void {
  // One set per (tree parent, level); level-1 items have no parent and share one.
  const sets = new Map<HTMLElement | null, Map<number, HTMLElement[]>>();
  for (const { item, level, parent } of placed) {
    const byLevel = sets.get(parent) ?? new Map<number, HTMLElement[]>();
    sets.set(parent, byLevel);
    const members = byLevel.get(level) ?? [];
    byLevel.set(level, members);
    members.push(item);
  }
  for (const byLevel of sets.values()) {
    for (const members of byLevel.values()) {
      members.forEach((item, i) => {
        setAttr(item, "aria-setsize", String(members.length));
        setAttr(item, "aria-posinset", String(i + 1));
      });
    }
  }
}

/** The text a type-ahead matches: the labelling element, else the name part, else the row's text. */
function itemName(item: HTMLElement): string {
  const labelledBy = item.getAttribute("aria-labelledby");
  const labelEl = labelledBy === null ? null : item.ownerDocument.getElementById(labelledBy);
  const raw = (labelEl ?? item.querySelector(NAME_PARTS) ?? item).textContent ?? "";
  return raw.trim().replace(/^#/, "").toLowerCase();
}

const levelAt = (item: HTMLElement | undefined): number =>
  Number(item?.getAttribute("aria-level") ?? 0);

/** The tree parent of `item`: the nearest earlier item at a lower level. */
function parentOf(all: readonly HTMLElement[], item: HTMLElement): HTMLElement | undefined {
  const level = levelAt(item);
  for (let i = all.indexOf(item) - 1; i >= 0; i--) {
    if (levelAt(all[i]) < level) return all[i];
  }
  return undefined;
}

export function enableTreeNavigation(tree: HTMLElement, signal: AbortSignal): TreeNavigation {
  /** The one tabbable item, remembered so an unchanged tree is not rewritten. */
  let stop: HTMLElement | null = null;
  let buffer = "";
  let lastKeyAt = Number.NEGATIVE_INFINITY;

  const items = (): HTMLElement[] => Array.from(tree.querySelectorAll<HTMLElement>(ITEM));

  function setStop(item: HTMLElement): void {
    if (stop !== null && stop !== item && stop.isConnected) stop.setAttribute("tabindex", "-1");
    setAttr(item, "tabindex", "0");
    stop = item;
  }

  function moveTo(item: HTMLElement | undefined): void {
    if (item === undefined) return;
    setStop(item);
    item.focus();
  }

  function refresh(): void {
    const all = items();
    const placed = place(tree, all);
    for (const { item, level } of placed) setAttr(item, "aria-level", String(level));
    stampSets(placed);
    if (stop !== null && stop.isConnected && tree.contains(stop) && stop.tabIndex === 0) return;
    setRovingTabindex(tree, ITEM);
    stop = all.find((item) => item.getAttribute("tabindex") === "0") ?? null;
  }

  function onRight(all: readonly HTMLElement[], item: HTMLElement): void {
    if (item.dataset.treeKind === "head" && item.getAttribute("aria-expanded") === "false") {
      item.click();
      return;
    }
    const next = all[all.indexOf(item) + 1];
    if (next !== undefined && levelAt(next) > levelAt(item)) moveTo(next);
  }

  function onLeft(all: readonly HTMLElement[], item: HTMLElement): void {
    if (item.dataset.treeKind === "head" && item.getAttribute("aria-expanded") === "true") {
      item.click();
      return;
    }
    moveTo(parentOf(all, item));
  }

  function typeAhead(all: readonly HTMLElement[], item: HTMLElement, e: KeyboardEvent): void {
    buffer = e.timeStamp - lastKeyAt > TYPE_AHEAD_RESET_MS ? e.key : buffer + e.key;
    lastKeyAt = e.timeStamp;
    const wanted = buffer.toLowerCase();
    const from = all.indexOf(item);
    // After the focused row first, wrapping, and the focused row last.
    for (let step = 1; step <= all.length; step++) {
      const candidate = all[(from + step) % all.length]!;
      if (itemName(candidate).startsWith(wanted)) {
        moveTo(candidate);
        return;
      }
    }
  }

  /** Move or act for a navigation key; false for a key this tree does not handle. */
  function handleKey(all: readonly HTMLElement[], item: HTMLElement, key: string): boolean {
    const at = all.indexOf(item);
    switch (key) {
      case "Enter":
      case " ":
        item.click();
        return true;
      case "ArrowDown":
        moveTo(all[at + 1]);
        return true;
      case "ArrowUp":
        moveTo(all[at - 1]);
        return true;
      case "Home":
        moveTo(all[0]);
        return true;
      case "End":
        moveTo(all[all.length - 1]);
        return true;
      case "ArrowRight":
        onRight(all, item);
        return true;
      case "ArrowLeft":
        onLeft(all, item);
        return true;
      default:
        return false;
    }
  }

  tree.addEventListener(
    "keydown",
    (e) => {
      const item = e.target;
      // Only the rows themselves: Enter on a nested control is that control's.
      if (!(item instanceof HTMLElement) || !item.matches(ITEM)) return;
      // A handler that already acted (a voice user's own Enter) has had its say.
      if (e.defaultPrevented) return;
      // AltGr (Ctrl+Alt on Windows) types characters, so typed keys are checked on their own.
      if (isTypedCharacter(e)) {
        if (e.key !== " ") typeAhead(items(), item, e);
        else if (!e.altKey && !e.ctrlKey && handleKey(items(), item, e.key)) e.preventDefault();
        return;
      }
      // Alt+Up/Down still steps channels and Ctrl+Enter does nothing here.
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (handleKey(items(), item, e.key)) e.preventDefault();
    },
    { signal },
  );

  // A mouse focus moves the Tab stop to the row, so the focused row is always the tabbable one.
  tree.addEventListener(
    "focusin",
    (e) => {
      const item = e.target instanceof Element ? e.target.closest<HTMLElement>(ITEM) : null;
      if (item !== null && tree.contains(item)) setStop(item);
    },
    { signal },
  );

  return { refresh };
}
