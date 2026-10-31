/**
 * StatusPicker — compact dropdown for selecting user online status.
 * Shows a colored status dot; clicking it opens a floating menu
 * with all status options. Intended for use in the UserBar. On a phone the
 * same options and custom status field open as a bottom sheet instead, since
 * a popover over the drawer is hard to hit and easy to lose.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { isPhoneLayout, openBottomSheet } from "@lib/ui/bottomSheet";
import type { MountableComponent } from "@lib/text/safeRender";
import type { UserStatus } from "@lib/types";
import { MAX_CUSTOM_STATUS_LEN } from "@lib/presence/userStatus";
import { attachLimitHint, collapseSpaces, lineHintText, runeCount } from "@lib/text/nameLimits";
import { shellText } from "../i18n/shell";
import { connectText } from "../i18n/connect";
import { STATUS_DEFS, colorForStatus, type StatusDef } from "@components/statusDefs";

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
  /**
   * Enable/disable the picker. A disabled picker is truly inert (no tab stop,
   * no open, no selection), not merely dimmed — a custom status set while the
   * socket is down is saved locally, never sent, and overwritten on reconnect.
   */
  setEnabled(enabled: boolean): void;
};

/** Where the custom status field is shown: the dropdown, or the phone sheet. */
interface CustomRowSurface {
  readonly signal: AbortSignal;
  /** Leave the surface after a committed status. */
  readonly done: () => void;
  /** Leave it after Escape in the field. */
  readonly cancel: () => void;
  /** Called with the field, so the picker can seed and disable the live one. */
  readonly onInput: (input: HTMLInputElement) => void;
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createStatusPicker(options: StatusPickerOptions): StatusPickerComponent {
  const disposable = new Disposable();
  const { signal } = disposable;

  let currentStatus: UserStatus = options.currentStatus;
  let root: HTMLDivElement | null = null;
  let dotEl: HTMLDivElement | null = null;
  let dropdownEl: HTMLDivElement | null = null;
  let checkEls = new Map<UserStatus, HTMLSpanElement>();
  /** The field that is live now: the sheet's while it is open, else the dropdown's. */
  let customInputEl: HTMLInputElement | null = null;
  let dropdownInputEl: HTMLInputElement | null = null;
  /** Closes the phone sheet; null while none is open. */
  let closeSheet: (() => void) | null = null;
  /** Last text handed to the callback. Guards the blur-after-Enter double
   *  send, which would otherwise cost a second presence_update against the
   *  server's one-per-ten-seconds limit. */
  let lastCommittedCustom = options.currentCustomStatus ?? "";
  /** When false the picker refuses to open or change status (offline). */
  let enabled = true;

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
    if (!enabled) return;
    if (isPhoneLayout()) {
      if (closeSheet !== null) closeSheet();
      else openSheet();
      return;
    }
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

    const label = createElement(
      "span",
      { class: "status-picker-option-label" },
      shellText(def.labelKey),
    );

    const check = createElement("span", { class: "status-picker-option-check" });
    check.style.display = def.value === currentStatus ? "" : "none";
    const checkIcon = createIcon("check", 16);
    check.appendChild(checkIcon);
    checkEls.set(def.value, check);

    appendChildren(row, optDot, label, check);

    row.addEventListener(
      "click",
      () => {
        if (!enabled) return;
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
  function buildCustomStatusRow(
    onChange: (text: string) => void,
    surface: CustomRowSurface,
  ): HTMLDivElement {
    const row = createElement("div", { class: "status-picker-custom" });
    const input = createElement("input", {
      class: "status-picker-custom-input",
      type: "text",
      placeholder: shellText("status.customPlaceholder"),
      "aria-label": shellText("status.customLabel"),
      "data-testid": "custom-status-input",
    });
    input.value = lastCommittedCustom;
    const hint = attachLimitHint(input, {
      max: MAX_CUSTOM_STATUS_LEN,
      hint: lineHintText(MAX_CUSTOM_STATUS_LEN),
      countCharacters: true,
      id: "custom-status-hint",
      signal: surface.signal,
    });
    hint.el.dataset["testid"] = "custom-status-hint";
    surface.onInput(input);

    /** True when the text was sent or was already current; false when it was
     *  refused for length and stays in the field. */
    const commit = (): boolean => {
      if (!enabled) return true;
      // The collapsed text is what the server stores, so it is what is checked and sent.
      const text = collapseSpaces(input.value);
      // Over the limit (a paste past maxlength, a scripted value): the server
      // would refuse it, so send nothing and leave the text to be shortened.
      if (runeCount(text) > MAX_CUSTOM_STATUS_LEN) {
        hint.showError(connectText("limits.statusTooLong", { max: MAX_CUSTOM_STATUS_LEN }));
        return false;
      }
      if (text === lastCommittedCustom) return true;
      lastCommittedCustom = text;
      input.value = text;
      onChange(text);
      return true;
    };

    input.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Keystrokes inside the input must not reach the dropdown's own
        // Enter/Escape handling, which would close the menu mid-edit.
        e.stopPropagation();
        if (isImeCommit(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          // A refused (over-limit) status keeps the menu open with the hint.
          if (!commit()) return;
          surface.done();
        } else if (e.key === "Escape" && !isImeCommit(e)) {
          e.preventDefault();
          input.value = lastCommittedCustom;
          hint.reset();
          surface.cancel();
        }
      },
      { signal: surface.signal },
    );
    input.addEventListener("blur", commit, { signal: surface.signal });
    // The row is inside the dropdown; clicking the input must not be treated
    // as picking a status or as an outside click.
    input.addEventListener("click", (e: MouseEvent) => e.stopPropagation(), {
      signal: surface.signal,
    });

    appendChildren(row, input, hint.el);
    return row;
  }

  // ---- Phone sheet ----------------------------------------------------------

  /** One status as a sheet row: the colour dot, its name, a check on the current one. */
  function buildSheetOption(def: StatusDef, close: () => void): HTMLButtonElement {
    const row = createElement("button", {
      type: "button",
      class: "msg-sheet-action status-sheet-option",
      role: "radio",
      "aria-checked": String(def.value === currentStatus),
      "data-testid": `status-sheet-${def.value}`,
    });
    const dot = createElement("span", { class: "status-picker-option-dot" });
    dot.style.background = def.color;
    const check = createElement("span", { class: "status-sheet-check" });
    if (def.value === currentStatus) check.appendChild(createIcon("check", 18));
    appendChildren(
      row,
      dot,
      createElement("span", { class: "menu-sheet-label" }, shellText(def.labelKey)),
      check,
    );
    row.addEventListener("click", () => {
      if (!enabled) return;
      applyStatus(def.value);
      close();
      options.onStatusChange(def.value);
    });
    return row;
  }

  function openSheet(): void {
    const content = createElement("div", { class: "msg-sheet status-sheet" });
    const sheet = openBottomSheet({
      label: shellText("status.change"),
      content,
      testId: "status-sheet",
      signal,
      fallbackFocus: () => dotEl,
      onClosed: () => {
        closeSheet = null;
        customInputEl = dropdownInputEl;
        dotEl?.setAttribute("aria-expanded", "false");
      },
    });
    if (sheet.signal.aborted) return;
    closeSheet = sheet.close;
    dotEl?.setAttribute("aria-expanded", "true");

    const card = createElement("div", {
      class: "msg-sheet-section",
      role: "radiogroup",
      "aria-label": shellText("status.change"),
    });
    for (const def of STATUS_DEFS) card.appendChild(buildSheetOption(def, sheet.close));
    content.appendChild(card);

    const onCustomStatusChange = options.onCustomStatusChange;
    if (onCustomStatusChange !== undefined) {
      const custom = buildCustomStatusRow(onCustomStatusChange, {
        signal: sheet.signal,
        done: sheet.close,
        cancel: sheet.close,
        onInput: (input) => {
          customInputEl = input;
        },
      });
      custom.classList.add("status-sheet-custom");
      content.appendChild(custom);
    }
    content.querySelector<HTMLElement>(".status-sheet-option")?.focus();
  }

  // ---- MountableComponent ---------------------------------------------------

  function mount(container: Element): void {
    root = createElement("div", { class: "status-picker" });

    // Trigger dot
    dotEl = createElement("div", {
      class: "status-picker-dot",
      role: "button",
      tabindex: "0",
      "aria-label": shellText("status.change"),
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
      dropdownEl.appendChild(
        buildCustomStatusRow(onCustomStatusChange, {
          signal,
          done: () => {
            closeDropdown();
            // Leave the input: a hidden input keeps focus, and setCustomStatus()
            // skips a focused one, so a TIMED_OUT rollback arriving right after
            // this commit could not re-seed the refused text out of it.
            dotEl?.focus();
          },
          cancel: closeDropdown,
          onInput: (input) => {
            dropdownInputEl = input;
            customInputEl = input;
          },
        }),
      );
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
        if (e.key === "Escape" && !isImeCommit(e) && isOpen()) {
          e.preventDefault();
          closeDropdown();
          dotEl?.focus();
        }
      },
      { signal },
    );
  }

  function destroy(): void {
    disposable.destroy();
    checkEls = new Map();
    root?.remove();
    root = null;
    dotEl = null;
    dropdownEl = null;
    customInputEl = null;
    dropdownInputEl = null;
    closeSheet = null;
  }

  function setStatus(status: UserStatus): void {
    applyStatus(status);
  }

  function setEnabled(value: boolean): void {
    enabled = value;
    if (!value) {
      closeDropdown();
      closeSheet?.();
    }
    if (dotEl !== null) {
      dotEl.setAttribute("aria-disabled", String(!value));
      // A disabled trigger must not be a Tab stop or activatable by key.
      if (value) dotEl.setAttribute("tabindex", "0");
      else dotEl.removeAttribute("tabindex");
    }
    if (customInputEl !== null) {
      customInputEl.disabled = !value;
    }
  }

  function setCustomStatus(text: string): void {
    // Skip the overwrite while the user is mid-edit (input focused) — an
    // unrelated store push (e.g. a role change) would otherwise clobber
    // in-progress typed text *and* reset the commit watermark, so the
    // pending blur/Enter commit silently no-ops.
    if (customInputEl !== null && document.activeElement === customInputEl) return;
    lastCommittedCustom = text;
    if (customInputEl !== null) customInputEl.value = text;
  }

  return { mount, destroy, setStatus, setCustomStatus, setEnabled };
}
