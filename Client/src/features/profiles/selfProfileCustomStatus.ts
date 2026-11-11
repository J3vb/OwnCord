/** The self profile card's custom status row: the text field, its emoji picker,
 *  the Clear button and the "Clear after" choice. */

import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import {
  CLEAR_AFTER_OPTIONS,
  clampExpiresIn,
  clearAfterSeconds,
  isClearAfterId,
  type ClearAfterId,
} from "@lib/text/statusChoices";
import { MAX_CUSTOM_STATUS_LEN } from "@lib/presence/userStatus";
import { attachLimitHint, collapseSpaces, lineHintText, runeCount } from "@lib/text/nameLimits";
import { customStatusKeepLabel, isEndOfDayExpiry, parseExpiry } from "../presence/statusDefs";
import { shellText } from "../../i18n/shell";
import { connectText } from "../../i18n/connect";
import { attachEmojiPicker } from "./selfProfileEmoji";
import type { HeaderPart } from "./selfProfileHeader";
import type { CardSession } from "./selfProfileTypes";

export interface CustomStatusPart {
  /** The row, its limit hint and the Clear after row, in card order. */
  readonly elements: readonly HTMLElement[];
  /** Take an update from the owner, unless the user is typing. */
  syncCustom(text: string): void;
  /** Re-pick the Clear after choice from the live expiry. */
  syncClearAfter(): void;
  /** Enable or disable the controls to match `session.enabled`. */
  paintEnabled(): void;
  /** Put the last committed text back in the field (Escape). */
  restoreCommitted(): void;
}

interface ClearAfter {
  readonly row: HTMLElement;
  readonly select: HTMLSelectElement;
  selectedExpiresIn(): number | undefined;
  sync(): void;
}

/**
 * Clear after: how long the server keeps the text. "Don't clear" is the
 * default, so nothing disappears on you unless you asked for it. A status
 * that already clears itself opens on its own expiry instead, so editing
 * the text keeps it (sync).
 */
function buildClearAfter(s: CardSession, onChosen: () => void): ClearAfter {
  const row = createElement("div", { class: "spc-clear-after" });
  const select = createElement("select", {
    class: "spc-clear-after-select",
    id: "spc-clear-after",
    "data-testid": "spc-clear-after",
  });
  for (const opt of CLEAR_AFTER_OPTIONS) {
    select.appendChild(createElement("option", { value: opt.id }, shellText(opt.labelKey)));
  }
  select.value = "never";
  // "As set (until 3:40 PM)": present only while the current text has an
  // expiry that no fixed choice matches.
  const keepOption = createElement("option", {
    value: "keep",
    "data-testid": "spc-clear-after-keep",
  });
  /** The instant the "As set" choice stands for; null while it is not offered. */
  let keepUntil: number | null = null;
  /** Set once the user picks a choice: from then on it is theirs, not the store's. */
  let touched = false;
  appendChildren(
    row,
    createElement(
      "label",
      { class: "spc-clear-after-label", for: "spc-clear-after" },
      shellText("status.clearAfter.label"),
    ),
    select,
  );

  function selectedClearAfter(): ClearAfterId {
    const v = select.value;
    return isClearAfterId(v) ? v : "never";
  }

  /** The `expiresInSeconds` the current choice sends with a non-empty text. */
  function selectedExpiresIn(): number | undefined {
    if (select.value === "keep" && keepUntil !== null) {
      return clampExpiresIn((keepUntil - Date.now()) / 1000);
    }
    return clearAfterSeconds(selectedClearAfter(), new Date());
  }

  /** Preselect the choice that matches the live expiry: "Today" for the
   *  end-of-day one, "As set" for any other, "Don't clear" for none. */
  function sync(): void {
    if (touched) return;
    const now = Date.now();
    const at = parseExpiry(s.options.getCustomStatusExpiresAt());
    const live = at !== null && at > now && s.lastCommittedCustom !== "";
    if (!live || isEndOfDayExpiry(at, now)) {
      keepOption.remove();
      keepUntil = null;
      select.value = live ? "today" : "never";
      return;
    }
    keepUntil = at;
    setText(keepOption, customStatusKeepLabel(at, now));
    if (keepOption.parentNode === null) select.prepend(keepOption);
    select.value = "keep";
  }
  sync();

  select.addEventListener(
    "change",
    () => {
      touched = true;
      onChosen();
    },
    { signal: s.signal },
  );
  return { row, select, selectedExpiresIn, sync };
}

