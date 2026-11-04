// One inline error with a Retry button: a load or save that failed in place,
// shown as a danger line with a quiet Retry on the same row. The text sits in
// a role="alert" region that stays rendered (empty, it takes no room), so
// every change is announced; only the button is hidden while unused.
import { createElement, setText } from "../dom";

export interface InlineErrorOptions {
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly signal: AbortSignal;
  /** data-testid for the message; the button gets `<testId>-retry`. */
  readonly testId?: string;
}

export interface InlineError {
  readonly el: HTMLDivElement;
  readonly message: HTMLParagraphElement;
  readonly retry: HTMLButtonElement;
  /** Show `text`; `withRetry: false` shows it without the button. */
  show(text: string, withRetry?: boolean): void;
  /** Empty the line. A busy Retry stays on screen so its focus is kept. */
  clear(): void;
  /** Blocks Retry (aria-disabled, so it keeps focus) while an attempt runs. */
  setBusy(busy: boolean): void;
}

export function createInlineError(opts: InlineErrorOptions): InlineError {
  const el = createElement("div", { class: "inline-error" });
  const message = createElement("p", { class: "inline-error-text", role: "alert" });
  const retry = createElement(
    "button",
    { type: "button", class: "ac-btn secondary inline-error-retry" },
    opts.retryLabel,
  );
  if (opts.testId !== undefined) {
    message.setAttribute("data-testid", opts.testId);
    retry.setAttribute("data-testid", `${opts.testId}-retry`);
  }
  el.append(message, retry);
  retry.hidden = true;

  retry.addEventListener(
    "click",
    () => {
      if (retry.getAttribute("aria-disabled") === "true") return;
      opts.onRetry();
    },
    { signal: opts.signal },
  );

  return {
    el,
    message,
    retry,
    show(text: string, withRetry = true): void {
      setText(message, text);
      retry.hidden = !withRetry || text === "";
      el.classList.toggle("shown", text !== "");
    },
    clear(): void {
      setText(message, "");
      if (retry.getAttribute("aria-disabled") !== "true") retry.hidden = true;
      el.classList.remove("shown");
    },
    setBusy(busy: boolean): void {
      if (busy) retry.setAttribute("aria-disabled", "true");
      else retry.removeAttribute("aria-disabled");
    },
  };
}
