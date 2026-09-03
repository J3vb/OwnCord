/**
 * StatusPicker — compact dropdown for selecting user online status.
 * Shows a colored status dot; clicking it opens a floating menu
 * with all status options. Intended for use in the UserBar.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { MAX_CUSTOM_STATUS_LEN } from "@lib/userStatus";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusPickerOptions {
  readonly currentStatus: UserStatus;
  readonly onStatusChange: (status: UserStatus) => void;
  /** The custom status line to pre-fill the input with. */
  readonly currentCustomStatus?: string;
  /** Called when the user commits a custom status (Enter or blur). Passing an
   *  empty string means "clear it". Omitted = the input is not rendered. */
  readonly onCustomStatusChange?: (text: string) => void;
}

export type StatusPickerComponent = MountableComponent & {
  /** Update the displayed status without recreating the picker. */
  setStatus(status: UserStatus): void;
  /** Update the custom status input without recreating the picker. */
  setCustomStatus(text: string): void;
};

// ---------------------------------------------------------------------------
// Status definitions
// ---------------------------------------------------------------------------

interface StatusDef {
  readonly value: UserStatus;
  readonly label: string;
  readonly color: string;
}

/**
 * "invisible" is its own value now, not "offline" wearing a different label.
 * The server stores it as chosen and shows everyone else offline, so the
 * picker can finally send what it means — and the status survives a reconnect
 * instead of flashing back to online.
 */
const STATUS_DEFS: readonly StatusDef[] = [
  { value: "online", label: "Online", color: "#3ba55d" },
  { value: "idle", label: "Idle", color: "#faa61a" },
  { value: "dnd", label: "Do Not Disturb", color: "#ed4245" },
  { value: "invisible", label: "Invisible", color: "#747f8d" },
];