export function buildCustomStatus(s: CardSession, header: HeaderPart): CustomStatusPart {
  const { options, signal } = s;
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
  input.value = s.lastCommittedCustom;
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

  const clearAfter = buildClearAfter(s, () => {
    // A new choice restates the text already set; with none there is
    // nothing to clear, so it only waits for the next commit.
    if (input.value.trim() !== "") commitCustom(true);
  });

  function syncClearVisibility(): void {
    clearBtn.hidden = input.value === "" && s.lastCommittedCustom === "";
  }
  syncClearVisibility();

  function commitCustom(force = false): boolean {
    if (!s.isCurrent() || !s.enabled) return true;
    // The collapsed text is what the server stores, so it is what is checked and sent.
    const text = collapseSpaces(input.value);
    // Over the limit (a paste past maxlength, a scripted value): the server
    // would refuse it, so send nothing and leave the text to be shortened.
    if (runeCount(text) > MAX_CUSTOM_STATUS_LEN) {
      customHint.showError(connectText("limits.statusTooLong", { max: MAX_CUSTOM_STATUS_LEN }));
      return false;
    }
    input.value = text;
    if (text === s.lastCommittedCustom && !force) return true;
    s.lastCommittedCustom = text;
    header.paintCustomLine();
    syncClearVisibility();
    // The expiry goes with a non-empty text only; "Today" is measured from
    // this moment, and never under the server's 60-second minimum.
    options.onCustomStatusChange(text, text === "" ? undefined : clearAfter.selectedExpiresIn());
    header.paintClearsLine();
    return true;
  }

  function syncCustom(text: string): void {
    // Never clobber text the user is typing right now.
    if (document.activeElement === input || emoji.isOpen()) return;
    s.lastCommittedCustom = text;
    input.value = text;
    header.paintCustomLine();
    syncClearVisibility();
    header.paintClearsLine();
    clearAfter.sync();
  }

  const emoji = attachEmojiPicker({
    session: s,
    input,
    button: emojiBtn,
    commit: () => commitCustom(),
    syncFromOwner: () => syncCustom(options.getCustomStatus()),
    onInserted: syncClearVisibility,
  });

  input.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (isImeCommit(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        // A refused (over-limit) status keeps the card open with the hint.
        if (commitCustom()) s.close();
      } else if (e.key === "Escape" && !isImeCommit(e)) {
        e.preventDefault();
        e.stopPropagation();
        input.value = s.lastCommittedCustom;
        s.close();
      }
    },
    { signal },
  );
  input.addEventListener("input", syncClearVisibility, { signal });
  // While the emoji picker is open focus moves into it; the text is
  // committed when the field is left after it closes, on Enter, or by
  // the picker's close when the card goes away with the picker still open.
  input.addEventListener(
    "blur",
    (e: FocusEvent) => {
      // Not while focus is in the picker, and not when it goes to Clear after:
      // that choice commits the text itself, with its expiry (one frame).
      if (!emoji.isOpen() && e.relatedTarget !== clearAfter.select) {
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
      if (!s.enabled) return;
      input.value = "";
      customHint.reset();
      commitCustom();
      input.focus();
    },
    { signal },
  );

  // Whatever takes the card away, text typed but not yet committed goes with
  // it (the picker's and the select's blur skips would otherwise lose it).
  // Escape has already put the last committed text back, so it sends nothing.
  s.disposable.addCleanup(() => {
    emoji.close(false);
    commitCustom();
  });

  return {
    elements: [customRow, customHint.el, clearAfter.row],
    syncCustom,
    syncClearAfter: clearAfter.sync,
    paintEnabled(): void {
      input.disabled = !s.enabled;
      clearBtn.disabled = !s.enabled;
      emojiBtn.disabled = !s.enabled;
      clearAfter.select.disabled = !s.enabled;
      if (!s.enabled) emoji.close(false);
    },
    restoreCommitted(): void {
      input.value = s.lastCommittedCustom;
    },
  };
}
