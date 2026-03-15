/**
 * ServerBanner component — top-of-app banner for server restart
 * countdown and reconnecting state.
 */

import { createElement, setText } from "@lib/dom";

export interface ServerBannerControl {
  readonly element: HTMLDivElement;
  showRestart(seconds: number): void;
  showReconnecting(): void;
  hide(): void;
  destroy(): void;
}

export function createServerBanner(): ServerBannerControl {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const root = createElement("div", { class: "reconnecting-banner" });

  function clearCountdown(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function showRestart(seconds: number): void {
    clearCountdown();
    let remaining = seconds;
    root.classList.add("visible");
    setText(root, `Server restarting in ${remaining} seconds...`);

    intervalId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdown();
        showReconnecting();
        return;
      }
      setText(root, `Server restarting in ${remaining} seconds...`);
    }, 1000);
  }

  function showReconnecting(): void {
    clearCountdown();
    root.classList.add("visible");
    setText(root, "Reconnecting...");
  }

  function hide(): void {
    clearCountdown();
    root.classList.remove("visible");
  }

  function destroy(): void {
    clearCountdown();
    root.remove();
  }

  return { element: root, showRestart, showReconnecting, hide, destroy };
}
