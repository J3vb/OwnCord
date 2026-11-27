// The "Screen layout" row of Settings > Appearance.
// It shows the STORED choice; a note appears while that differs from the
// layout this load is running, because a pick applies on the next start. While
// the note shows, a "Restart now" button applies it at once.
import { createElement, setOwnedTimeout, setText } from "@lib/dom";
import { isAndroidApp, isLinuxDesktop, isWindowsDesktop } from "@lib/hostOs";
import { createLogger } from "@lib/logger";
import {
  loadStoredScreenLayout,
  runningScreenLayout,
  saveScreenLayout,
  type ScreenLayout,
} from "@lib/prefs/screenLayout";
import { isInVoiceSession } from "@lib/voice/voiceDeafened";
import { settingsText as t } from "../../i18n/settings";
import { desktop } from "../../platform/desktop";
import { buildChoiceRow } from "./settingRow";

const log = createLogger("screenLayoutRow");

/** How long the in-call confirmation waits for a second click. */
const CONFIRM_WINDOW_MS = 3000;

/**
 * The "Restart now" button and its desktop sign-in line, shown only while a
 * pick is pending. `paint(pending)` creates them or removes them.
 */
function createRestartControl(
  signal: AbortSignal,
  host: HTMLElement,
): { paint: (pending: boolean) => void } {
  let button: HTMLButtonElement | null = null;
  let signInLine: HTMLElement | null = null;
  let confirmCancel: (() => void) | null = null;

  const setIdle = (): void => {
    confirmCancel = null;
    if (button === null) return;
    button.removeAttribute("data-confirm-pending");
    setText(button, t("appearance.screenLayout.restart"));
  };

  const relaunch = async (btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    log.info("restart to apply screen layout");
    try {
      await desktop.appProcess.relaunch();
    } catch (err) {
      log.error("restart failed", err);
      btn.disabled = false;
      setIdle();
    }
  };

  const onClick = (btn: HTMLButtonElement): void => {
    if (btn.disabled) return;
    if (confirmCancel !== null) {
      confirmCancel();
      setIdle();
      void relaunch(btn);
      return;
    }
    if (!isInVoiceSession()) {
      void relaunch(btn);
      return;
    }
    btn.setAttribute("data-confirm-pending", "true");
    setText(btn, t("appearance.screenLayout.restartConfirm"));
    confirmCancel = setOwnedTimeout(signal, setIdle, CONFIRM_WINDOW_MS);
  };

  const remove = (): void => {
    confirmCancel?.();
    confirmCancel = null;
    button?.remove();
    signInLine?.remove();
    button = null;
    signInLine = null;
  };

  const add = (): void => {
    if (button !== null) return;
    const btn = createElement("button", {
      class: "ac-btn secondary",
      type: "button",
      "data-testid": "screen-layout-restart",
    });
    setText(btn, t("appearance.screenLayout.restart"));
    btn.addEventListener("click", () => onClick(btn), { signal });
    button = btn;
    host.appendChild(btn);
    if (isWindowsDesktop() || isLinuxDesktop()) {
      const line = createElement("div", {
        class: "setting-note",
        "data-testid": "screen-layout-restart-signin",
      });
      setText(line, t("appearance.screenLayout.restartSignIn"));
      signInLine = line;
      host.appendChild(line);
    }
  };

  return { paint: (pending) => (pending ? add() : remove()) };
}

/** The row, shown on every platform. */
export function buildScreenLayoutRow(signal: AbortSignal): HTMLDivElement {
  // Always present so a screen reader announces the text when it is set.
  const note = createElement("div", { class: "setting-note", role: "status" });
  let restart: { paint: (pending: boolean) => void } | null = null;
  const paintNote = (): void => {
    const pending = loadStoredScreenLayout() !== runningScreenLayout();
    setText(note, pending ? t("appearance.screenLayout.pending") : "");
    restart?.paint(pending);
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
  const info = row.querySelector<HTMLElement>(".setting-info");
  info?.appendChild(note);
  if (info !== null) restart = createRestartControl(signal, info);
  paintNote();
  return row;
}

/**
 * Search text for the layout rows: Screen layout, then Member list position
 * on a desktop running Classic (Deck pins the list right).
 */
export function layoutSearchEntries(): string[] {
  const screen = [t("appearance.screenLayout"), t("appearance.screenLayout.desc")];
  if (isAndroidApp() || runningScreenLayout() === "deck") return screen;
  return [...screen, t("appearance.memberLayout"), t("appearance.memberLayout.desc")];
}

/** Part of the search cache key: the running layout changes what Appearance shows. */
export function layoutSearchKey(): string {
  return runningScreenLayout();
}
