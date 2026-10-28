/**
 * MemberColumn: the controller for the right-hand member column (3C-6b).
 *
 * MainPage always builds the `<aside id="member-column">` (so the header
 * toggle's `aria-controls` resolves) and loads this controller on demand. The
 * column holds a member panel only while it is shown: a hidden column has no
 * instance and no store subscriptions. MemberList keeps module-level popup
 * state, so there is one panel at a time across both layouts; the layout
 * handler in MainPage destroys the outgoing host's panel before this one
 * builds its own.
 *
 * 3C-6c adds the width handle (200-360 px, dragged or keyboard, saved) and the
 * narrow-window overlay: below 900 CSS px the column is a fixed panel the
 * toggle opens for the moment (never saved), so the chat keeps its room.
 *
 * While the call view is up in this window, or a forum is on screen, the
 * column steps aside so the call or the posts get the width: the toggle opens
 * it for the moment (never saved), and leaving puts the saved choice back.
 *
 * This controller is the only writer of the toggle's `hidden` and
 * `aria-pressed`.
 */

import { isImeCommit } from "@lib/ime";
import { Disposable } from "@lib/disposable";
import { loadPref, savePref } from "@lib/preferences";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import type { MemberPanel } from "../../features/members/memberPanel";
import {
  clampMemberWidth,
  loadMemberLayout,
  MEMBER_OPEN_PREF,
  MEMBER_WIDTH_DEFAULT,
  MEMBER_WIDTH_MAX,
  MEMBER_WIDTH_MIN,
  MEMBER_WIDTH_PREF,
} from "../../features/members/memberLayout";
import { shellText } from "../../i18n/shell";

/** Below this the column is an overlay. Keep in step with `member-list.css`. */
const NARROW_QUERY = "(max-width: 899px)";
const KEY_STEP = 16;

export interface MemberColumnOptions {
  /** The `<aside id="member-column">`. */
  readonly column: HTMLElement;
  /** The scroller inside it that holds the panel. */
  readonly body: HTMLElement;
  /** The header's "Member List" toggle. */
  readonly button: HTMLButtonElement;
  /** The one factory every host builds its panel through
   *  (`SidebarArea.buildMemberPanel`). */
  readonly buildPanel: () => MemberPanel;
  /** Where to put focus when the panel hides with focus inside it. */
  readonly fallbackFocus?: () => HTMLElement | null;
}

export interface MemberColumn {
  /** Re-read the layout, the open pref and the screen state, then show or hide. */
  sync(): void;
  /** Flip and remember the open pref; in the narrow overlay, flip the
   *  transient state and save nothing. */
  toggle(): void;
  /** Close the narrow overlay (the sidebar drawer opening). No-op otherwise. */
  closeOverlay(): void;
  /** The call view is up in this window (on) or gone (off). */
  setCallView(on: boolean): void;
  destroy(): void;
}

/** A guild channel (not a DM) is on screen in channels mode. */
function guildChannelOnScreen(): boolean {
  const active = getActiveChannel();
  return active !== null && active.type !== "dm" && uiStore.getState().sidebarMode === "channels";
}

