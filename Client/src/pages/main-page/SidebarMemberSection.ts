/**
 * SidebarMemberSection — the collapsible member list panel that sits below
 * channels in "channels" mode. Supports drag-to-resize and persists
 * collapsed state and height to localStorage.
 */

import { Disposable } from "@lib/disposable";
import { readStored, writeStored } from "@lib/preferences";
import { createElement, appendChildren } from "@lib/dom";
import { createMemberList } from "@components/MemberList";
import { buildVoiceModOptions } from "@components/ChannelSidebar";
import { shellText } from "../../i18n/shell";
import {
  createMemberPanel,
  type MemberPanel,
  type MemberPanelOptions,
  type MemberPanelUi,
} from "../../features/members/memberPanel";

/** The UI-layer pieces every member panel host hands to `createMemberPanel`. */
export const memberPanelUi: MemberPanelUi = {
  createMemberList: (...args) => createMemberList(...args),
  buildVoiceModOptions: (...args) => buildVoiceModOptions(...args),
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LS_KEY_HEIGHT = "owncord:member-list-height";
const LS_KEY_COLLAPSED = "owncord:member-list-collapsed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidebarMemberSectionOptions extends Omit<MemberPanelOptions, "ui"> {
  /** Builds the member panel this section hosts. SidebarArea passes its single
   *  `buildMemberPanel` factory so the callback wiring exists once; without it
   *  the section builds one from the callbacks above. */
  readonly buildPanel?: () => MemberPanel;
}

export interface SidebarMemberSectionResult {
  /** The root element to insert into the DOM. */
  readonly element: HTMLDivElement;
  /** Clean up event listeners and abort controller. */
  readonly destroy: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSidebarMemberSection(
  opts: SidebarMemberSectionOptions,
): SidebarMemberSectionResult {
  const unsubs: Array<() => void> = [];

  // --- Container ---
  const memberListContainer = createElement("div", {
    class: "sidebar-members-section",
    "data-testid": "sidebar-members",
  });

  // --- Header ---
  // The arrow is a real <button> so the member list can be collapsed from the
  // keyboard; the header div keeps its mouse click handler for a full-row
  // target (a button click bubbles to it).
  const memberHeader = createElement("div", { class: "category sidebar-members-header" });
  const memberLabelEl = createElement(
    "span",
    { class: "category-name" },
    shellText("members.heading"),
  );
  const memberArrow = createElement("button", { type: "button", class: "category-arrow" });
  memberArrow.textContent = "\u25BC";
  appendChildren(memberHeader, memberArrow, memberLabelEl);
  memberListContainer.appendChild(memberHeader);

  // --- Resize handle ---
  const resizeHandle = createElement("div", { class: "sidebar-resize-handle" });
  memberListContainer.appendChild(resizeHandle);

  /**
   * Give the section a definite height (a saved or dragged one, or `auto` when
   * collapsed), or clear it back to its flex share of the column. The `.sized`
   * class mirrors this, so the stylesheet can size the section to the height
   * instead of flexing it to fill the space the channel list leaves (P1-01).
   */
  function applyMemberHeight(height: string | null): void {
    memberListContainer.style.height = height ?? "";
    memberListContainer.classList.toggle("sized", height !== null);
  }

  // Restore saved height
  const savedHeight = readStored(LS_KEY_HEIGHT);
  if (savedHeight !== null) {
    applyMemberHeight(`${savedHeight}px`);
  }

  // --- Drag-to-resize logic ---
  const resizeOwner = new Disposable();
  let isDragging = false;
  let startY = 0;
  let startHeight = 0;
  // Latest height of the drag in progress; persisted once on mouseup instead
  // of on every mousemove (a synchronous storage write per move).
  let pendingHeight: number | null = null;

  resizeHandle.addEventListener(
    "mousedown",
    (e: MouseEvent) => {
      isDragging = true;
      pendingHeight = null;
      startY = e.clientY;
      startHeight = memberListContainer.getBoundingClientRect().height;
      e.preventDefault();
    },
    { signal: resizeOwner.signal },
  );

  document.addEventListener(
    "mousemove",
    (e: MouseEvent) => {
      if (!isDragging) return;
      const delta = startY - e.clientY;
      const maxH = window.innerHeight * 0.65;
      const newHeight = Math.max(80, Math.min(startHeight + delta, Math.max(maxH, startHeight)));
      applyMemberHeight(`${newHeight}px`);
      pendingHeight = newHeight;
    },
    { signal: resizeOwner.signal },
  );

  document.addEventListener(
    "mouseup",
    () => {
      const wasDragging = isDragging;
      isDragging = false;
      if (!wasDragging || pendingHeight === null) return;
      const height = pendingHeight;
      pendingHeight = null;
      // Storage unavailable or full: the height still applies for this
      // session, it just is not remembered.
      writeStored(LS_KEY_HEIGHT, String(height));
    },
    { signal: resizeOwner.signal },
  );

  unsubs.push(() => {
    resizeOwner.destroy();
  });

  // --- Collapse state ---
  const savedCollapsed = readStored(LS_KEY_COLLAPSED);
  let membersCollapsed = savedCollapsed === "true";
  const memberContent = createElement("div", { class: "sidebar-members-content" });

  function applyMembersCollapsed(): void {
    memberHeader.classList.toggle("collapsed", membersCollapsed);
    memberArrow.textContent = membersCollapsed ? "\u25B6" : "\u25BC";
    memberContent.style.display = membersCollapsed ? "none" : "";
    resizeHandle.style.display = membersCollapsed ? "none" : "";
    if (membersCollapsed) {
      applyMemberHeight("auto");
    } else {
      const h = readStored(LS_KEY_HEIGHT);
      applyMemberHeight(h !== null ? `${h}px` : null);
    }
  }

  // Apply initial state
  applyMembersCollapsed();

  memberHeader.addEventListener("click", () => {
    membersCollapsed = !membersCollapsed;
    writeStored(LS_KEY_COLLAPSED, String(membersCollapsed));
    applyMembersCollapsed();
  });

  // --- Member panel (list, search and banned section) ---
  const panel = (opts.buildPanel ?? (() => createMemberPanel({ ...opts, ui: memberPanelUi })))();
  memberContent.appendChild(panel.element);
  memberListContainer.appendChild(memberContent);
  unsubs.push(panel.destroy);

  return {
    element: memberListContainer,
    destroy: () => {
      for (const unsub of unsubs) {
        unsub();
      }
    },
  };
}
