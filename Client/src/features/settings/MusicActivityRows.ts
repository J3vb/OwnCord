/**
 * Settings > Advanced > Activity > music: the "Share the music
 * you're listening to" switch, what this device sees right now, and "Your
 * players" with a "Show to others" switch each.
 *
 * Device-local like the game switch (a `localStorage` pref, on by default, no
 * toast): the server never learns the setting, only the one song while it is
 * on. Turning it off stops the read and tells the server at once; the loop
 * that does both listens for the pref change (`@lib/presence/musicActivity`). The
 * "Detected now" line reads only while the switch is on, with the hidden
 * players left out, so what it shows is what others can see.
 */

import { appendChildren, clearChildren, createElement, setOwnedTimeout, setText } from "@lib/dom";
import {
  MUSIC_ACTIVITY_PREF_KEY,
  isMusicActivityShared,
  isPlayerHidden,
  loadMusicPrefs,
  loadSeenPlayers,
  playerKey,
  saveMusicPrefs,
  toMediaPrefs,
  withPlayerHidden,
  type SeenPlayer,
} from "@lib/prefs/musicActivityPrefs";
import {
  hasReceivedReady,
  onGameActivityPolicy,
  serverSupportsListeningActivity,
} from "@lib/net/serverCapabilities";
import { savePref } from "@lib/prefs/preferences";
import { desktop } from "../../platform/desktop";
import { listeningDetailsText as t } from "../../i18n/listeningDetails";
import { createToggle } from "./helpers";

/** How often the line re-checks; the same beat as the loop that sends it. */
const REFRESH_MS = 10_000;

/** Whether the server has said member activity is off (it covers music). */
function serverOffNow(): boolean {
  return hasReceivedReady() && !serverSupportsListeningActivity();
}

/** The players listed: those seen, then any hidden id nothing else lists (so it
 *  can still be shown again). */
function playerRows(): SeenPlayer[] {
  const rows = loadSeenPlayers();
  const keys = new Set(rows.map((p) => playerKey(p.id)));
  for (const id of loadMusicPrefs().hidden) {
    if (keys.has(playerKey(id))) continue;
    keys.add(playerKey(id));
    rows.push({ id, name: id });
  }
  return rows;
}

/** What the list is drawn from, to redraw only when it changed. */
function snapshot(): string {
  return JSON.stringify([loadMusicPrefs(), loadSeenPlayers()]);
}

/** The section's rows, or none where this build cannot read the song (the web build). */
export function buildMusicActivityRows(signal: AbortSignal): HTMLElement[] {
  if (!desktop.mediaDetector.available) return [];

  const row = createElement("div", { class: "setting-row", "data-testid": "music-activity-row" });
  const info = createElement("div", {});
  const label = createElement("div", { class: "setting-label" }, t("settings.share.label"));
  const desc = createElement("div", { class: "setting-desc" }, t("settings.share.desc"));
  const detected = createElement("div", {
    class: "setting-desc",
    "data-testid": "music-activity-detected",
    role: "status",
  });
  const serverOff = createElement(
    "div",
    { class: "setting-desc", "data-testid": "music-activity-server-off", role: "status" },
    t("settings.serverOff"),
  );
  appendChildren(info, label, desc, serverOff, detected);

  // A read that answers after the switch went off, or after the pane closed,
  // must not paint: `scan` numbers them and only the newest may.
  let scan = 0;
  let cancelRefresh: (() => void) | null = null;

  function refresh(): void {
    cancelRefresh?.();
    const mine = ++scan;
    serverOff.hidden = !serverOffNow();
    // While the server shows no music, what this device detects is not shown.
    if (!isMusicActivityShared() || serverOffNow()) {
      setText(detected, "");
      detected.hidden = true;
      return;
    }
    detected.hidden = false;
    void desktop.mediaDetector.detect(toMediaPrefs(loadMusicPrefs())).then((reading) => {
      if (mine !== scan || signal.aborted) return;
      // "Unknown" (a read still running) keeps the line as it was.
      if (reading.state === "playing") {
        setText(detected, t("settings.detected", { title: reading.title, player: reading.player }));
      } else if (reading.state === "none" || detected.textContent === "") {
        setText(detected, t("settings.detectedNone"));
      }
      cancelRefresh = setOwnedTimeout(signal, refresh, REFRESH_MS);
    });
  }

  const toggle = createToggle(isMusicActivityShared(), {
    signal,
    label: t("settings.share.label"),
    onChange: (nowOn) => {
      savePref(MUSIC_ACTIVITY_PREF_KEY, nowOn);
      refresh();
    },
  });
  appendChildren(row, info, toggle);
  signal.addEventListener("abort", () => cancelRefresh?.(), { once: true });
  const unsubPolicy = onGameActivityPolicy(refresh);
  signal.addEventListener("abort", unsubPolicy, { once: true });
  refresh();

  return [row, ...buildPlayersSection(signal)];
}

/** "Your players": the list, drawn from the device's history and choices. */
function buildPlayersSection(signal: AbortSignal): HTMLElement[] {
  const title = createElement(
    "div",
    { class: "setting-label game-list-title" },
    t("players.title"),
  );
  const desc = createElement("div", { class: "setting-desc" }, t("players.desc"));
  const list = createElement("div", { "data-testid": "music-activity-players" });
  let drawn = "";

  function renderList(): void {
    drawn = snapshot();
    clearChildren(list);
    const rows = playerRows();
    if (rows.length === 0) {
      list.appendChild(
        createElement(
          "div",
          { class: "setting-desc", "data-testid": "music-activity-players-empty" },
          t("players.empty"),
        ),
      );
      return;
    }
    const prefs = loadMusicPrefs();
    for (const player of rows) {
      const item = createElement("div", { class: "setting-row", "data-testid": "player-row" });
      const info = createElement("div", { class: "game-row-info" });
      info.appendChild(
        createElement(
          "div",
          { class: "setting-label", "data-testid": "player-row-name" },
          player.name,
        ),
      );
      const actions = createElement("div", { class: "game-row-actions" });
      actions.appendChild(
        createElement(
          "span",
          { class: "setting-desc", "aria-hidden": "true" },
          t("players.show.label"),
        ),
      );
      actions.appendChild(
        createToggle(!isPlayerHidden(prefs, player.id), {
          signal,
          label: t("players.show.aria", { player: player.name }),
          onChange: (nowOn) => {
            saveMusicPrefs(withPlayerHidden(loadMusicPrefs(), player.id, !nowOn));
          },
        }),
      );
      appendChildren(item, info, actions);
      list.appendChild(item);
    }
  }

  // A player seen while the pane is open shows when the pointer comes to the
  // list, and only if something changed: a redraw would drop the focus of a
  // keyboard user, so focus moving through the list never redraws it.
  list.addEventListener(
    "pointerenter",
    () => {
      if (snapshot() !== drawn) renderList();
    },
    { signal },
  );

  renderList();
  return [title, desc, list];
}
