// UpdateNotifier — shows a non-modal banner when a client update is available.
// Mounts at the top of the main page and allows the user to update or dismiss.

import { createElement, appendChildren } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { checkForUpdate, downloadAndInstallUpdate, subscribeToUpdateInstall } from "@lib/updater";
import type { DownloadProgress, UpdateInstallState } from "@lib/updater";
import type { MountableComponent } from "@lib/safe-render";

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
    return `Downloading update… ${pct}%`;
  }
  const mb = (p.received / (1024 * 1024)).toFixed(1);
  return `Downloading update… ${mb} MB`;
}

export function createUpdateNotifier(options: UpdateNotifierOptions): MountableComponent {
  const { serverUrl } = options;
  let container: Element | null = null;
  let banner: HTMLDivElement | null = null;
  let dismissed = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeInstall: (() => void) | null = null;
  let installState: UpdateInstallState = { status: "idle" };

  async function performCheck(): Promise<void> {
    if (dismissed || installState.status !== "idle") return;

    const result = await checkForUpdate(serverUrl);
    if (
      dismissed ||
      installState.status !== "idle" ||
      !result.available ||
      result.version === null
    ) {
      return;
    }

    showBanner(result.version, result.body ?? "");
  }

  function showBanner(version: string, _notes: string): void {
    if (container === null || banner !== null) return;

    banner = createElement("div", { class: "update-banner" });

    const text = createElement(
      "span",
      { class: "update-banner-text" },
      `Update v${version} available`,
    );

    const updateBtn = createElement(
      "button",
      { class: "update-banner-btn update-banner-install" },
      "Update Now",
    );
    updateBtn.addEventListener("click", () => {
      void installUpdate();
    });

    const laterBtn = createElement(
      "button",
      { class: "update-banner-btn update-banner-later" },
      "Later",
    );
    laterBtn.addEventListener("click", () => {
      dismissed = true;
      removeBanner();
    });

    appendChildren(banner, text, updateBtn, laterBtn);
    container.prepend(banner);
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
          ? "Downloading update…"
          : formatDownloadProgress(state.progress)
        : state.status === "restarting"
          ? "Update installed. Restarting…"
          : state.restartRequired
            ? "Update installed. Please restart OwnCord to finish."
            : "Update failed. Please try again later.";
    banner.replaceChildren(createElement("span", { class: "update-banner-text" }, text));

    if (state.status === "failed") {
      if (!state.restartRequired) {
        const retryBtn = createElement(
          "button",
          { class: "update-banner-btn update-banner-install" },
          "Retry",
        );
        retryBtn.addEventListener("click", installUpdate);
        banner.appendChild(retryBtn);
      }
      const dismissBtn = createElement(
        "button",
        { class: "update-banner-btn update-banner-later" },
        "Dismiss",
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
    container = null;
  }

  return { mount, destroy };
}
