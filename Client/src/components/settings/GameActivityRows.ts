/**
 * Settings > Advanced > Activity: the "Share the game you are
 * playing" switch and what this device sees right now.
 *
 * Device-local like the other switches here (a `localStorage` pref, on by
 * default, no toast): the server never learns the setting, only the one game
 * name while it is on. Turning it off stops the scan and tells the server at
 * once; the loop that does both listens for the pref change (`@lib/gameActivity`).
 * The "Detected now" line scans only while the switch is on, so what it shows
 * is what others can see. "Your games" is added below it (`./GameActivityGames`).
 */

import { createElement, appendChildren, setOwnedTimeout, setText } from "@lib/dom";
import { GAME_ACTIVITY_PREF_KEY, isGameActivityShared } from "@lib/gameActivityBridge";
import { displayName, loadGamePrefs, toDetectPrefs } from "@lib/gameActivityPrefs";
import {
  hasReceivedReady,
  onGameActivityPolicy,
  serverSupportsGameActivity,
} from "@lib/serverCapabilities";
import { savePref } from "@lib/preferences";
import { desktop } from "../../platform/desktop";
import { gameActivityText as t } from "../../i18n/gameActivity";
import { buildGamesSection } from "./GameActivityGames";
import { createToggle } from "./helpers";

/** How often the line re-checks; the same beat as the loop that sends it. */
const REFRESH_MS = 15_000;

/** Whether the server has said game activity is off. */
function serverOffNow(): boolean {
  return hasReceivedReady() && !serverSupportsGameActivity();
}

/** The section's rows, or none where this build cannot detect a game (the web build). */
export function buildGameActivityRows(signal: AbortSignal): HTMLElement[] {
  if (!desktop.gameDetector.available) return [];

  const title = createElement("div", { class: "settings-section-title" }, t("settings.title"));
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  const label = createElement("div", { class: "setting-label" }, t("settings.share.label"));
  const desc = createElement("div", { class: "setting-desc" }, t("settings.share.desc"));
  const detected = createElement("div", {
    class: "setting-desc",
    "data-testid": "game-activity-detected",
    role: "status",
  });
  // An admin turned game activity off for this server.
  const serverOff = createElement(
    "div",
    { class: "setting-desc", "data-testid": "game-activity-server-off", role: "status" },
    t("settings.serverOff"),
  );
  appendChildren(info, label, desc, serverOff, detected);

  // A scan that answers after the switch went off, or after the pane closed,
  // must not paint: `scan` numbers them and only the newest may.
  let scan = 0;
  let cancelRefresh: (() => void) | null = null;

  function refresh(): void {
    cancelRefresh?.();
    const mine = ++scan;
    serverOff.hidden = !serverOffNow();
    // While the server shows no games, what this device detects is not shown.
    if (!isGameActivityShared() || serverOffNow()) {
      setText(detected, "");
      detected.hidden = true;
      return;
    }
    detected.hidden = false;
    const prefs = loadGamePrefs();
    void desktop.gameDetector.detect(toDetectPrefs(prefs)).then((game) => {
      if (mine !== scan || signal.aborted) return;
      // Shown as others see it: under the name it was renamed to.
      setText(
        detected,
        game === null
          ? t("settings.detectedNone")
          : t("settings.detected", { game: displayName(prefs, game.name) }),
      );
      cancelRefresh = setOwnedTimeout(signal, refresh, REFRESH_MS);
    });
  }

  const toggle = createToggle(isGameActivityShared(), {
    signal,
    label: t("settings.share.label"),
    onChange: (nowOn) => {
      savePref(GAME_ACTIVITY_PREF_KEY, nowOn);
      refresh();
    },
  });
  appendChildren(row, info, toggle);
  signal.addEventListener("abort", () => cancelRefresh?.(), { once: true });
  const unsubPolicy = onGameActivityPolicy(refresh);
  signal.addEventListener("abort", unsubPolicy, { once: true });
  refresh();

  return [
    createElement("div", { class: "settings-separator" }),
    title,
    row,
    ...buildGamesSection(signal),
  ];
}
