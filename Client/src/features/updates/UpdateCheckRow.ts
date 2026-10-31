/**
 * "Check for updates" — the on-demand twin of the periodic check. It runs the
 * active checker (components/UpdateNotifier mounts it) with the `manual`
 * reason, so a dismissed version is offered again, and reports in place. An
 * available update gets the existing install action; its progress shows in the
 * update banner the notifier raises for the same outcome.
 */

import { createElement, appendChildren, setText } from "../../lib/dom";
import { createLogger } from "../../lib/logger";
import { getActiveUpdateChecker } from "./updateChecker";
import type { UpdateOutcome } from "./updateChecker";
import { downloadAndInstallUpdate, subscribeToUpdateInstall } from "../../lib/net/updater";
import type { UpdateInstallState } from "../../lib/net/updater";
import { connectText } from "../../i18n/connect";
import { settingsText as t } from "../../i18n/settings";

const log = createLogger("UpdateCheckRow");

// The shared field-message classes (login.css), as features/settings/helpers
// `showOutcome` uses them; a lower layer cannot import that UI module.
const OUTCOME_CLASS = {
  error: "form-error",
  success: "form-status",
  warning: "form-warning",
} as const;
type Outcome = keyof typeof OUTCOME_CLASS;

function showOutcome(el: HTMLElement, outcome: Outcome, text: string): void {
  el.className = OUTCOME_CLASS[outcome];
  setText(el, text);
}

/** The app-wide install state now: the subscription replays it on subscribe. */
function currentInstallState(): UpdateInstallState {
  let state: UpdateInstallState = { status: "idle" };
  subscribeToUpdateInstall((s) => {
    state = s;
  })();
  return state;
}

/** Text for an install that is under way or done: offering Install again would
 *  only rejoin the same operation, so say where it stands instead. A failed
 *  download that can be retried is not one of these. */
export function installInProgressText(state: UpdateInstallState): string | null {
  if (state.status === "downloading") return connectText("update.downloading");
  if (state.status === "installing") return connectText("update.installing");
  if (state.status === "restarting") return connectText("update.installedRestarting");
  if (state.status === "failed" && state.restartRequired) {
    return connectText("update.installedRestart");
  }
  return null;
}

export function buildUpdateCheckRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  const status = createElement("div", {
    class: OUTCOME_CLASS.success,
    role: "status",
    "data-testid": "update-check-status",
  });
  appendChildren(
    info,
    createElement("div", { class: "setting-label" }, t("updates.label")),
    createElement("div", { class: "setting-desc" }, t("updates.desc")),
    status,
  );

  const actions = createElement("div", { class: "settings-toolbar" });
  const checkBtn = createElement(
    "button",
    { class: "ac-btn secondary update-check-btn", type: "button" },
    t("updates.check"),
  );
  appendChildren(actions, checkBtn);

  if (getActiveUpdateChecker() === null) {
    checkBtn.disabled = true;
    showOutcome(status, "warning", t("updates.noServer"));
  }

  let installBtn: HTMLButtonElement | null = null;
  const clearInstall = (): void => {
    installBtn?.remove();
    installBtn = null;
  };

  const show = (outcome: UpdateOutcome, serverUrl: string): void => {
    switch (outcome.kind) {
      case "up-to-date":
        showOutcome(status, "success", t("updates.upToDate"));
        return;
      case "failed":
        showOutcome(status, "error", t("updates.failed"));
        return;
      case "manual-upgrade":
        showOutcome(
          status,
          "warning",
          connectText(outcome.unconfirmed === true ? "update.unconfirmed" : "update.unavailable"),
        );
        return;
      case "available": {
        const underway = installInProgressText(currentInstallState());
        if (underway !== null) {
          showOutcome(status, "warning", underway);
          return;
        }
        showOutcome(
          status,
          "success",
          connectText("update.available", { version: outcome.version }),
        );
        installBtn = createElement(
          "button",
          { class: "ac-btn update-check-install", type: "button" },
          connectText("update.now"),
        );
        installBtn.addEventListener(
          "click",
          () => {
            void downloadAndInstallUpdate(serverUrl).catch((err: unknown) => {
              log.error("Update install failed", { error: String(err) });
            });
          },
          { signal },
        );
        actions.appendChild(installBtn);
        return;
      }
    }
  };

  checkBtn.addEventListener(
    "click",
    () => {
      const checker = getActiveUpdateChecker();
      if (checker === null) {
        showOutcome(status, "warning", t("updates.noServer"));
        return;
      }
      clearInstall();
      checkBtn.disabled = true;
      showOutcome(status, "success", t("updates.checking"));
      void checker.checkNow("manual").then((outcome) => {
        if (signal.aborted) return;
        checkBtn.disabled = false;
        show(outcome, checker.serverUrl);
      });
    },
    { signal },
  );

  appendChildren(row, info, actions);
  return row;
}
