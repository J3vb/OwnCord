/**
 * SelfProfileCard — the popout your own avatar/name opens in the user panel.
 * Holds the status menu (with the note under Do Not Disturb and Invisible),
 * the custom status line, Edit Profile (Settings → Account) and, with
 * Developer Mode on, Copy User ID.
 *
 * It is built per open and torn down on close: while shut there is no element
 * and no listener. It owns nothing about *saving* — the owner hands in the
 * same status/custom-status callbacks the status dropdown uses, so both go
 * through one presence path.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { resolveDisplayName } from "@lib/ui/avatar";
import type { UserStatus } from "@lib/types";
import {
  CLEAR_AFTER_OPTIONS,
  STATUS_DURATIONS,
  clearAfterSeconds,
  isClearAfterId,
  type ClearAfterId,
} from "@lib/text/statusChoices";
import {
  MAX_CUSTOM_STATUS_LEN,
  isTimedStatus,
  loadStatusTimer,
  loadUserStatus,
  onStatusTimerChange,
  onUserStatusChange,
} from "@lib/presence/userStatus";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { openSettings, uiStore } from "@stores/ui.store";
import {
  STATUS_DEFS,
  customStatusClearsLine,
  parseExpiry,
  statusTimerLine,
  type StatusDef,
} from "@components/statusDefs";
import { createLazyScreen } from "@components/lazyScreen";
import { createAvatarElement } from "@components/message-list/avatar";
import { copyWithToast, isDeveloperMode } from "../features/developer-mode/developerTools";
import { shellText } from "../i18n/shell";
import { connectText } from "../i18n/connect";
import { attachLimitHint, collapseSpaces, lineHintText, runeCount } from "@lib/text/nameLimits";

// The picker loads on its first open, so its code stays out of the main-page chunk.
const emojiPickerScreen = createLazyScreen("emoji-picker", () => import("@components/EmojiPicker"));

export interface SelfProfileCardOptions {
  /** The button that opens the card; the card anchors above it and hands
   *  focus back to it. */
  readonly trigger: HTMLElement;
  /** Whether a status can be sent right now (socket live, presence sender). */
  readonly canSetStatus: () => boolean;
  /** The authoritative current custom status ("" for none). */
  readonly getCustomStatus: () => string;
  /** When the custom status clears itself (RFC 3339), null for never. The
   *  server only tells the owner; the card never runs its own clearing timer. */
  readonly getCustomStatusExpiresAt: () => string | null;
  /** `durationMs` is set for a timed Idle, Do Not Disturb or Invisible: the
   *  owner saves the status and then the timer that reverts it to Online. */
  readonly onStatusChange: (status: UserStatus, durationMs?: number) => void;
  /** `expiresInSeconds` is the "Clear after" choice (60..604800), left out for
   *  "Don't clear" and for clearing the text. */
  readonly onCustomStatusChange: (text: string, expiresInSeconds?: number) => void;
}

export interface SelfProfileCard {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Close without restoring focus; for the owner's teardown. */
  destroy(): void;
}

/** Only one card may be open at a time, across every owner. */
let closeActive: (() => void) | null = null;

function ownIdentity(): { id: number | null; username: string; displayName: string | null } {
  const user = authStore.getState().user;
  return {
    id: user?.id ?? null,
    username: user?.username ?? shellText("common.unknown"),
    displayName: user?.display_name ?? null,
  };
}

