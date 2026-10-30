// UpdateNotifier — shows a non-modal banner when a client update is available.
// Mounts at the top of the main page and allows the user to update or dismiss.

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { downloadAndInstallUpdate, subscribeToUpdateInstall } from "@lib/net/updater";
import { createUpdateChecker } from "../features/updates/updateChecker";
import type { UpdateCheckReason, UpdateOutcome } from "../features/updates/updateChecker";
import { setAvailableUpdate } from "../features/updates/availableUpdate";
import { openSettings, uiStore } from "@stores/ui.store";
import type { DownloadProgress, UpdateInstallState } from "@lib/net/updater";
import type { MountableComponent } from "@lib/text/safeRender";
import { connectText } from "../i18n/connect";

const log = createLogger("update-notifier");

export interface UpdateNotifierOptions {
  readonly serverUrl: string;
  /** Keep checking while mounted — on an interval and after a reconnect —
   *  and take the Settings "Check for updates" button.
   *  The main page sets it; the connect page's refused-client notifier needs
   *  the one startup check only. */
  readonly keepChecking?: boolean;
}

const MANUAL_KEY = "manual-upgrade";

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
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

function toMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** "38.4 of 61.9 MB" under the progress bar, or null while the size is unknown. */
export function formatDownloadSize(p: DownloadProgress): string | null {
  if (p.total === null || p.total <= 0) return null;
  return connectText("update.progressMb", {
    received: toMb(Math.min(p.received, p.total)),
    total: toMb(p.total),
  });
}

/** The banner's fixed frame: an icon tile, then a body for the headline and
 *  its second line. Callers add the actions after the body. */
function buildFrame(banner: HTMLDivElement, icon: IconName, headline: string): HTMLDivElement {
  const tile = createElement("div", { class: "update-banner-icon" });
  tile.appendChild(createIcon(icon, 18));
  const body = createElement("div", { class: "update-banner-body" });
  body.appendChild(createElement("span", { class: "update-banner-text" }, headline));
  banner.replaceChildren(tile, body);
  return body;
}

function buildProgressBar(p: DownloadProgress): HTMLDivElement | null {
  const size = formatDownloadSize(p);
  if (size === null || p.total === null) return null;
  const pct = Math.min(100, Math.max(0, (p.received / p.total) * 100));
  const row = createElement("div", { class: "update-banner-sub" });
  // The headline already carries the percentage; the bar repeats it visually.
  const track = createElement("div", { class: "update-banner-progress", "aria-hidden": "true" });
  const fill = createElement("div", { class: "update-banner-progress-fill" });
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  appendChildren(row, track, createElement("span", { class: "update-banner-size" }, size));
  return row;
}

function failedText(state: Extract<UpdateInstallState, { status: "failed" }>): string {
  if (state.restartRequired) return connectText("update.installedRestart");
  if (state.reason === "cancelled") return connectText("update.cancelled");
  if (state.reason === "not-authorized") return connectText("update.notAuthorized");
  return connectText("update.failed");
}