function colorForStatus(status: UserStatus): string {
  return STATUS_DEFS.find((d) => d.value === status)?.color ?? "#747f8d";
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createStatusPicker(options: StatusPickerOptions): StatusPickerComponent {
  const ac = new AbortController();
  const { signal } = ac;

  let currentStatus: UserStatus = options.currentStatus;
  let root: HTMLDivElement | null = null;
  let dotEl: HTMLDivElement | null = null;
  let dropdownEl: HTMLDivElement | null = null;
  let checkEls = new Map<UserStatus, HTMLSpanElement>();
  let customInputEl: HTMLInputElement | null = null;
  /** Last text handed to the callback. Guards the blur-after-Enter double
   *  send, which would otherwise cost a second presence_update against the
   *  server's one-per-ten-seconds limit. */
  let lastCommittedCustom = options.currentCustomStatus ?? "";

  // ---- Dropdown visibility --------------------------------------------------

  function isOpen(): boolean {
    return dropdownEl?.classList.contains("status-picker-dropdown--open") === true;
  }

  function openDropdown(): void {
    dropdownEl?.classList.add("status-picker-dropdown--open");
    dotEl?.setAttribute("aria-expanded", "true");
  }

  function closeDropdown(): void {
    dropdownEl?.classList.remove("status-picker-dropdown--open");
    dotEl?.setAttribute("aria-expanded", "false");
  }

  function toggleDropdown(): void {
    if (isOpen()) {
      closeDropdown();
    } else {
      openDropdown();
    }
  }

  // ---- Status update --------------------------------------------------------

  function applyStatus(status: UserStatus): void {
    currentStatus = status;

    // Update trigger dot color
    if (dotEl !== null) {
      dotEl.style.background = colorForStatus(status);
    }

    // Update checkmarks
    for (const [value, el] of checkEls) {
      el.style.display = value === status ? "" : "none";
    }
  }

  // ---- Build DOM ------------------------------------------------------------

  function buildOption(def: StatusDef): HTMLDivElement {
    const row = createElement("div", {
      class: "status-picker-option",
      role: "menuitem",
      tabindex: "0",
    });

    const optDot = createElement("span", { class: "status-picker-option-dot" });
    optDot.style.background = def.color;

    const label = createElement("span", { class: "status-picker-option-label" }, def.label);

    const check = createElement("span", { class: "status-picker-option-check" });
    check.style.display = def.value === currentStatus ? "" : "none";
    const checkIcon = createIcon("check", 16);
    check.appendChild(checkIcon);
    checkEls.set(def.value, check);

    appendChildren(row, optDot, label, check);

    row.addEventListener(
      "click",
      () => {
        applyStatus(def.value);
        closeDropdown();
        options.onStatusChange(def.value);
      },
      { signal },
    );

    row.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.click();
        }
      },
      { signal },
    );

    return row;
  }

  /**
   * The "Set a custom status" row. Only built when a handler was supplied —
   * an input whose value goes nowhere is worse than no input.
   */
  function buildCustomStatusRow(onChange: (text: string) => void): HTMLDivElement {
    const row = createElement("div", { class: "status-picker-custom" });
    const input = createElement("input", {
      class: "status-picker-custom-input",
      type: "text",
      placeholder: "Set a custom status",
      maxlength: String(MAX_CUSTOM_STATUS_LEN),
      "aria-label": "Custom status",
      "data-testid": "custom-status-input",
    });
    input.value = options.currentCustomStatus ?? "";
    customInputEl = input;

    const commit = (): void => {
      const text = input.value.trim().slice(0, MAX_CUSTOM_STATUS_LEN);
      if (text === lastCommittedCustom) return;
      lastCommittedCustom = text;
      input.value = text;
      onChange(text);
    };

    input.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Keystrokes inside the input must not reach the dropdown's own
        // Enter/Escape handling, which would close the menu mid-edit.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          closeDropdown();
        } else if (e.key === "Escape") {
          e.preventDefault();
          input.value = lastCommittedCustom;
          closeDropdown();
        }
      },
      { signal },
    );
    input.addEventListener("blur", commit, { signal });
    // The row is inside the dropdown; clicking the input must not be treated
    // as picking a status or as an outside click.
    input.addEventListener("click", (e: MouseEvent) => e.stopPropagation(), { signal });

    row.appendChild(input);
    return row;
  }

  // ---- MountableComponent ---------------------------------------------------

  function mount(container: Element): void {
    root = createElement("div", { class: "status-picker" });

    // Trigger dot
    dotEl = createElement("div", {
      class: "status-picker-dot",
      role: "button",
      tabindex: "0",
      "aria-label": "Change status",
      "aria-haspopup": "true",
      "aria-expanded": "false",
    });
    dotEl.style.background = colorForStatus(currentStatus);
    dotEl.addEventListener(
      "click",
      (e: MouseEvent) => {
        e.stopPropagation();
        toggleDropdown();
      },
      { signal },
    );
    dotEl.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleDropdown();
        }
      },
      { signal },
    );

    // Dropdown menu
    dropdownEl = createElement("div", {
      class: "status-picker-dropdown",
      role: "menu",
    });
    for (const def of STATUS_DEFS) {
      dropdownEl.appendChild(buildOption(def));
    }
    const onCustomStatusChange = options.onCustomStatusChange;
    if (onCustomStatusChange !== undefined) {
      dropdownEl.appendChild(createElement("div", { class: "status-picker-divider" }));
      dropdownEl.appendChild(buildCustomStatusRow(onCustomStatusChange));
    }

    appendChildren(root, dotEl, dropdownEl);
    container.appendChild(root);

    // Close on outside click
    document.addEventListener(
      "click",
      (e: MouseEvent) => {
        if (isOpen() && root !== null && !root.contains(e.target as Node)) {
          closeDropdown();
        }
      },
      { signal },
    );

    // Close on Escape
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && isOpen()) {
          closeDropdown();
          dotEl?.focus();
        }
      },
      { signal },
    );
  }

  function destroy(): void {
    ac.abort();
    checkEls = new Map();
    root?.remove();
    root = null;
    dotEl = null;
    dropdownEl = null;
    customInputEl = null;
  }

  function setStatus(status: UserStatus): void {
    applyStatus(status);
  }

  function setCustomStatus(text: string): void {
    // Skip the overwrite while the user is mid-edit (input focused) — an
    // unrelated store push (e.g. a role change) would otherwise clobber
    // in-progress typed text *and* reset the commit watermark, so the
    // pending blur/Enter commit silently no-ops (OC-0369).
    if (customInputEl !== null && document.activeElement === customInputEl) return;
    lastCommittedCustom = text;
    if (customInputEl !== null) customInputEl.value = text;
  }

  return { mount, destroy, setStatus, setCustomStatus };
}
