/**
 * "Check for updates" — the on-demand twin of the periodic check. It runs the
 * active checker (components/UpdateNotifier mounts it) with the `manual`
 * reason, so a dismissed version is offered again, and reports in place. An
 * available update gets the existing install action; its progress shows in the
 * update banner the notifier raises for the same outcome.
 */

import { createElement, appendChildren } from "../../lib/dom";
import { createLogger } from "../../lib/logger";
import { getActiveUpdateChecker } from "./updateChecker";
import type { UpdateOutcome } from "./updateChecker";
import { downloadAndInstallUpdate } from "../../lib/updater";
import { connectText } from "../../i18n/connect";
import { settingsText as t } from "../../i18n/settings";
import { outcomeEl, showOutcome } from "../../components/settings/helpers";

const log = createLogger("UpdateCheckRow");

export function buildUpdateCheckRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  const status = outcomeEl("success", "update-check-status");
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
        showOutcome(status, "warning", connectText("update.unavailable"));
        return;
      case "available": {
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