export function createUpdateNotifier(options: UpdateNotifierOptions): MountableComponent {
  const { serverUrl, keepChecking = false } = options;
  let container: Element | null = null;
  let banner: HTMLDivElement | null = null;
  /** Polite live region carrying the coarse install status, so a screen
   *  reader hears "update available / downloading / installed / failed" once —
   *  never the once-a-percent progress tick, which would read out continuously. */
  let liveRegion: HTMLDivElement | null = null;
  /** What the user last dismissed (a version, or MANUAL_KEY): that same offer is
   *  not shown again by a background check, a newer version is. */
  let dismissedKey: string | null = null;
  /** The offer the banner currently shows. */
  let shownKey: string | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeInstall: (() => void) | null = null;
  let unsubscribeOutcome: (() => void) | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  const checker = createUpdateChecker({ serverUrl });
  let installState: UpdateInstallState = { status: "idle" };

  function announce(text: string): void {
    // Idempotent: re-setting identical text on a live region can re-read it,
    // and the download phase fires this on every progress tick.
    if (liveRegion !== null && liveRegion.textContent !== text) setText(liveRegion, text);
  }

  function installBusy(): boolean {
    return (
      installState.status !== "idle" &&
      !(installState.status === "failed" && !installState.restartRequired)
    );
  }

  function handleOutcome(outcome: UpdateOutcome, reason: UpdateCheckReason): void {
    // The About tab reads the offer even when the banner was dismissed.
    if (outcome.kind === "available") {
      setAvailableUpdate({ version: outcome.version, body: outcome.body, serverUrl });
    } else if (outcome.kind !== "failed") {
      setAvailableUpdate(null);
    }
    if (installBusy()) return;
    const key =
      outcome.kind === "available"
        ? outcome.version
        : outcome.kind === "manual-upgrade"
          ? MANUAL_KEY
          : null;
    if (key === null) return;
    // The user asked (Settings → Check for updates): a dismissal does not apply.
    if (reason === "manual") dismissedKey = null;
    else if (key === dismissedKey) return;
    if (shownKey === key) return;
    removeBanner();
    if (outcome.kind === "available") showBanner(outcome.version);
    else showManualUpgradeBanner(outcome.kind === "manual-upgrade" && outcome.unconfirmed === true);
  }

  /**
   * A package install (see `manual_upgrade` in `@lib/net/updater`): the server
   * serves no updater artifact for it, so the check can never report an
   * available update however far behind the client is. Answering that with
   * silence would be a claim — "you are up to date" — the user cannot check.
   *
   * `unconfirmed` is the .deb install that can update itself but was given no
   * offer (an older server, one withholding the release, a release without a
   * .deb). It may well be current, so it is told only that the server offered
   * nothing, not that the install cannot update itself.
   */
  function showManualUpgradeBanner(unconfirmed: boolean): void {
    if (container === null || banner !== null) return;

    const text = connectText(unconfirmed ? "update.unconfirmed" : "update.unavailable");
    banner = createElement("div", { class: "update-banner" });
    shownKey = MANUAL_KEY;
    buildFrame(banner, "triangle-alert", text);

    const dismissBtn = createElement(
      "button",
      { class: "update-banner-btn update-banner-later" },
      connectText("update.dismiss"),
    );
    dismissBtn.addEventListener("click", () => {
      dismissedKey = shownKey;
      removeBanner();
    });

    banner.appendChild(dismissBtn);
    container.prepend(banner);
    announce(text);
  }

  function showBanner(version: string): void {
    if (container === null || banner !== null) return;

    banner = createElement("div", { class: "update-banner" });
    shownKey = version;
    const body = buildFrame(banner, "download", connectText("update.ready", { version }));

    // The notes live on the About tab's update card, which reads the same offer.
    const notesBtn = createElement(
      "button",
      { class: "update-banner-link", type: "button" },
      connectText("update.seeWhatsNew"),
    );
    // i18n-exempt: settings tab key, not shown text
    notesBtn.addEventListener("click", () => openSettings("About"));

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
      dismissedKey = shownKey;
      removeBanner();
    });

    appendChildren(banner, notesBtn, updateBtn, laterBtn);
    if (isWindows()) {
      // The Windows installer is unsigned, so SmartScreen warns when the
      // updater launches it. Say so before the click, not as a surprise.
      const warning = createElement("span", {
        class: "update-banner-warning update-banner-sub",
        id: "update-banner-warning",
      });
      warning.appendChild(createIcon("triangle-alert", 13));
      warning.append(connectText("update.smartScreen"));
      body.appendChild(warning);
      updateBtn.setAttribute("aria-describedby", "update-banner-warning");
    }
    container.prepend(banner);
    announce(connectText("update.ready", { version }));
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
        : state.status === "installing"
          ? connectText("update.installing")
          : state.status === "restarting"
            ? connectText("update.installedRestarting")
            : failedText(state);
    const failed = state.status === "failed" && !state.restartRequired;
    const body = buildFrame(banner, failed ? "triangle-alert" : "download", text);
    if (state.status === "downloading" && state.progress !== null) {
      const bar = buildProgressBar(state.progress);
      if (bar !== null) body.appendChild(bar);
    }

    // Announce only the coarse transition. A percentage tick is not a new
    // event; reading "Downloading update… 47%" every frame is noise, so the
    // live region keeps the phase and updates only when it changes.
    if (state.status === "downloading") {
      announce(connectText("update.downloading"));
    } else if (state.status === "installing") {
      announce(text);
    } else if (state.status === "restarting") {
      announce(connectText("update.installedRestarting"));
    } else {
      announce(failedText(state));
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
        dismissedKey = shownKey;
        removeBanner();
      });
      banner.appendChild(dismissBtn);
    }
  }

  function removeBanner(): void {
    if (banner !== null) {
      banner.remove();
      banner = null;
      shownKey = null;
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
    unsubscribeOutcome = checker.onOutcome(handleOutcome);
    if (keepChecking) {
      // A socket that comes back may be an updated server: ask again. Read-only
      // use of the store; this is not a ws.on handler and writes nothing.
      let wasDown = false;
      unsubscribeStatus = uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        (status) => {
          if (status !== "connected") wasDown = true;
          else if (wasDown) {
            wasDown = false;
            checker.notifyReconnected();
          }
        },
      );
      checker.start();
    }
    // Delay the first check slightly so the main UI renders first
    checkTimer = setTimeout(() => {
      checkTimer = null;
      if (!installBusy()) void checker.checkNow("startup");
    }, 3000);
  }

  function destroy(): void {
    unsubscribeInstall?.();
    unsubscribeInstall = null;
    unsubscribeOutcome?.();
    unsubscribeOutcome = null;
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    checker.stop();
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    removeBanner();
    // Another server may offer a different version, or none.
    setAvailableUpdate(null);
    liveRegion?.remove();
    liveRegion = null;
    container = null;
  }

  return { mount, destroy };
}
