/**
 * Shared "Purge Messages" context-menu section — the count prompt used by both
 * channel menus (the sidebar right-click menu and AdminActions'
 * createChannelContextMenu). The two menus predate each other and use different
 * class conventions, so the caller supplies the class names; the clamp, the
 * confirm step and the in-flight state live here once.
 */

import { createElement, appendChildren, setText } from "@lib/dom";

/** Server-side bounds on one purge request (docs/api.md). */
export const PURGE_MIN_COUNT = 1;
export const PURGE_MAX_COUNT = 100;
export const PURGE_DEFAULT_COUNT = 50;

export interface PurgeSectionOptions {
  /** Class for ordinary rows in the host menu. */
  readonly itemClass: string;
  /** Class for the destructive confirm row. */
  readonly dangerItemClass: string;
  /** Class for the separator above the section, or "" to omit the separator. */
  readonly separatorClass: string;
  /** Runs the purge. Rejections are swallowed by the caller's toast handling. */
  readonly onPurge: (count: number) => void | Promise<void>;
  /** Aborts the section's listeners when the host menu is torn down. */
  readonly signal: AbortSignal;
  /** Called once the purge settles, so the host can close itself. */
  readonly onDone?: () => void;
}

/** Clamp a raw input value into the server's accepted range. */
export function clampPurgeCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return PURGE_DEFAULT_COUNT;
  return Math.min(PURGE_MAX_COUNT, Math.max(PURGE_MIN_COUNT, parsed));
}

/**
 * Append the trigger row plus its hidden count prompt to `menu`. The prompt is
 * revealed in place (rather than opening a modal) so the menu's outside-click
 * dismissal keeps working; typing in the input does not close it.
 */
export function appendPurgeSection(menu: HTMLElement, opts: PurgeSectionOptions): void {
  const { signal } = opts;

  if (opts.separatorClass !== "") {
    menu.appendChild(createElement("div", { class: opts.separatorClass }));
  }

  const trigger = createElement(
    "div",
    { class: opts.itemClass, "data-testid": "ctx-purge-messages" },
    "Purge Messages…",
  );

  const form = createElement("div", {
    class: "context-menu__reason",
    style: "display:none;padding:6px 8px",
    "data-testid": "purge-form",
  });
  const countInput = createElement("input", {
    class: "form-input",
    type: "number",
    min: String(PURGE_MIN_COUNT),
    max: String(PURGE_MAX_COUNT),
    value: String(PURGE_DEFAULT_COUNT),
    "data-testid": "purge-count-input",
    style: "width:100%;font-size:12px",
  });
  const hint = createElement(
    "div",
    { style: "font-size:11px;color:var(--text-muted);margin-top:4px" },
    `Deletes the newest ${PURGE_MIN_COUNT}–${PURGE_MAX_COUNT} messages.`,
  );
  const confirm = createElement(
    "div",
    { class: opts.dangerItemClass, "data-testid": "purge-confirm" },
    "Confirm Purge",
  );
  appendChildren(form, countInput, hint, confirm);

  trigger.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      trigger.style.display = "none";
      form.style.display = "";
      countInput.focus();
    },
    { signal },
  );

  // Typing a count must not trip the host menu's outside-click dismissal.
  for (const event of ["click", "mousedown"] as const) {
    countInput.addEventListener(event, (e: Event) => e.stopPropagation(), { signal });
  }

  let running = false;
  function submit(): void {
    if (running) return;
    running = true;
    setText(confirm, "Purging…");
    const done = (): void => {
      running = false;
      setText(confirm, "Confirm Purge");
      opts.onDone?.();
    };
    const result = opts.onPurge(clampPurgeCount(countInput.value));
    if (result instanceof Promise) {
      void result.then(done, done);
    } else {
      done();
    }
  }

  confirm.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      submit();
    },
    { signal },
  );
  countInput.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    },
    { signal },
  );

  appendChildren(menu, trigger, form);
}
