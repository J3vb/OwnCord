/**
 * ServerBanner component — top-of-app banner for server restart
 * countdown and reconnecting state.
 */

import { createElement, setText, appendChildren } from "@lib/dom";

export interface ServerBannerOptions {
  readonly onDismiss: () => void;
}

export interface ServerBannerControl {
  readonly element: HTMLDivElement;
  showRestart(seconds: number): void;
  showReconnecting(): void;
  hide(): void;
  destroy(): void;
}

export function createServerBanner(
  options: ServerBannerOptions,
): ServerBannerControl {
  const ac = new AbortController();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const root = createElement("div", { class: "server-banner server-banner--hidden" });
  const textEl = createElement("span", { class: "server-banner__text" });
  const dismissBtn = createElement("button", { class: "server-banner__dismiss" }, "\u00D7");

  dismissBtn.addEventListener("click", () => options.onDismiss(), { signal: ac.signal });
  appendChildren(root, textEl, dismissBtn);

  function clearCountdown(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function showRestart(seconds: number): void {
    clearCountdown();
    let remaining = seconds;
    root.classList.remove("server-banner--hidden");
    setText(textEl, `Server restarting in ${remaining} seconds...`);

    intervalId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdown();
        showReconnecting();
        return;
      }
      setText(textEl, `Server restarting in ${remaining} seconds...`);
    }, 1000);
  }

  function showReconnecting(): void {
    clearCountdown();
    root.classList.remove("server-banner--hidden");
    setText(textEl, "Reconnecting...");
  }

  function hide(): void {
    clearCountdown();
    root.classList.add("server-banner--hidden");
  }

  function destroy(): void {
    clearCountdown();
    ac.abort();
    root.remove();
  }

  return { element: root, showRestart, showReconnecting, hide, destroy };
}
