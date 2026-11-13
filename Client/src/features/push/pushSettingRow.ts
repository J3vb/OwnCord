/**
 * Settings → Notifications in the Android app: "Notifications when the app is
 * closed". It shows what the push setup found for the connected server and
 * offers the one step that moves it on: get a push app (Play Store, F-Droid
 * under it), or pick one of several. Installing one needs no second tap: the
 * app looks again when it comes back into view.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { settingsText as t } from "../../i18n/settings";
import { desktop } from "../../platform/desktop";
import type { PushDistributor } from "../../platform/contracts/pushRegistration";
import { setStatusIcon, statusIcon, type StatusKind } from "../settings/status";
import { chooseDistributor } from "./pushSubscription";
import { pushStore, type PushSetting, type PushState } from "./store";

const NTFY_PLAY = "https://play.google.com/store/apps/details?id=io.heckel.ntfy";
const NTFY_FDROID = "https://f-droid.org/packages/io.heckel.ntfy/";

interface View {
  readonly kind: StatusKind;
  readonly word: () => string;
  readonly desc: () => string;
}

const VIEW: Readonly<Record<PushSetting, View>> = {
  off: {
    kind: "pending",
    word: () => t("notifications.push.state.off"),
    desc: () => t("notifications.push.off"),
  },
  checking: {
    kind: "pending",
    word: () => t("notifications.push.state.checking"),
    desc: () => t("notifications.push.checking"),
  },
  on: {
    kind: "ok",
    word: () => t("notifications.push.state.on"),
    desc: () => t("notifications.push.on"),
  },
  install: {
    kind: "warn",
    word: () => t("notifications.push.state.install"),
    desc: () => t("notifications.push.install"),
  },
  choose: {
    kind: "warn",
    word: () => t("notifications.push.state.choose"),
    desc: () => t("notifications.push.choose"),
  },
  "server-off": {
    kind: "pending",
    word: () => t("notifications.push.state.serverOff"),
    desc: () => t("notifications.push.serverOff"),
  },
  failed: {
    kind: "crit",
    word: () => t("notifications.push.state.failed"),
    desc: () => t("notifications.push.failed"),
  },
};

function linkButton(label: string, testId: string, url: string, signal: AbortSignal): HTMLElement {
  const button = createElement(
    "button",
    { class: "ac-btn", type: "button", "data-testid": testId },
    label,
  );
  button.addEventListener("click", () => void desktop.urlOpener.open(url), { signal });
  return button;
}

function chooseButtons(
  distributors: readonly PushDistributor[],
  signal: AbortSignal,
): HTMLElement[] {
  return distributors.map((d) => {
    const button = createElement(
      "button",
      { class: "ac-btn", type: "button", "data-testid": `push-choose-${d.id}` },
      d.name,
    );
    button.addEventListener("click", () => void chooseDistributor(d.id), { signal });
    return button;
  });
}

function actionsFor(state: PushState, signal: AbortSignal): HTMLElement[] {
  if (state.setting === "install") {
    return [
      linkButton(t("notifications.push.getNtfy"), "push-get-ntfy", NTFY_PLAY, signal),
      linkButton(t("notifications.push.fdroid"), "push-fdroid", NTFY_FDROID, signal),
    ];
  }
  if (state.setting === "choose") return chooseButtons(state.distributors, signal);
  return [];
}

export function buildPushRow(signal: AbortSignal): HTMLDivElement {
  const row = createElement("div", { class: "setting-row", "data-testid": "push-row" });
  const info = createElement("div", {});
  const desc = createElement("div", { class: "setting-desc", "data-testid": "push-desc" });
  appendChildren(
    info,
    createElement("div", { class: "setting-label" }, t("notifications.push.label")),
    desc,
  );
  const status = createElement("span", { class: "status-pill", "data-testid": "push-status" });
  const icon = statusIcon("pending");
  const word = createElement("span", {});
  status.append(icon, word);
  const actions = createElement("div", { class: "setting-actions" });
  appendChildren(row, info, actions);

  const render = (state: PushState): void => {
    const view = VIEW[state.setting];
    setStatusIcon(icon, view.kind);
    setText(word, view.word());
    setText(desc, view.desc());
    actions.replaceChildren(status, ...actionsFor(state, signal));
  };
  render(pushStore.getState());
  const unsubscribe = pushStore.subscribe(render);
  signal.addEventListener("abort", unsubscribe, { once: true });
  return row;
}