export function createSelfProfileCard(options: SelfProfileCardOptions): SelfProfileCard {
  let disposable: Disposable | null = null;
  let cardEl: HTMLDivElement | null = null;

  function isOpen(): boolean {
    return cardEl !== null;
  }

  function teardown(restoreFocus: boolean): void {
    if (cardEl === null) return;
    const card = cardEl;
    const focusInside = card.contains(document.activeElement);
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    disposable?.destroy();
    disposable = null;
    cardEl = null;
    card.remove();
    if (closeActive === close) closeActive = null;
    options.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && (focusInside || focusLost)) options.trigger.focus();
  }

  function close(): void {
    teardown(true);
  }

  function open(): void {
    if (cardEl !== null) return;
    closeActive?.();
    const d = new Disposable();
    disposable = d;
    const { signal } = d;

    let status: UserStatus = loadUserStatus();
    let lastCommittedCustom = options.getCustomStatus();
    let enabled = options.canSetStatus();
    let emojiPicker: { element: HTMLDivElement; destroy(): void } | null = null;
    // Set while the picker's code loads: a second click cancels it, and so
    // does closing the card (the load resolving later mounts nothing).
    let emojiPending: object | null = null;

    const card = createElement("div", {
      class: "self-profile-card",
      role: "dialog",
      "aria-label": shellText("status.profileLabel"),
      "data-testid": "self-profile-card",
      tabindex: "-1",
    });
    cardEl = card;

    // ---- Header: avatar + names ---------------------------------------------
    const identity = ownIdentity();
    const header = createElement("div", { class: "spc-header" });
    const avatar = createAvatarElement(
      {
        username: identity.username,
        displayName: identity.displayName,
        avatar: authStore.getState().user?.avatar ?? null,
      },
      { className: "spc-avatar", background: "var(--accent)", animate: "always" },
    );
    const names = createElement("div", { class: "spc-names" });
    const nameEl = createElement(
      "div",
      { class: "spc-name", "data-testid": "spc-name" },
      resolveDisplayName(identity),
    );
    const usernameEl = createElement(
      "div",
      { class: "spc-username", "data-testid": "spc-username" },
      identity.username,
    );
    const customLineEl = createElement("div", {
      class: "spc-custom-line",
      "data-testid": "spc-custom-line",
    });
    const clearsLineEl = createElement("div", {
      class: "spc-clears-line",
      "data-testid": "spc-clears-line",
    });
    appendChildren(names, nameEl, usernameEl, customLineEl, clearsLineEl);
    appendChildren(header, avatar, names);

    function paintCustomLine(): void {
      setText(customLineEl, lastCommittedCustom);
      customLineEl.hidden = lastCommittedCustom === "";
    }
    paintCustomLine();

    /** "Clears at 3:40 PM" while the server will still clear the text; nothing
     *  once the instant has passed (the server's own clear is on its way). */
    function paintClearsLine(): void {
      const iso = options.getCustomStatusExpiresAt();
      const at = parseExpiry(iso);
      const live = iso !== null && at !== null && at > Date.now() && lastCommittedCustom !== "";
      clearsLineEl.hidden = !live;
      setText(clearsLineEl, live ? customStatusClearsLine(iso) : "");
    }
    paintClearsLine();

    // ---- Custom status row --------------------------------------------------
    const customRow = createElement("div", { class: "spc-custom" });
    const emojiBtn = createElement("button", {
      class: "spc-custom-emoji",
      type: "button",
      title: shellText("status.emojiButton"),
      "aria-label": shellText("status.emojiButton"),
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      "data-testid": "spc-custom-emoji",
    });
    emojiBtn.appendChild(createIcon("smile", 16));
    const input = createElement("input", {
      class: "spc-custom-input",
      type: "text",
      placeholder: shellText("status.customPlaceholder"),
      "aria-label": shellText("status.customLabel"),
      "data-testid": "spc-custom-input",
    });
    input.value = lastCommittedCustom;
    const customHint = attachLimitHint(input, {
      max: MAX_CUSTOM_STATUS_LEN,
      hint: lineHintText(MAX_CUSTOM_STATUS_LEN),
      countCharacters: true,
      id: "spc-custom-hint",
      signal,
    });
    customHint.el.dataset["testid"] = "spc-custom-hint";
    const clearBtn = createElement("button", {
      class: "spc-custom-clear",
      type: "button",
      title: shellText("status.clearCustom"),
      "aria-label": shellText("status.clearCustom"),
      "data-testid": "spc-custom-clear",
    });
    clearBtn.appendChild(createIcon("x", 14));
    appendChildren(customRow, emojiBtn, input, clearBtn);

    // Clear after: how long the server keeps the text. "Don't clear" is the
    // default, so nothing disappears on you unless you asked for it.
    const clearAfterRow = createElement("div", { class: "spc-clear-after" });
    const clearAfterSelect = createElement("select", {
      class: "spc-clear-after-select",
      id: "spc-clear-after",
      "data-testid": "spc-clear-after",
    });
    for (const opt of CLEAR_AFTER_OPTIONS) {
      clearAfterSelect.appendChild(
        createElement("option", { value: opt.id }, shellText(opt.labelKey)),
      );
    }
    clearAfterSelect.value = "never";
    appendChildren(
      clearAfterRow,
      createElement(
        "label",
        { class: "spc-clear-after-label", for: "spc-clear-after" },
        shellText("status.clearAfter.label"),
      ),
      clearAfterSelect,
    );

    function selectedClearAfter(): ClearAfterId {
      const v = clearAfterSelect.value;
      return isClearAfterId(v) ? v : "never";
    }

    function syncClearVisibility(): void {
      clearBtn.hidden = input.value === "" && lastCommittedCustom === "";
    }
    syncClearVisibility();

    function commitCustom(force = false): boolean {
      if (cardEl !== card || !enabled) return true;
      // The collapsed text is what the server stores, so it is what is checked and sent.
      const text = collapseSpaces(input.value);
      // Over the limit (a paste past maxlength, a scripted value): the server
      // would refuse it, so send nothing and leave the text to be shortened.
      if (runeCount(text) > MAX_CUSTOM_STATUS_LEN) {
        customHint.showError(connectText("limits.statusTooLong", { max: MAX_CUSTOM_STATUS_LEN }));
        return false;
      }
      input.value = text;
      if (text === lastCommittedCustom && !force) return true;
      lastCommittedCustom = text;
      paintCustomLine();
      syncClearVisibility();
      // The expiry goes with a non-empty text only; "Today" is measured from
      // this moment, and never under the server's 60-second minimum.
      options.onCustomStatusChange(
        text,
        text === "" ? undefined : clearAfterSeconds(selectedClearAfter(), new Date()),
      );
      paintClearsLine();
      return true;
    }

    clearAfterSelect.addEventListener(
      "change",
      () => {
        // A new choice restates the text already set; with none there is
        // nothing to clear, so it only waits for the next commit.
        if (input.value.trim() !== "") commitCustom(true);
      },
      { signal },
    );

    input.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (isImeCommit(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          // A refused (over-limit) status keeps the card open with the hint.
          if (commitCustom()) close();
        } else if (e.key === "Escape" && !isImeCommit(e)) {
          e.preventDefault();
          e.stopPropagation();
          input.value = lastCommittedCustom;
          close();
        }
      },
      { signal },
    );
    input.addEventListener("input", syncClearVisibility, { signal });
    // While the emoji picker is open focus moves into it; the text is
    // committed when the field is left after it closes, on Enter, or by
    // closeEmojiPicker when the card goes away with the picker still open.
    input.addEventListener(
      "blur",
      (e: FocusEvent) => {
        // Not while focus is in the picker, and not when it goes to Clear after:
        // that choice commits the text itself, with its expiry (one frame).
        if (emojiPicker === null && e.relatedTarget !== clearAfterSelect) {
          commitCustom();
          // An update held back while the field was focused applies now.
          syncCustom(options.getCustomStatus());
        }
      },
      { signal },
    );
    // Keep focus in the input so the press does not blur-commit half-typed
    // text before the clear sends "" (one frame, not two).
    clearBtn.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault(), { signal });
    clearBtn.addEventListener(
      "click",
      () => {
        if (!enabled) return;
        input.value = "";
        customHint.reset();
        commitCustom();
        input.focus();
      },
      { signal },
    );

    // ---- Emoji picker for the custom status ---------------------------------
    function closeEmojiPicker(refocus: boolean): void {
      emojiPending = null;
      if (emojiPicker === null) return;
      emojiPicker.element.remove();
      emojiPicker.destroy();
      emojiPicker = null;
      emojiBtn.setAttribute("aria-expanded", "false");
      if (refocus) {
        // Back in the field: its own blur commits the text later.
        if (cardEl === card) input.focus();
      } else {
        // The card (or the picker's availability) is going away without
        // returning to the field, so its blur will not commit what was typed.
        commitCustom();
      }
      // An update held back while the picker was open applies now.
      if (cardEl === card && document.activeElement !== input)
        syncCustom(options.getCustomStatus());
    }
    // Whatever takes the card away, text typed but not yet committed goes with
    // it (the picker's and the select's blur skips would otherwise lose it).
    // Escape has already put the last committed text back, so it sends nothing.
    d.addCleanup(() => {
      closeEmojiPicker(false);
      commitCustom();
    });

    /** Put `emoji` at the caret (replacing a selection), unless that would
     *  take the text past the server's limit. The input's own maxlength caps
     *  typing the same way, and counts the same units. */
    function insertEmoji(emoji: string): void {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const next = input.value.slice(0, start) + emoji + input.value.slice(end);
      if (runeCount(next) > MAX_CUSTOM_STATUS_LEN) return;
      input.value = next;
      const caret = start + emoji.length;
      input.setSelectionRange(caret, caret);
      syncClearVisibility();
    }

    emojiBtn.addEventListener(
      "click",
      () => {
        if (!enabled) return;
        if (emojiPicker !== null) {
          closeEmojiPicker(true);
          return;
        }
        if (emojiPending !== null) {
          emojiPending = null;
          return;
        }
        const ticket = {};
        emojiPending = ticket;
        void emojiPickerScreen
          .load(() => emojiPending === ticket)
          .then((screen) => {
            if (emojiPending !== ticket || signal.aborted) return;
            emojiPending = null;
            if (screen !== null) openEmojiPicker(screen);
          });
      },
      { signal },
    );

    function openEmojiPicker(screen: typeof import("@components/EmojiPicker")): void {
      emojiPicker = screen.createEmojiPicker({
        // Custom statuses render as plain text, so a server emoji would show
        // as ":shortcode:".
        customEmoji: [],
        onSelect: (emoji, select) => {
          insertEmoji(emoji);
          if (select?.keepOpen !== true) closeEmojiPicker(true);
        },
        onClose: () => closeEmojiPicker(true),
      });
      emojiPicker.element.classList.add("spc-emoji-picker");
      card.appendChild(emojiPicker.element);
      emojiBtn.setAttribute("aria-expanded", "true");
    }
    // Keep the caret where it is: a press on the button must not blur the
    // input (and so must not commit half-typed text) before the picker opens.
    emojiBtn.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault(), { signal });

    // ---- Status options -----------------------------------------------------
    const group = createElement("div", {
      class: "spc-status-group",
      role: "menu",
      "aria-label": shellText("status.change"),
    });
    const items = new Map<UserStatus, HTMLButtonElement>();
    const untilLines = new Map<UserStatus, HTMLElement>();
    const chevrons = new Map<UserStatus, HTMLButtonElement>();
    const durationGroups = new Map<UserStatus, HTMLElement>();
    const durationItems = new Map<UserStatus, HTMLButtonElement[]>();
    let expanded: UserStatus | null = null;

    function paintStatus(): void {
      for (const [value, el] of items) {
        const on = value === status;
        el.setAttribute("aria-checked", String(on));
        el.tabIndex = on ? 0 : -1;
        el.classList.toggle("spc-status--current", on);
      }
    }

    /** "Until 3:40 PM" under the status a running timer belongs to. */
    function paintTimer(): void {
      const timer = loadStatusTimer();
      const live = timer !== null && timer.status === status && timer.until > Date.now();
      for (const [value, el] of untilLines) {
        const show = live && timer.status === value;
        el.hidden = !show;
        setText(el, show ? statusTimerLine(timer.until) : "");
      }
    }

    function paintExpanded(): void {
      for (const [value, el] of durationGroups) el.hidden = value !== expanded;
      for (const [value, el] of items) {
        if (isTimedStatus(value)) el.setAttribute("aria-expanded", String(value === expanded));
      }
    }

    function commitStatus(value: UserStatus, durationMs?: number): void {
      if (!enabled) return;
      status = value;
      paintStatus();
      options.onStatusChange(value, durationMs);
      close();
    }

    function buildStatusRadio(def: StatusDef): HTMLElement {
      const timed = isTimedStatus(def.value);
      const btn = createElement("button", {
        class: "spc-status",
        type: "button",
        role: "menuitemradio",
        "aria-checked": "false",
        tabindex: "-1",
        "data-testid": `spc-status-${def.value}`,
        ...(timed
          ? { "aria-keyshortcuts": "ArrowRight", "aria-haspopup": "menu", "aria-expanded": "false" }
          : {}),
      });
      const dot = createElement("span", { class: "spc-status-dot" });
      dot.style.background = def.color;
      const text = createElement("span", { class: "spc-status-text" });
      text.appendChild(
        createElement("span", { class: "spc-status-label" }, shellText(def.labelKey)),
      );
      if (def.noteKey !== undefined) {
        text.appendChild(
          createElement(
            "span",
            { class: "spc-status-note", "data-testid": `spc-note-${def.value}` },
            shellText(def.noteKey),
          ),
        );
      }
      const until = createElement("span", {
        class: "spc-status-until",
        "data-testid": `spc-until-${def.value}`,
      });
      until.hidden = true;
      untilLines.set(def.value, until);
      text.appendChild(until);
      const check = createElement("span", { class: "spc-status-check" });
      check.appendChild(createIcon("check", 16));
      appendChildren(btn, dot, text, check);
      btn.addEventListener("click", () => commitStatus(def.value), { signal });
      items.set(def.value, btn);

      const wrap = createElement("div", { class: "spc-status-entry" });
      if (!timed) {
        wrap.appendChild(btn);
        return wrap;
      }

      // Idle, Do Not Disturb and Invisible can be put on a timer. The chevron
      // is the pointer's way in; the keyboard's is ArrowRight on the row, so
      // it stays out of the roving order and the accessibility tree.
      const row = createElement("div", { class: "spc-status-row" });
      const chevron = createElement("button", {
        class: "spc-status-chevron",
        type: "button",
        tabindex: "-1",
        "aria-hidden": "true",
        "data-testid": `spc-chevron-${def.value}`,
      });
      chevron.appendChild(createIcon("chevron-down", 16));
      chevron.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault(), { signal });
      chevron.addEventListener(
        "click",
        () => {
          if (!enabled) return;
          expanded = expanded === def.value ? null : def.value;
          paintExpanded();
        },
        { signal },
      );
      chevrons.set(def.value, chevron);
      appendChildren(row, btn, chevron);

      const durations = createElement("div", {
        class: "spc-durations",
        role: "menu",
        "aria-label": shellText("status.durationsFor", { status: shellText(def.labelKey) }),
        "data-testid": `spc-durations-${def.value}`,
      });
      durations.hidden = true;
      const buttons: HTMLButtonElement[] = [];
      const choices: ReadonlyArray<{
        id: string;
        label: string;
        ms: number | undefined;
      }> = [
        ...STATUS_DURATIONS.map((o) => ({ id: o.id, label: shellText(o.labelKey), ms: o.ms })),
        { id: "forever", label: shellText("status.duration.forever"), ms: undefined },
      ];
      for (const choice of choices) {
        const item = createElement(
          "button",
          {
            class: "spc-action spc-duration",
            type: "button",
            role: "menuitem",
            tabindex: "-1",
            "data-testid": `spc-duration-${def.value}-${choice.id}`,
          },
          choice.label,
        );
        item.disabled = !enabled;
        item.addEventListener("click", () => commitStatus(def.value, choice.ms), { signal });
        buttons.push(item);
        durations.appendChild(item);
      }
      durationGroups.set(def.value, durations);
      durationItems.set(def.value, buttons);
      appendChildren(wrap, row, durations);
      return wrap;
    }
    for (const def of STATUS_DEFS) group.appendChild(buildStatusRadio(def));
    paintStatus();
    paintTimer();

    /** Everything the arrow keys walk, top to bottom: the status rows, with
     *  the open duration list under its row. */
    function focusOrder(): HTMLButtonElement[] {
      const order: HTMLButtonElement[] = [];
      for (const def of STATUS_DEFS) {
        const row = items.get(def.value);
        if (row !== undefined) order.push(row);
        if (expanded === def.value) order.push(...(durationItems.get(def.value) ?? []));
      }
      return order;
    }

    group.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        const list = focusOrder();
        const active = document.activeElement;
        const at = list.findIndex((el) => el === active);
        const rowStatus = [...items].find(([, el]) => el === active)?.[0];
        const ownerOfDuration = [...durationItems].find(([, els]) =>
          els.some((el) => el === active),
        )?.[0];

        if (e.key === "ArrowRight" && rowStatus !== undefined && isTimedStatus(rowStatus)) {
          if (!enabled) return;
          e.preventDefault();
          expanded = rowStatus;
          paintExpanded();
          durationItems.get(rowStatus)?.[0]?.focus();
          return;
        }
        // Escape inside an open list closes that list, like ArrowLeft; the
        // card's own Escape (document level) then sees it was handled.
        const leaves =
          e.key === "ArrowLeft" ||
          (e.key === "Escape" && !isImeCommit(e) && ownerOfDuration !== undefined);
        if (leaves && (ownerOfDuration !== undefined || rowStatus !== undefined)) {
          const owner = ownerOfDuration ?? rowStatus;
          if (owner === undefined || expanded !== owner) return;
          e.preventDefault();
          expanded = null;
          paintExpanded();
          items.get(owner)?.focus();
          return;
        }

        let next: number;
        if (e.key === "ArrowDown") next = (at + 1) % list.length;
        else if (e.key === "ArrowUp") next = (at <= 0 ? list.length : at) - 1;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = list.length - 1;
        else return;
        e.preventDefault();
        list[next]?.focus();
      },
      { signal },
    );

    function paintEnabled(): void {
      for (const btn of items.values()) btn.disabled = !enabled;
      for (const els of durationItems.values()) for (const el of els) el.disabled = !enabled;
      for (const el of chevrons.values()) el.disabled = !enabled;
      input.disabled = !enabled;
      clearBtn.disabled = !enabled;
      emojiBtn.disabled = !enabled;
      clearAfterSelect.disabled = !enabled;
      if (!enabled) closeEmojiPicker(false);
    }
    paintEnabled();

    // ---- Actions ------------------------------------------------------------
    const actions = createElement("div", { class: "spc-actions" });
    const editBtn = createElement(
      "button",
      {
        class: "spc-action",
        type: "button",
        "data-testid": "spc-edit-profile",
      },
      shellText("status.editProfile"),
    );
    editBtn.addEventListener(
      "click",
      () => {
        // Close first so the focus the settings dialog remembers is the
        // trigger, not an element that is about to be removed.
        close();
        // i18n-exempt: Settings tab id; its label is settingsText("tabs.account")
        openSettings("Account");
      },
      { signal },
    );
    actions.appendChild(editBtn);

    if (isDeveloperMode() && identity.id !== null) {
      const id = identity.id;
      const copyBtn = createElement(
        "button",
        { class: "spc-action", type: "button", "data-testid": "spc-copy-id" },
        shellText("member.copyId"),
      );
      copyBtn.addEventListener(
        "click",
        () => {
          copyWithToast(String(id), "toast.userIdCopied", "toast.userIdCopyFailed");
          close();
        },
        { signal },
      );
      actions.appendChild(copyBtn);
    }

    appendChildren(
      card,
      header,
      customRow,
      customHint.el,
      clearAfterRow,
      createElement("div", { class: "spc-divider" }),
      group,
      createElement("div", { class: "spc-divider" }),
      actions,
    );
    document.body.appendChild(card);

    // ---- Placement: above the trigger, left edges aligned --------------------
    const rect = options.trigger.getBoundingClientRect();
    card.style.left = `${Math.max(8, rect.left)}px`;
    card.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;

    options.trigger.setAttribute("aria-expanded", "true");

    // ---- Dismissal ----------------------------------------------------------
    // Capture, so a click on a control that stops propagation (the status dot)
    // still counts as outside.
    document.addEventListener(
      "click",
      (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Node)) return;
        if (card.contains(target) || options.trigger.contains(target)) return;
        close();
      },
      { signal, capture: true },
    );
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // The emoji picker already took this Escape (closing itself).
        if (e.key === "Escape" && !isImeCommit(e) && !e.defaultPrevented) {
          e.preventDefault();
          input.value = lastCommittedCustom;
          close();
        }
      },
      { signal },
    );

    // ---- Live updates while open (another device, the Account tab) ----------
    onUserStatusChange(
      (next) => {
        status = next;
        paintStatus();
        paintTimer();
      },
      { signal },
    );
    onStatusTimerChange(() => paintTimer(), { signal });
    function syncCustom(text: string): void {
      // Never clobber text the user is typing right now.
      if (document.activeElement === input || emojiPicker !== null) return;
      lastCommittedCustom = text;
      input.value = text;
      paintCustomLine();
      syncClearVisibility();
      paintClearsLine();
    }
    d.onStoreChange(
      authStore,
      (s) => s.user,
      () => {
        const next = ownIdentity();
        setText(nameEl, resolveDisplayName(next));
        setText(usernameEl, next.username);
        syncCustom(options.getCustomStatus());
      },
    );
    d.onStoreChange(
      membersStore,
      (s) => {
        const id = authStore.getState().user?.id;
        return id === undefined ? "" : (s.members.get(id)?.customStatus ?? "");
      },
      (text: string) => syncCustom(text),
    );
    d.onStoreChange(
      membersStore,
      (s) => {
        const id = authStore.getState().user?.id;
        return id === undefined ? null : (s.members.get(id)?.customStatusExpiresAt ?? null);
      },
      () => paintClearsLine(),
    );
    d.onStoreChange(
      uiStore,
      (s) => s.connectionStatus,
      () => {
        enabled = options.canSetStatus();
        paintEnabled();
      },
    );

    d.onStoreChange(
      uiStore,
      (s) => s.settingsOpen,
      (opened) => {
        if (opened) close();
      },
    );
    d.onStoreChange(
      uiStore,
      (s) => s.activeView,
      () => close(),
    );

    closeActive = close;
    const first = enabled ? items.get(status) : undefined;
    (first ?? card).focus();
  }

  function toggle(): void {
    if (isOpen()) close();
    else open();
  }

  return { open, close, toggle, isOpen, destroy: () => teardown(false) };
}
