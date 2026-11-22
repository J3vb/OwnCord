// The "Screen layout" row of Settings > Appearance (Command Deck preview).
// It shows the STORED choice; a note appears while that differs from the
// layout this load is running, because a pick applies on the next start.
import { createElement, setText } from "@lib/dom";
import {
  loadStoredScreenLayout,
  runningScreenLayout,
  saveScreenLayout,
  screenLayoutAvailable,
  type ScreenLayout,
} from "@lib/prefs/screenLayout";
import { settingsText as t } from "../../i18n/settings";
import { isAndroidApp } from "../voice/native/platform";
import { buildChoiceRow } from "./settingRow";

/** The row, or null when it does not show (Developer mode off, or the Android app). */
export function buildScreenLayoutRow(signal: AbortSignal): HTMLDivElement | null {
  if (!screenLayoutAvailable()) return null;
  // Always present so a screen reader announces the text when it is set.
  const note = createElement("div", { class: "setting-note", role: "status" });
  const paintNote = (): void => {
    const pending = loadStoredScreenLayout() !== runningScreenLayout();
    setText(note, pending ? t("appearance.screenLayout.pending") : "");
  };
  const { row } = buildChoiceRow<ScreenLayout>({
    signal,
    label: t("appearance.screenLayout"),
    desc: t("appearance.screenLayout.desc"),
    testId: "screen-layout",
    options: [
      ["classic", t("appearance.screenLayout.classic")],
      ["deck", t("appearance.screenLayout.deck")],
    ],
    current: loadStoredScreenLayout,
    save: (value) => {
      saveScreenLayout(value);
      paintNote();
    },
  });
  row.querySelector(".setting-info")?.appendChild(note);
  paintNote();
  return row;
}

/**
 * Search text for the layout rows: Screen layout when offered, then Member
 * list position on a desktop running Classic (Deck pins the list right).
 */
export function layoutSearchEntries(): string[] {
  const screen = screenLayoutAvailable()
    ? [t("appearance.screenLayout"), t("appearance.screenLayout.desc")]
    : [];
  if (isAndroidApp() || runningScreenLayout() === "deck") return screen;
  return [...screen, t("appearance.memberLayout"), t("appearance.memberLayout.desc")];
}

/** Part of the search cache key: Developer mode and the running layout change what Appearance shows. */
export function layoutSearchKey(): string {
  return `${screenLayoutAvailable() ? "dev" : "nodev"}:${runningScreenLayout()}`;
}
