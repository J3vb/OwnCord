/**
 * Video grid layout: tile sizes, the focused tile and its strip, keyboard focus
 * across rebuilds, full screen and the theatre fallback.
 */
import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { voiceText } from "../../i18n/voice";
import {
  CALL_BAR_SPACE,
  log,
  computeGridLayout,
  isShown,
  isFullscreenKey,
  isSelfCamera,
} from "./gridShared";
import type { GridState, GridApi } from "./gridState";
import type { TileConfig } from "../VideoGrid";

export function createGridLayout(st: GridState, api: GridApi) {
  /** The document the grid is in: the call's pop-out window's, or the app's. */
  function doc(): Document {
    return st.root?.ownerDocument ?? document;
  }

  /** Apply JS-calculated tile sizes to all grid-mode cells. */
  function applyGridSizes(): void {
    const tiles = shownTiles();
    if (st.root === null || st.focusedTileId !== null || tiles.length === 0) return;

    const { width: cw, height: ch } = st.root.getBoundingClientRect();
    if (cw === 0 || ch === 0) return;

    const barSpace = st.callBar !== null ? CALL_BAR_SPACE : 0;
    const layout = computeGridLayout(cw, ch - barSpace, tiles.length);

    for (const el of tiles) {
      el.style.width = `${layout.tileW}px`;
      el.style.height = `${layout.tileH}px`;
    }
  }

  /** Bring the avatar tiles in line with `people` and the open camera tiles:
   *  one per person without a camera tile, reused across updates. */
  function syncPeople(): void {
    const wanted = new Set<number>();
    for (const person of st.people) {
      if (st.cells.has(person.userId)) continue;
      wanted.add(person.userId);
      let cell = st.personCells.get(person.userId);
      if (cell === undefined) {
        cell = createElement("div", {
          class: "video-cell video-cell--avatar",
          "data-person-id": String(person.userId),
        });
        st.personCells.set(person.userId, cell);
      }
      if (cell.firstChild !== person.content) {
        while (cell.firstChild) cell.removeChild(cell.firstChild);
        appendChildren(cell, person.content, createElement("div", { class: "video-username" }));
      }
      const label = cell.querySelector(".video-username");
      if (label !== null) label.textContent = person.label;
    }
    for (const [id, cell] of st.personCells) {
      if (wanted.has(id)) continue;
      cell.remove();
      st.personCells.delete(id);
    }
  }

  /** A tile the call view's toggles hide: avatar tiles without "Show
   *  non-video participants", your own camera without "Show my camera". */
  function hiddenByView(el: HTMLDivElement, config: TileConfig | undefined): boolean {
    if (!st.callView) return false;
    if (el.classList.contains("video-cell--avatar")) return !st.viewOn.nonVideo;
    return !st.viewOn.selfCamera && isSelfCamera(config);
  }

  /** Mark each tile hidden or shown by the view toggles. A focused tile that
   *  is now hidden gives the focus up. */
  function applyViewFilters(): void {
    for (const [id, entry] of st.cells) {
      entry.el.hidden = hiddenByView(entry.el, entry.config);
      if (entry.el.hidden && id === st.focusedTileId) st.focusedTileId = null;
    }
    for (const cell of st.personCells.values()) cell.hidden = hiddenByView(cell, undefined);
  }

  /** The tiles on screen, for sizing. */
  function shownTiles(): HTMLDivElement[] {
    return allTiles().filter((el) => !el.hidden);
  }

  /** Every tile in layout order: streams, then the avatar tiles. */
  function allTiles(): HTMLDivElement[] {
    const tiles = [...st.cells.values()].map((e) => e.el);
    for (const person of st.people) {
      const cell = st.personCells.get(person.userId);
      if (cell !== undefined) tiles.push(cell);
    }
    return tiles;
  }

  /** Re-seat the tiles after a change: people follow the streams. */
  function relayout(): void {
    syncPeople();
    // A focused tile the view toggles hide drops focus: back to the grid.
    const wasFocused = st.focusedTileId !== null;
    applyViewFilters();
    api.applySpeaking();
    api.applyUserAudioState();
    if (st.root === null) return;
    if (wasFocused) {
      rebuildFocusLayout();
      return;
    }
    for (const el of allTiles()) {
      if (el.classList.contains("video-cell--avatar") || el.parentElement !== st.root) {
        beforeChrome(el);
      }
    }
    applyGridSizes();
  }

  /** Schedule a layout recalculation on the next animation frame. */
  function scheduleResize(): void {
    // The grid's own window: the app window can be minimised under a pop-out.
    const view = doc().defaultView ?? window;
    if (st.resizeRafId !== 0) st.rafWindow.cancelAnimationFrame(st.resizeRafId);
    st.rafWindow = view;
    st.resizeRafId = view.requestAnimationFrame(() => {
      st.resizeRafId = 0;
      applyGridSizes();
    });
  }

  /** The tile control the user is currently focused on, if any. `rebuildFocusLayout`
   *  detaches and re-appends every cell (and `removeStream` drops one), which
   *  blurs a focused overlay control to `<body>` — so both capture this first
   *  and restore it after, keeping focus predictable as tiles move or leave
   *  (Q1 focus stability). Keyed on the tile's `data-user-id` and the control's
   *  `data-tile-control` role, not node identity. */
  function captureFocusedControl(): { userId: number; control: string } | null {
    if (st.root === null) return null;
    const active = doc().activeElement;
    if (active === null || !st.root.contains(active)) return null;
    const cell = active.closest(".video-cell");
    const control = (active as HTMLElement).dataset["tileControl"];
    if (cell === null || control === undefined) return null;
    const userId = Number(cell.getAttribute("data-user-id"));
    if (Number.isNaN(userId)) return null;
    return { userId, control };
  }

  /** Put focus back on a captured tile control; when the layout hid it, on
   *  the same tile's way in or out (Back to grid on the focused tile, its
   *  select button elsewhere); when that tile is gone (its peer left), on
   *  the grid itself — so focus never drops to `<body>` or a hidden control
   *  and never lands on another peer's identically named control. */
  function restoreFocusedControl(saved: { userId: number; control: string } | null): void {
    if (saved === null || st.root === null) return;
    const cell = st.root.querySelector(`.video-cell[data-user-id='${saved.userId}']`);
    const way = saved.userId === st.focusedTileId ? "grid" : "select";
    const target = [saved.control, way]
      .map((control) => cell?.querySelector<HTMLElement>(`[data-tile-control='${control}']`))
      .find((el) => el != null && isShown(el));
    (target ?? st.root).focus();
  }

  /** The focused tile needs no "watch" button, and only it offers Back to
   *  grid. */
  function syncTileNav(): void {
    for (const [id, entry] of st.cells) {
      const isMain = id === st.focusedTileId;
      const select = entry.el.querySelector<HTMLElement>(".video-cell-select");
      if (select !== null) select.hidden = isMain;
      const back = entry.el.querySelector<HTMLElement>("[data-tile-control='grid']");
      if (back !== null) back.hidden = !isMain;
    }
  }

  function rebuildFocusLayout(): void {
    if (st.root === null) return;
    const savedFocus = captureFocusedControl();
    syncTileNav();

    if (st.focusedTileId === null || st.cells.size === 0) {
      // No focus — use regular flex-wrap layout. The grid's own controls stay
      // put, so a control the user is on keeps focus.
      for (const child of Array.from(st.root.childNodes)) if (!isChrome(child)) child.remove();
      st.root.classList.remove("focus-mode");
      for (const el of allTiles()) {
        el.classList.remove("focused", "thumb");
        beforeChrome(el);
      }
      appendChrome();
      applyGridSizes();
      restoreFocusedControl(savedFocus);
      return;
    }

    st.root.classList.add("focus-mode");

    // Clear inline sizes on cells (focus mode uses CSS flex sizing)
    for (const el of allTiles()) {
      el.style.width = "";
      el.style.height = "";
    }

    // Main area
    const mainArea =
      st.root.querySelector<HTMLDivElement>(":scope > .video-focus-main") ??
      createElement("div", { class: "video-focus-main" });
    for (const child of Array.from(st.root.childNodes)) {
      if (child !== mainArea && !isChrome(child)) child.remove();
    }
    // Strip area
    const stripArea = createElement("div", { class: "video-focus-strip" });

    const focusedEntry = st.cells.get(st.focusedTileId);
    if (focusedEntry === undefined) {
      mainArea.replaceChildren();
    } else {
      focusedEntry.el.classList.add("focused");
      focusedEntry.el.classList.remove("thumb");
      if (focusedEntry.el.parentNode !== mainArea) mainArea.replaceChildren(focusedEntry.el);
    }

    for (const [id, entry] of st.cells) {
      if (id === st.focusedTileId) continue;
      entry.el.classList.remove("focused");
      entry.el.classList.add("thumb");
      stripArea.appendChild(entry.el);
    }
    for (const el of allTiles()) {
      if (!el.classList.contains("video-cell--avatar")) continue;
      el.classList.add("thumb");
      stripArea.appendChild(el);
    }

    if (mainArea.parentNode !== st.root) beforeChrome(mainArea);
    // Only show strip if there are thumbnails. The call view's toggle hides
    // it rather than detaching it: a detached video pauses.
    const shownThumbs = [...stripArea.children].some((el) => !(el as HTMLElement).hidden);
    if (shownThumbs) {
      stripArea.hidden = st.callView && !st.viewOn.strip;
      beforeChrome(stripArea);
    }
    // Keep the exit control in the DOM (it was stripped with the other
    // children above) and on top, so focus mode is never a dead end.
    appendChrome();

    restoreFocusedControl(savedFocus);
  }

  /** The grid's own controls, after the tiles: the exit control, the view
   *  toggles and the call view's control bar. */
  function appendChrome(): void {
    if (st.root === null) return;
    // In the call view the exit control rides in the view bar.
    for (const el of [st.viewBar === null ? st.exitBtn : null, st.viewBar, st.callBar]) {
      if (el !== null && el.parentNode !== st.root) st.root.appendChild(el);
    }
    api.syncViewBar();
  }

  function isChrome(node: Node): boolean {
    return node === st.exitBtn || node === st.viewBar || node === st.callBar;
  }

  /** Seat a tile (or layout area) after the tiles and before the grid's own
   *  controls, which stay last in tab order. */
  function beforeChrome(el: HTMLElement): void {
    if (st.root === null) return;
    // The trailing run of controls (mount puts the exit control first).
    let anchor: Element | null = null;
    for (
      let c = st.root.lastElementChild;
      c !== null && isChrome(c);
      c = c.previousElementSibling
    ) {
      anchor = c;
    }
    st.root.insertBefore(el, anchor);
  }

  function setFocusedTile(tileId: number | null): void {
    const watching = st.fullscreenTile ?? st.theatreTile;
    if (watching !== null && watching !== tileId) leaveFullscreen();
    st.focusedTileId = tileId;
    rebuildFocusLayout();
    api.syncStatsPolling();
    api.syncViews();
  }

  // --- Full screen -----------------------------------------------------------

  function isFullscreen(tileId: number): boolean {
    return st.fullscreenTile === tileId || st.theatreTile === tileId;
  }

  function toggleFullscreen(tileId: number): void {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    if (isFullscreen(tileId)) {
      leaveFullscreen();
      return;
    }
    if (st.focusedTileId !== tileId) setFocusedTile(tileId);
    // A popped-out stream comes back for full screen in the app window (its
    // own window has a full-screen control of its own).
    entry.popout?.close();
    const request = entry.el.requestFullscreen as (() => Promise<void>) | undefined;
    if (typeof request !== "function") {
      enterTheatre(tileId);
      return;
    }
    // The fullscreenchange listener draws the result; a refusal falls back
    // to a window-filling view.
    request.call(entry.el).catch(() => enterTheatre(tileId));
  }

  function leaveFullscreen(): void {
    if (st.theatreTile !== null) {
      leaveTheatre();
      return;
    }
    const d = doc();
    if (d.fullscreenElement !== null && d.fullscreenElement !== undefined) {
      void d.exitFullscreen().catch((err: unknown) => {
        log.debug("Exit full screen failed", { err });
      });
    }
  }

  function enterTheatre(tileId: number): void {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    st.theatreTile = tileId;
    entry.el.classList.add("video-cell--theatre");
    syncFullscreenUi();
    windowFullscreen(true);
  }

  function leaveTheatre(): void {
    const entry = st.theatreTile === null ? undefined : st.cells.get(st.theatreTile);
    entry?.el.classList.remove("video-cell--theatre");
    st.theatreTile = null;
    syncFullscreenUi();
    windowFullscreen(false);
  }

  /** Escape or F leaves the theatre fallback wherever focus is: a click on the
   *  video moves it to the grid, outside the tile (HTML full screen handles
   *  its own Escape). A tile's F handler has already acted when it prevented
   *  the default. */
  function onTheatreKey(e: KeyboardEvent): void {
    if (st.theatreTile === null || e.defaultPrevented) return;
    if (e.key === "Escape" && isImeCommit(e)) return;
    if (e.key !== "Escape" && !isFullscreenKey(e)) return;
    e.preventDefault();
    leaveTheatre();
  }

  function onFullscreenChange(): void {
    const el = doc().fullscreenElement ?? null;
    let next: number | null = null;
    for (const [id, entry] of st.cells) if (entry.el === el) next = id;
    const was = st.fullscreenTile;
    st.fullscreenTile = next;
    if (was === next) return;
    syncFullscreenUi();
    windowFullscreen(next !== null);
  }

  /** Label the full-screen buttons and give a full-screen tile the call
   *  controls, so you can mute or leave without leaving full screen. */
  function syncFullscreenUi(): void {
    for (const [id, entry] of st.cells) {
      const on = isFullscreen(id);
      const btn = entry.el.querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']");
      if (btn !== null) {
        const text = on ? voiceText("tile.exitFullscreen") : voiceText("tile.fullscreen");
        btn.setAttribute("aria-label", text);
        btn.title = text;
        btn.querySelector("svg")?.remove();
        btn.appendChild(createIcon(on ? "minimize" : "maximize", 18));
      }
      const calls = entry.el.querySelector(".video-fs-calls");
      if (on && calls === null && st.callbacks.callControls !== undefined) {
        entry.el.appendChild(api.buildCallControls(st.callbacks.callControls));
      } else if (!on) {
        calls?.remove();
      }
    }
    api.syncStatsPolling();
    api.syncViews();
  }

  /** Watch the grid's sizes with its own window's observer: the pop-out's
   *  layout runs there. */
  function observeGrid(): void {
    st.resizeObserver?.disconnect();
    if (st.root === null) return;
    const Observer = doc().defaultView?.ResizeObserver ?? ResizeObserver;
    st.resizeObserver = new Observer(() => {
      scheduleResize();
      api.scheduleViewSync();
    });
    st.resizeObserver.observe(st.root);
    for (const entry of st.cells.values()) {
      if (entry.config !== undefined && !entry.config.isSelf) st.resizeObserver.observe(entry.el);
    }
  }

  /** The full-screen state of the window the grid is in. */
  function windowFullscreen(on: boolean): void {
    const args: [boolean, string?] = st.callPop === null ? [on] : [on, st.callPop.label];
    void st.callbacks.setWindowFullscreen?.(...args).catch(() => {});
  }

  /** Full screen ends where the grid leaves its window. */
  function dropFullscreen(): void {
    if (st.theatreTile !== null) leaveTheatre();
    if (st.fullscreenTile === null) return;
    leaveFullscreen();
    st.fullscreenTile = null;
    syncFullscreenUi();
    windowFullscreen(false);
  }

  return {
    doc,
    applyGridSizes,
    syncPeople,
    hiddenByView,
    applyViewFilters,
    shownTiles,
    allTiles,
    relayout,
    scheduleResize,
    captureFocusedControl,
    restoreFocusedControl,
    syncTileNav,
    rebuildFocusLayout,
    appendChrome,
    isChrome,
    beforeChrome,
    setFocusedTile,
    isFullscreen,
    toggleFullscreen,
    leaveFullscreen,
    enterTheatre,
    leaveTheatre,
    onTheatreKey,
    onFullscreenChange,
    syncFullscreenUi,
    observeGrid,
    windowFullscreen,
    dropFullscreen,
  };
}
