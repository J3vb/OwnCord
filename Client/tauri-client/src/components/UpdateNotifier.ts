// UpdateNotifier — shows a non-modal banner when a client update is available.
// Mounts at the top of the main page and allows the user to update or dismiss.

import { createElement, appendChildren } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { checkForUpdate, downloadAndInstallUpdate } from "@lib/updater";
import type { MountableComponent } from "@lib/safe-render";

const log = createLogger("update-notifier");

export interface UpdateNotifierOptions {
  readonly serverUrl: string;
}

export function createUpdateNotifier(options: UpdateNotifierOptions): MountableComponent {
  const { serverUrl } = options;
  let container: Element | null = null;
  let banner: HTMLDivElement | null = null;
  let dismissed = false;

  async function performCheck(): Promise<void> {
    if (dismissed) return;

    const result = await checkForUpdate(serverUrl);
    if (!result.available || result.version === null) return;

    showBanner(result.version, result.body ?? "");
  }

  function showBanner(version: string, _notes: string): void {
    if (container === null || banner !== null) return;

    banner = createElement("div", { class: "update-banner" });

    const text = createElement("span", { class: "update-banner-text" },
      `Update v${version} available`);

    const updateBtn = createElement("button", { class: "update-banner-btn update-banner-install" },
      "Update Now");
    updateBtn.addEventListener("click", () => {
      void installUpdate();
    });

    const laterBtn = createElement("button", { class: "update-banner-btn update-banner-later" },
      "Later");
    laterBtn.addEventListener("click", () => {
      dismissed = true;
      removeBanner();
    });

    appendChildren(banner, text, updateBtn, laterBtn);
    container.prepend(banner);
  }

  async function installUpdate(): Promise<void> {
    if (banner === null) return;

    // Replace banner content with progress indicator
    while (banner.firstChild) banner.removeChild(banner.firstChild);
    const progress = createElement("span", { class: "update-banner-text" },
      "Downloading update...");
    banner.appendChild(progress);

    try {
      await downloadAndInstallUpdate(serverUrl);
      // App will relaunch — this code won't execute after relaunch()
    } catch (err) {
      log.error("Update install failed", { error: String(err) });
      while (banner.firstChild) banner.removeChild(banner.firstChild);
      const errorText = createElement("span", { class: "update-banner-text" },
        "Update failed. Please try again later.");
      const dismissBtn = createElement("button", { class: "update-banner-btn update-banner-later" },
        "Dismiss");
      dismissBtn.addEventListener("click", () => {
        dismissed = true;
        removeBanner();
      });
      appendChildren(banner, errorText, dismissBtn);
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
    // Delay the check slightly so the main UI renders first
    setTimeout(() => { void performCheck(); }, 3000);
  }

  function destroy(): void {
    removeBanner();
    container = null;
  }

  return { mount, destroy };
}
