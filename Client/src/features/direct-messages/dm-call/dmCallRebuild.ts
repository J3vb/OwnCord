/** Redraws the DM call panel's structure for the current view. */
import type { DmCallState, DmCallApi } from "./dmCallState";
import { callName, currentUserId } from "../DmCallViewModel";
import { dmCallText as d } from "../../../i18n/dmCall";

const VIEW_CLASSES = [
  "dm-call-panel--expanded",
  "dm-call-panel--collapsed",
  "dm-call-panel--strip",
  "dm-call-panel--video",
] as const;

export function createDmCallRebuild(st: DmCallState, dc: DmCallApi, applyHeight: () => void) {
  /** Drop the last render: its nodes, its per-render references and its classes. */
  function clearRender(): void {
    for (const child of Array.from(st.body.childNodes)) if (child !== st.videoEl) child.remove();
    for (const ref of st.avatars.values()) ref.verify?.remove();
    st.focusedShield = null;
    st.avatars = new Map();
    st.people = [];
    st.controls = { mute: null, deafen: null, camera: null, share: null };
    st.statusEl = null;
    st.secured = null;
    st.speakingEl = null;
    st.timerEls = [];
    st.root.classList.remove(...VIEW_CLASSES);
  }

  function renderView(): void {
    switch (st.view.kind) {
      case "none":
        break;
      case "incoming":
        dc.renderIncoming(st.view);
        break;
      case "live":
        dc.renderLive(st.view);
        break;
      case "outgoing":
        dc.renderOutgoing(st.view);
        break;
      case "unanswered":
        dc.renderUnanswered(st.view);
        break;
      case "connected":
        dc.renderConnected(st.view);
        break;
    }
  }

  function labelRegion(): void {
    if (st.view.kind === "none") st.root.removeAttribute("aria-label");
    else
      st.root.setAttribute(
        "aria-label",
        d("region", { name: callName(st.view.dm, currentUserId()) }),
      );
    st.root.dataset.state = st.view.kind;
  }

  /** Put keyboard focus back on the control that had it; failing that, on the region. */
  function restoreFocus(active: HTMLElement, focusId: string): void {
    const same =
      active.isConnected && st.videoEl.contains(active)
        ? active
        : focusId === ""
          ? null
          : st.body.querySelector<HTMLElement>(`[data-testid="${focusId}"]`);
    if (same !== null) same.focus();
    else if (!st.root.hidden) st.root.focus();
  }

  function rebuild(): void {
    // Keep keyboard focus on the same control across a rebuild (a mute click
    // must not drop focus to <body>); fall back to the region itself.
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && st.root.contains(active);
    const focusId = hadFocus ? (active.dataset.testid ?? "") : "";

    clearRender();
    renderView();
    if (!st.root.classList.contains("dm-call-panel--video")) st.videoEl.remove();
    if (st.people.length > 0 || st.peopleGiven) {
      st.options.videoGrid?.setPeople(st.people);
      st.peopleGiven = st.people.length > 0;
    }
    st.root.hidden = st.view.kind === "none";
    // After the reveal, so the separator's value is measured from a drawn panel.
    applyHeight();
    labelRegion();
    if (hadFocus) restoreFocus(active, focusId);
  }

  return { rebuild };
}
