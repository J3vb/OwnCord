/**
 * ServerBanner component — top-of-app banner for server restart
 * countdown and reconnecting state.
 */

import { createElement, setText } from "@lib/dom";
import { shellText } from "../i18n/shell";

export interface ServerBannerControl {
  readonly element: HTMLDivElement;
  showRestart(seconds: number): void;
  showReconnecting(): void;
  showDisconnected(): void;
  /** Persistent "signed in elsewhere" notice with a "Use here" action. */
  showSignedInElsewhere(onUseHere: () => void): void;
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
    setText(root, shellText("banner.restarting", { seconds: remaining }));

    intervalId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdown();
        showReconnecting();
        return;
      }
      setText(root, shellText("banner.restarting", { seconds: remaining }));
    }, 1000);
  }

  function showReconnecting(): void {
    clearCountdown();
    root.classList.add("visible");
    setText(root, shellText("banner.reconnecting"));
  }

  function showDisconnected(): void {
    clearCountdown();
    root.classList.add("visible");
    setText(root, shellText("banner.disconnected"));
  }

  function showSignedInElsewhere(onUseHere: () => void): void {
    clearCountdown();
    root.classList.add("visible");
    const useHere = createElement(
      "button",
      { class: "reconnecting-banner-action", type: "button" },
      shellText("banner.useHere"),
    );
    useHere.addEventListener("click", onUseHere, { once: true });
    root.replaceChildren(`${shellText("banner.signedInElsewhere")} `, useHere);
  }

  function hide(): void {
    clearCountdown();
    root.classList.remove("visible");
  }

  function destroy(): void {
    clearCountdown();
    root.remove();
  }

  return {
    element: root,
    showRestart,
    showReconnecting,
    showDisconnected,
    showSignedInElsewhere,
    hide,
    destroy,
  };
}

/**
 * Apply a store connection status to the banner (UX spec §3 table):
 * reconnecting → "Reconnecting...", disconnected → "Disconnected",
 * connected → hidden.
 */
export function applyConnectionStatus(
  banner: ServerBannerControl,
  status: "connected" | "reconnecting" | "disconnected",
): void {
  if (status === "reconnecting") {
    banner.showReconnecting();
  } else if (status === "disconnected") {
    banner.showDisconnected();
  } else {
    banner.hide();
  }
}
