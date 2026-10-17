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
 * This controller is the only writer of the toggle's `hidden` and
 * `aria-pressed`.
 */

import { Disposable } from "@lib/disposable";
import { loadPref, savePref } from "@lib/preferences";
import { channelsStore, getActiveChannel } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import type { MemberPanel } from "../../features/members/memberPanel";
import { loadMemberLayout, MEMBER_OPEN_PREF } from "../../features/members/memberLayout";

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
  /** Flip and remember the open pref. */
  toggle(): void;
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

  function sync(): void {
    if (destroyed) return;
    const right = loadMemberLayout() === "right";
    const onScreen = guildChannelOnScreen();
    const shown =
      right &&
      onScreen &&
      uiStore.getState().activeView === null &&
      loadPref<boolean>(MEMBER_OPEN_PREF, true);
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

  owner.onStoreChange(
    channelsStore,
    (s) => s.activeChannelId,
    () => sync(),
  );
  owner.onStoreChange(
    uiStore,
    (s) => s.sidebarMode,
    () => sync(),
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

  return {
    sync,
    toggle(): void {
      if (destroyed) return;
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
    },
  };
}