export function createMemberColumn(opts: MemberColumnOptions): MemberColumn {
  const { column, body, button } = opts;
  const owner = new Disposable();
  let panel: MemberPanel | null = null;
  let destroyed = false;
  // jsdom has no matchMedia; without one the column is never an overlay.
  const narrow = typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
  let narrowOpen = false;
  let callView = false;
  /** Opened from the toggle while the column steps aside; not saved. */
  let asideOpen = false;

  // --- Width handle ---
  let width = clampMemberWidth(loadPref<number>(MEMBER_WIDTH_PREF, MEMBER_WIDTH_DEFAULT));
  const handle = document.createElement("div");
  handle.className = "member-column-resize";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", shellText("members.resize"));
  handle.setAttribute("aria-valuemin", String(MEMBER_WIDTH_MIN));
  handle.setAttribute("aria-valuemax", String(MEMBER_WIDTH_MAX));
  handle.setAttribute("aria-controls", "member-column");
  handle.tabIndex = 0;
  column.prepend(handle);

  function applyWidth(next: number): void {
    width = clampMemberWidth(next);
    column.style.width = `${width}px`;
    handle.setAttribute("aria-valuenow", String(width));
  }
  applyWidth(width);

  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragPointer: number | null = null;

  function endDrag(e: PointerEvent): void {
    if (dragPointer === null || e.pointerId !== dragPointer) return;
    dragPointer = null;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      // Capture was already released (the pointer went away).
    }
    savePref(MEMBER_WIDTH_PREF, width);
  }

  owner.onEvent(handle, "pointerdown", (e) => {
    if (e.button !== 0 || dragPointer !== null) return;
    e.preventDefault();
    dragPointer = e.pointerId;
    dragStartX = e.clientX;
    dragStartWidth = width;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // No capture available: the drag still tracks moves over the handle.
    }
  });
  owner.onEvent(handle, "pointermove", (e) => {
    if (dragPointer === null || e.pointerId !== dragPointer) return;
    // Dragging left makes the column wider.
    applyWidth(dragStartWidth + dragStartX - e.clientX);
  });
  owner.onEvent(handle, "pointerup", endDrag);
  owner.onEvent(handle, "pointercancel", endDrag);
  // Hiding the column mid-drag drops capture and the pointerup never arrives.
  owner.onEvent(handle, "lostpointercapture", endDrag);
  owner.onEvent(handle, "keydown", (e) => {
    let next: number;
    if (e.key === "ArrowLeft") next = width + KEY_STEP;
    else if (e.key === "ArrowRight") next = width - KEY_STEP;
    else if (e.key === "Home") next = MEMBER_WIDTH_MIN;
    else if (e.key === "End") next = MEMBER_WIDTH_MAX;
    else return;
    e.preventDefault();
    applyWidth(next);
    savePref(MEMBER_WIDTH_PREF, width);
  });

  function focusSearch(): void {
    body.querySelector<HTMLElement>('[data-testid="member-search"]')?.focus();
  }

  /** The call view or a forum wants the width. */
  function stepsAside(): boolean {
    return callView || getActiveChannel()?.type === "forum";
  }

  function sync(): void {
    if (destroyed) return;
    const right = loadMemberLayout() === "right";
    const onScreen = guildChannelOnScreen();
    const overlay = narrow?.matches === true;
    if (!right || !onScreen) narrowOpen = false;
    const wanted = overlay
      ? narrowOpen
      : stepsAside()
        ? asideOpen
        : loadPref<boolean>(MEMBER_OPEN_PREF, true);
    const shown = right && onScreen && uiStore.getState().activeView === null && wanted;
    button.hidden = !(right && onScreen);
    button.setAttribute("aria-pressed", String(shown));
    if (shown) {
      if (panel === null) {
        panel = opts.buildPanel();
        body.appendChild(panel.element);
      }
      column.hidden = false;
      return;
    }
    if (panel !== null) {
      const focusInside = column.contains(document.activeElement);
      panel.destroy();
      panel.element.remove();
      panel = null;
      column.hidden = true;
      if (focusInside) opts.fallbackFocus?.();
      return;
    }
    column.hidden = true;
  }

  // A channel or DM switch, or a mode change, dismisses the overlay.
  owner.onStoreChange(
    channelsStore,
    (s) => s.activeChannelId,
    () => {
      narrowOpen = false;
      asideOpen = false;
      sync();
    },
  );
  owner.onStoreChange(
    uiStore,
    (s) => s.sidebarMode,
    () => {
      narrowOpen = false;
      sync();
    },
  );
  owner.onStoreChange(
    uiStore,
    (s) => s.activeView,
    () => sync(),
  );
  // The layout key is deliberately not listened to here: MainPage's one layout
  // handler orders the destroy of one host before the create of the other.
  window.addEventListener(
    "owncord:pref-change",
    (e) => {
      const key = e instanceof CustomEvent ? (e.detail as { key?: string } | null)?.key : undefined;
      if (key === MEMBER_OPEN_PREF) sync();
    },
    { signal: owner.signal },
  );

  narrow?.addEventListener(
    "change",
    () => {
      narrowOpen = false;
      sync();
    },
    { signal: owner.signal },
  );
  // Capture phase: the member search clears itself on Escape, and this must
  // read it before that, so a first Escape clears and a second one closes.
  owner.onEvent(
    column,
    "keydown",
    (e) => {
      if (e.key !== "Escape" || isImeCommit(e) || narrow?.matches !== true || !narrowOpen) return;
      const search = body.querySelector<HTMLInputElement>('[data-testid="member-search"]');
      if (search !== null && search.value !== "") return;
      e.preventDefault();
      e.stopPropagation();
      narrowOpen = false;
      // Focus first, so the hide does not also run the fallback.
      button.focus();
      sync();
    },
    { capture: true },
  );

  return {
    sync,
    closeOverlay(): void {
      if (destroyed || !narrowOpen) return;
      narrowOpen = false;
      sync();
    },
    setCallView(on: boolean): void {
      if (destroyed || callView === on) return;
      callView = on;
      asideOpen = false;
      sync();
    },
    toggle(): void {
      if (destroyed) return;
      if (narrow?.matches === true) {
        narrowOpen = !narrowOpen;
        sync();
        if (narrowOpen) focusSearch();
        return;
      }
      if (stepsAside()) {
        asideOpen = !asideOpen;
        sync();
        if (asideOpen) focusSearch();
        return;
      }
      savePref(MEMBER_OPEN_PREF, !loadPref<boolean>(MEMBER_OPEN_PREF, true));
      // savePref dispatched pref-change, which already ran sync(); this one is
      // a no-op unless storage is unavailable, where the pref cannot change.
      sync();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      panel?.destroy();
      panel?.element.remove();
      panel = null;
      owner.destroy();
      handle.remove();
    },
  };
}
