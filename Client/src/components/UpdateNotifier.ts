// UpdateNotifier — shows a non-modal banner when a client update is available.
// Mounts at the top of the main page and allows the user to update or dismiss.

import { createElement, appendChildren, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { checkForUpdate, downloadAndInstallUpdate, subscribeToUpdateInstall } from "@lib/updater";
import type { DownloadProgress, UpdateInstallState } from "@lib/updater";
import type { MountableComponent } from "@lib/safe-render";
import { connectText } from "../i18n/connect";

const log = createLogger("update-notifier");

export interface UpdateNotifierOptions {
  readonly serverUrl: string;
}

/**
 * Human-readable download status. Shows a percentage when the total size is
 * known, otherwise the bytes received so the banner never looks hung.
 */
export function formatDownloadProgress(p: DownloadProgress): string {
  if (p.total !== null && p.total > 0) {
    const pct = Math.min(100, Math.max(0, Math.round((p.received / p.total) * 100)));
    return connectText("update.downloadingPercent", { percent: pct });
  }
  const mb = (p.received / (1024 * 1024)).toFixed(1);
  return connectText("update.downloadingMb", { mb });
}

export function createUpdateNotifier(options: UpdateNotifierOptions): MountableComponent {
  const { serverUrl } = options;
  let container: Element | null = null;
  let banner: HTMLDivElement | null = null;
  /** Polite live region carrying the coarse install status, so a screen
   *  reader hears "update available / downloading / installed / failed" once —
   *  never the once-a-percent progress tick, which would read out continuously. */
  let liveRegion: HTMLDivElement | null = null;
  let dismissed = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeInstall: (() => void) | null = null;
  let installState: UpdateInstallState = { status: "idle" };

  function announce(text: string): void {
    // Idempotent: re-setting identical text on a live region can re-read it,
    // and the download phase fires this on every progress tick.
    if (liveRegion !== null && liveRegion.textContent !== text) setText(liveRegion, text);
  }

  async function performCheck(): Promise<void> {
    if (dismissed || installState.status !== "idle") return;

    const result = await checkForUpdate(serverUrl);
    if (dismissed || installState.status !== "idle") return;

    if (result.manual_upgrade) {
      showManualUpgradeBanner();
      return;
    }

    if (!result.available || result.version === null) return;

    showBanner(result.version, result.body ?? "");
  }

  /**
   * A package install (see `manual_upgrade` in `@lib/updater`): the server
   * serves no updater artifact for it, so the check can never report an
   * available update however far behind the client is. Answering that with
   * silence would be a claim — "you are up to date" — the user cannot check.
   */
  function showManualUpgradeBanner(): void {
    if (container === null || banner !== null) return;

    banner = createElement("div", { class: "update-banner" });

    const text = createElement(
      "span",
      { class: "update-banner-text" },
      connectText("update.unavailable"),
    );

    const dismissBtn = createElement(
      "button",
      { class: "update-banner-btn update-banner-later" },
      connectText("update.dismiss"),
    );
    dismissBtn.addEventListener("click", () => {
      dismissed = true;
      removeBanner();
    });

    appendChildren(banner, text, dismissBtn);
    container.prepend(banner);
    announce(connectText("update.unavailable"));
  }

  function showBanner(version: string, _notes: string): void {
    if (container === null || banner !== null) return;

    banner = createElement("div", { class: "update-banner" });

    const text = createElement(
      "span",
      { class: "update-banner-text" },
      connectText("update.available", { version }),
    );

    const updateBtn = createElement(
      "button",
      { class: "update-banner-btn update-banner-install" },
      connectText("update.now"),
    );
    updateBtn.addEventListener("click", () => {
      void installUpdate();
    });

    const laterBtn = createElement(
      "button",
      { class: "update-banner-btn update-banner-later" },
      connectText("update.later"),
    );
    laterBtn.addEventListener("click", () => {
      dismissed = true;
      removeBanner();
    });

    appendChildren(banner, text, updateBtn, laterBtn);
    container.prepend(banner);
    announce(connectText("update.available", { version }));
  }

  function installUpdate(): void {
    void downloadAndInstallUpdate(serverUrl).catch((err: unknown) => {
      log.error("Update install failed", { error: String(err) });
    });
  }

  function renderInstallState(state: UpdateInstallState): void {
    installState = state;
    if (container === null || state.status === "idle") return;
    if (banner === null) {
      banner = createElement("div", { class: "update-banner" });
      container.prepend(banner);
    }
    const text =
      state.status === "downloading"
        ? state.progress === null
          ? connectText("update.downloading")
          : formatDownloadProgress(state.progress)
        : state.status === "restarting"
          ? connectText("update.installedRestarting")
          : state.restartRequired
            ? connectText("update.installedRestart")
            : connectText("update.failed");
    banner.replaceChildren(createElement("span", { class: "update-banner-text" }, text));

    // Announce only the coarse transition. A percentage tick is not a new
    // event; reading "Downloading update… 47%" every frame is noise, so the
    // live region keeps the phase and updates only when it changes.
    if (state.status === "downloading") {
      announce(connectText("update.downloading"));
    } else if (state.status === "restarting") {
      announce(connectText("update.installedRestarting"));
    } else if (state.restartRequired) {
      announce(connectText("update.installedRestart"));
    } else {
      announce(connectText("update.failed"));
    }

    if (state.status === "failed") {
      if (!state.restartRequired) {
        const retryBtn = createElement(
          "button",
          { class: "update-banner-btn update-banner-install" },
          connectText("update.retry"),
        );
        retryBtn.addEventListener("click", installUpdate);
        banner.appendChild(retryBtn);
      }
      const dismissBtn = createElement(
        "button",
        { class: "update-banner-btn update-banner-later" },
        connectText("update.dismiss"),
      );
      dismissBtn.addEventListener("click", () => {
        dismissed = true;
        removeBanner();
      });
      banner.appendChild(dismissBtn);
    }
  }

  function removeBanner(): void {
    if (banner !== null) {
      banner.remove();
      banner = null;
    }
  }

  function mount(target: Element): void {
    container = target;
    // Present from mount, empty: a screen reader skips a live region inserted
    // already filled. The banner text itself is visual-only; this carries the
    // phase so an update is heard once without reading every progress tick.
    liveRegion = createElement("div", {
      class: "sr-only",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "data-testid": "update-announce",
    });
    target.appendChild(liveRegion);
    unsubscribeInstall = subscribeToUpdateInstall(renderInstallState);
    // Delay the check slightly so the main UI renders first
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void performCheck();
    }, 3000);
  }

  function destroy(): void {
    unsubscribeInstall?.();
    unsubscribeInstall = null;
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    removeBanner();
    liveRegion?.remove();
    liveRegion = null;
    container = null;
  }

  return { mount, destroy };
}
