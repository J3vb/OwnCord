// Name and status limits (WP 3C-9): the client half of the server's
// character rules, kept to the cheap checks. The server stays the authority
// (Server/auth/visible_text.go, Server/service/visible_text.go); this module
// only stops a request the server would refuse on length or on a new
// username's allowed characters, and gives every limited input one inline hint.

import { createElement } from "./dom";
import { connectText } from "../i18n/connect";

export const MIN_USERNAME_LEN = 2;
export const MAX_USERNAME_LEN = 32;
export const MAX_DISPLAY_NAME_LEN = 32;
export const MAX_GROUP_DM_NAME_LEN = 100;
/** Most combining marks the server accepts in a row (auth.maxCombiningRun). */
const MAX_COMBINING_RUN = 2;

/** Characters as the server counts them (runes), not UTF-16 units. */
export function runeCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * One-line text as the server stores it: runs of Unicode spaces become one
 * space and the ends are trimmed (auth.CollapseSpaces). Tabs and pasted line
 * breaks, which the server refuses, become spaces too. Send this, not the raw
 * input, so what is checked is what is sent.
 */
export function collapseSpaces(s: string): string {
  return s.replace(/[\s\p{Zs}]+/gu, " ").trim();
}

/** The length the server measures for one-line text: characters after collapsing. */
export function visibleLength(s: string): number {
  return runeCount(collapseSpaces(s));
}

/** Add or remove one id in an element's aria-describedby, leaving the others. */
export function toggleDescribedBy(el: Element, id: string, on: boolean): void {
  const tokens = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((t) => t !== "");
  const next = tokens.filter((t) => t !== id);
  if (on) next.push(id);
  if (next.length === 0) el.removeAttribute("aria-describedby");
  else el.setAttribute("aria-describedby", next.join(" "));
}

/** Why a new username fails the client check; each maps to one message. */
export type UsernameProblem =
  | "tooShort"
  | "tooLong"
  | "reserved"
  | "invisible"
  | "start"
  | "chars"
  | "markPlacement"
  | "markStack";

const RESERVED_USERNAMES: ReadonlySet<string> = new Set(["everyone", "here"]);

/** Default-ignorable fillers the server refuses (auth.isBlankFiller) and the
 *  variation selectors U+FE00-FE0F. */
function isInvisibleFiller(cp: number): boolean {
  return (
    cp === 0x034f ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x3164 ||
    cp === 0xffa0 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const MARK = /^[\p{Mn}\p{Mc}]$/u;

/**
 * Mirror of auth.ValidateNewUsername for the cases that are cheap and exact:
 * 2-32 characters, `everyone`/`here` reserved, only letters, digits, `_`, `.`
 * and `-` (plus combining marks after a letter or mark, at most two in a row),
 * starting with a letter or digit. Returns null when the name passes; the
 * server's loose pre-checks (control and format characters, the `[deleted-`
 * namespace) are left to it and shown when it refuses. `raw` is trimmed first,
 * as the server does.
 */
export function checkNewUsername(raw: string): UsernameProblem | null {
  const username = raw.trim();
  const chars = Array.from(username);
  if (chars.length < MIN_USERNAME_LEN) return "tooShort";
  if (chars.length > MAX_USERNAME_LEN) return "tooLong";
  if (RESERVED_USERNAMES.has(username.toLowerCase())) return "reserved";
  let prev = "";
  let run = 0;
  for (const [i, ch] of chars.entries()) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisibleFiller(cp)) return "invisible";
    const isMark = MARK.test(ch);
    if (LETTER.test(ch) || DIGIT.test(ch)) {
      run = 0;
    } else if (ch === "_" || ch === "." || ch === "-") {
      if (i === 0) return "start";
      run = 0;
    } else if (isMark) {
      if (i === 0 || !(LETTER.test(prev) || MARK.test(prev))) return "markPlacement";
      run++;
      if (run > MAX_COMBINING_RUN) return "markStack";
    } else {
      return "chars";
    }
    if (i === 0 && !LETTER.test(ch) && !DIGIT.test(ch)) return "start";
    prev = ch;
  }
  return null;
}

/** Catalog text for a username problem. */
export function usernameProblemText(problem: UsernameProblem): string {
  const texts: Record<UsernameProblem, () => string> = {
    tooShort: () =>
      connectText("limits.usernameTooShort", { min: MIN_USERNAME_LEN, max: MAX_USERNAME_LEN }),
    tooLong: () =>
      connectText("limits.usernameTooLong", { min: MIN_USERNAME_LEN, max: MAX_USERNAME_LEN }),
    reserved: () => connectText("limits.usernameReserved"),
    invisible: () => connectText("limits.usernameInvisible"),
    start: () => connectText("limits.usernameStart"),
    chars: () => connectText("limits.usernameChars"),
    markPlacement: () => connectText("limits.usernameMarkPlacement"),
    markStack: () => connectText("limits.usernameMarkStack", { max: MAX_COMBINING_RUN }),
  };
  return texts[problem]();
}

