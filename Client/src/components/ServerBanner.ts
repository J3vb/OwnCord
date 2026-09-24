/**
 * ServerBanner component — top-of-app banner for server restart
 * countdown and reconnecting state.
 */

import { createElement, setText } from "@lib/dom";
import { shellText } from "../i18n/shell";

/**
 * Facts that make a connection notice actionable. `offline` is the device's
 * own network state (`navigator.onLine`), which is not the same fact as the
 * server's reachability: a device on a LAN with no internet still answers
 * `onLine === true`, so only a false reading means no server — LAN or
 * otherwise — is reachable. `dialFailed` says a dial attempt actually failed;
 * until one has, a reconnect is still "Reconnecting...", not a claim that the
 * server is unreachable. `onRetry` offers a manual re-dial while the
 * socket is down. A browser that does not expose `navigator.onLine` leaves
 * `offline` undefined and the notice stays the server-unreachable wording,
 * never a claim about the internet.
 */
export interface ConnectionBannerOptions {
  readonly offline?: boolean;
  readonly dialFailed?: boolean;
  readonly onRetry?: () => void;
}

export interface ServerBannerControl {
  readonly element: HTMLDivElement;
  /**
   * A polite live region carrying the notice text so a screen reader hears
   * each state once (BPR-091). Kept out of `element` so the restart
   * countdown's once-a-second tick does not re-announce. Append it once at
   * mount; it is present (empty) from construction, since a screen reader
   * skips a region inserted already filled.
   */
  readonly liveElement: HTMLDivElement;
  showRestart(seconds: number): void;
  showReconnecting(opts?: ConnectionBannerOptions): void;
  showDisconnected(opts?: ConnectionBannerOptions): void;
  /** Persistent "signed in elsewhere" notice with a "Use here" action. */
  showSignedInElsewhere(onUseHere: () => void): void;
  hide(): void;
  destroy(): void;
}

/**
 * The state the socket is stuck in, said honestly. While the device itself
 * reports no network, "Reconnecting..." promises progress the device cannot
 * make, so the notice names the real gap instead. A LAN server with no internet
 * still answers `onLine === true`, so the offline wording never claims the
 * internet is required.
 */
function connectionNoticeText(opts: ConnectionBannerOptions): string {
  return opts.offline === true
    ? shellText("banner.deviceOffline")
    : shellText("banner.serverUnreachable");
}

export function createServerBanner(): ServerBannerControl {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const root = createElement("div", { class: "reconnecting-banner" });
  const liveElement = createElement("div", {
    class: "sr-only",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    "data-testid": "banner-announce",
  });

  /** Announce once. The visible banner is not itself live — the restart
   *  countdown rewrites it every second, which a live region would read out
   *  on each tick. */
  function announce(text: string): void {
    if (liveElement.textContent !== text) setText(liveElement, text);
  }

  /** Render `text` plus an optional Retry action, replacing prior content. */
  function renderNotice(text: string, opts: ConnectionBannerOptions): void {
    if (opts.onRetry === undefined) {
      root.replaceChildren(text);
      return;
    }
    const retry = createElement(
      "button",
      { class: "reconnecting-banner-action", type: "button" },
      shellText("banner.retry"),
    );
    retry.addEventListener("click", opts.onRetry, { once: true });
    root.replaceChildren(`${text} `, retry);
  }

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
    const first = shellText("banner.restarting", { seconds: remaining });
    setText(root, first);
    announce(first);

    intervalId = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdown();
        // The transition to a connection notice goes through the live region.
        showReconnecting();
        return;
      }
      // Visible countdown only; the live region keeps the initial
      // announcement and is not re-read every second.
      setText(root, shellText("banner.restarting", { seconds: remaining }));
    }, 1000);
  }

  /**
   * A connection problem the socket is working to recover from. Until a dial
   * has failed (a drop, an announced restart, "Use here"), it is the plain
   * "Reconnecting...". Once one has, the notice is actionable for the rest of
   * the outage, across the backoff's later dials (BPR-092). Retry is safe here: `connect()`
   * cancels the pending backoff before dialing, so it cannot race the loop.
   */
  function showReconnecting(opts: ConnectionBannerOptions = {}): void {
    clearCountdown();
    root.classList.add("visible");
    if (opts.dialFailed !== true && opts.offline !== true) {
      root.replaceChildren(shellText("banner.reconnecting"));
      announce(shellText("banner.reconnecting"));
      return;
    }
    const text = connectionNoticeText(opts);
    renderNotice(text, opts.offline === true ? {} : opts);
    announce(text);
  }

  function showDisconnected(opts: ConnectionBannerOptions = {}): void {
    clearCountdown();
    root.classList.add("visible");
    // Two distinct facts, two distinct answers (BPR-092). A LAN server with no
    // internet still answers `onLine === true`, so the offline wording only
    // fires when the device has no network at all, and neither wording tells
    // the user the internet is required to reach a local server.
    const text = connectionNoticeText(opts);
    // Retry only helps when the device has a network to retry over.
    renderNotice(text, opts.offline === true ? {} : opts);
    announce(text);
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
    announce(shellText("banner.signedInElsewhere"));
  }

  function hide(): void {
    clearCountdown();
    root.classList.remove("visible");
    setText(liveElement, "");
  }

  function destroy(): void {
    clearCountdown();
    root.remove();
    liveElement.remove();
  }

  return {
    element: root,
    liveElement,
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
 * reconnecting → "Reconnecting..." until a dial fails, then an actionable
 * notice; disconnected → an actionable notice; connected → hidden. `opts` carries the device's own network fact and the
 * manual retry action, so the notice answers the state honestly (BPR-092).
 */
export function applyConnectionStatus(
  banner: ServerBannerControl,
  status: "connected" | "reconnecting" | "disconnected",
  opts: ConnectionBannerOptions = {},
): void {
  if (status === "reconnecting") {
    banner.showReconnecting(opts);
  } else if (status === "disconnected") {
    banner.showDisconnected(opts);
  } else {
    banner.hide();
  }
}