/** The hint under a new-username input (register and rename). */
export function usernameHintText(): string {
  return connectText("limits.usernameHint", { min: MIN_USERNAME_LEN, max: MAX_USERNAME_LEN });
}

/** The hint under a one-line text input (display name, status, group name). */
export function lineHintText(max: number): string {
  return connectText("limits.lineHint", { max });
}

// ---------------------------------------------------------------------------
// Inline hint
// ---------------------------------------------------------------------------

export interface LimitHint {
  /** The hint element, to place under the input. */
  readonly el: HTMLDivElement;
  /** Show a refusal (the client check's or the server's) in place of the hint,
   *  marking the input invalid. The typed value is left alone; the next edit
   *  puts the hint back. */
  showError(message: string): void;
  /** Restore the plain hint. */
  reset(): void;
}

export interface LimitHintOptions {
  /** The limit in characters. */
  readonly max: number;
  /**
   * Count characters rather than UTF-16 units. `maxlength` is then set to the
   * worst case (2 units per character) and the limit is enforced by character
   * count on input, so text outside the BMP (the server counts characters)
   * is not cut short. Usernames pass it too: they allow any letter, including
   * ones outside the BMP.
   */
  readonly countCharacters?: boolean;
  /** The rule text shown while nothing is wrong. */
  readonly hint: string;
  /** Unique id; the input's aria-describedby points at it. */
  readonly id: string;
  readonly signal?: AbortSignal;
}

let hintSeq = 0;

/**
 * Give a text input `maxlength` and an inline hint. The hint shows the rule,
 * switches to "limit reached" when typing or a paste hits the cap (the browser
 * truncates a paste to `maxlength` without any event of its own, so the paste
 * is checked beforehand), and carries a refusal from `showError`.
 *
 * `maxlength` counts UTF-16 units and the server counts characters, so
 * one-line text fields and usernames pass `countCharacters` (see the option).
 * Callers still check the value with
 * `runeCount`/`visibleLength` before sending, since a value set by script or
 * restored by autofill is not bound by `maxlength`.
 */
export function attachLimitHint(input: HTMLInputElement, opts: LimitHintOptions): LimitHint {
  hintSeq++;
  const el = createElement("div", {
    class: "form-hint limit-hint",
    id: `${opts.id}-${hintSeq}`,
    "aria-live": "polite",
  });
  el.textContent = opts.hint;
  const countChars = opts.countCharacters === true;
  input.maxLength = countChars ? opts.max * 2 : opts.max;
  toggleDescribedBy(input, el.id, true);

  const paint = (text: string, state: "" | "limit" | "error"): void => {
    el.textContent = text;
    el.classList.toggle("limit-hint--limit", state === "limit");
    el.classList.toggle("limit-hint--error", state === "error");
    if (state === "error") input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };
  const reached = (): void => paint(connectText("limits.reached", { max: opts.max }), "limit");
  const reset = (): void => paint(opts.hint, "");

  // The field is bounded only while it has a maxlength (a caller may lift it,
  // as Login does for the username); an unbounded field has no limit to reach.
  const bounded = (): boolean => input.maxLength >= 0;
  const size = (text: string): number => (countChars ? runeCount(text) : text.length);
  const limit = (): number => (countChars ? opts.max : input.maxLength);

  // Would inserting `text` over the current selection overflow the limit?
  const overflows = (text: string): boolean => {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const kept = size(input.value.slice(0, start)) + size(input.value.slice(end));
    return kept + size(text) > limit();
  };

  const listen = { signal: opts.signal };
  input.addEventListener(
    "beforeinput",
    (e: InputEvent) => {
      if (!bounded()) return;
      if (e.inputType.startsWith("insert") && typeof e.data === "string" && overflows(e.data)) {
        reached();
      }
    },
    listen,
  );
  input.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      if (!bounded()) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (text !== "" && overflows(text)) reached();
    },
    listen,
  );
  input.addEventListener(
    "input",
    () => {
      if (!bounded()) return;
      if (countChars && runeCount(input.value) > opts.max) {
        // Cut by characters, not units, so a pair is never split.
        const cut = Array.from(input.value).slice(0, opts.max).join("");
        input.value = cut;
        input.setSelectionRange(cut.length, cut.length);
      }
      if (size(input.value) >= limit()) reached();
      else reset();
    },
    listen,
  );

  return { el, showError: (message) => paint(message, "error"), reset };
}
