// The app-lifetime steps main.ts runs around its core wiring. A feature that
// needs to start with the window adds a step here, not to main.ts.
import { Disposable } from "@lib/disposable";
import { isAndroidHost } from "@lib/hostPlatform";
import { applyStoredAppearance } from "@lib/prefs/appearance";
import {
  forgetAndroidInputDevice,
  migrateAutoInputSensitivity,
  migrateInputMode,
} from "@lib/ui/inputMode";
import { migrateVoiceSensitivityScale } from "@lib/voice/gateScale";
import { setSystemDateLocale } from "@lib/text/timeFormat";
import { openNotificationTarget } from "@lib/notificationDelivery";
import { initWindowState } from "@lib/prefs/windowState";
import { saveUserStatus } from "@lib/presence/userStatus";
import { getActivePresenceSender } from "@lib/presence/presence";
import type { ApiClient } from "@lib/api";
import type { createLogger } from "@lib/logger";
import {
  applyStoredCustomTheme,
  installCustomThemeEscape,
} from "../features/custom-themes/customTheme";
import { startZoom } from "../features/zoom/zoomKeys";
import { desktop } from "../platform/desktop";
import { installDeepLinks } from "./deepLinks";

export interface StartupContext {
  readonly log: ReturnType<typeof createLogger>;
}

export interface StartupStep {
  readonly name: string;
  run(ctx: StartupContext): void;
}

/** Runs before the first render, in this order: what the first frame shows
 *  and the preferences it reads must be settled first. */
export const beforeRenderSteps: readonly StartupStep[] = [
  {
    name: "appearance",
    run: () => {
      // Theme, font and compact mode; then a custom theme paints on top of
      // the built-in theme and accent.
      applyStoredAppearance();
      applyStoredCustomTheme();
      // Native webview zoom: the stored level now, and the zoom keys everywhere.
      startZoom(() => import("../features/zoom").then((m) => m.appZoom), new Disposable().signal);
      // Ctrl+Shift+Backspace turns a custom CSS theme off, even one that hides the settings.
      installCustomThemeEscape(new Disposable().signal);
    },
  },
  {
    // A profile from before automatic sensitivity keeps a tuned slider, and
    // one from before the decibel slider keeps its gate level.
    name: "voiceInputMigrations",
    run: () => {
      migrateAutoInputSensitivity();
      migrateVoiceSensitivityScale();
      forgetAndroidInputDevice();
    },
  },
  {
    // The push-to-talk listener (Rust-side polling, non-consuming), once the
    // input mode is settled: a profile from before Input Mode keeps its PTT key.
    name: "pushToTalk",
    run: () => {
      migrateInputMode();
      void desktop.pushToTalk.init();
    },
  },
  {
    // Dates follow the OS regional format where the host can read it (Windows
    // reports only its display language to the webview).
    name: "dateLocale",
    run: () => {
      void desktop.systemRegion.localeTag().then(setSystemDateLocale);
    },
  },
  {
    // The Android app's call helpers, each loaded on first use: the on-screen
    // talk button (it has no key to hold), the background call service (Android
    // silences a background app's mic without one), and the camera pause while
    // the app is in the background.
    name: "androidCall",
    run: ({ log }) => {
      if (!isAndroidHost()) return;
      void import("../features/voice/talkButton")
        .then((m) => m.startTalkButton(new Disposable().signal))
        .catch((e: unknown) => log.warn("Talk button failed to start", e));
      void import("../features/voice/backgroundCall")
        .then((m) => m.startBackgroundCall(new Disposable().signal))
        .catch((e: unknown) => log.warn("Background call service failed to start", e));
      void import("../features/voice/backgroundCamera")
        .then((m) => m.startBackgroundCamera(new Disposable().signal))
        .catch((e: unknown) => log.warn("Background camera pause failed to start", e));
    },
  },
];

/** Native listeners and other wiring that need the REST client, run after the core is up. */
export function afterCoreSteps(api: ApiClient): readonly StartupStep[] {
  return [
    {
      // The tray's Status submenu goes through the same path as the in-app
      // status menu: saveUserStatus() first (notifications' DND gate, auto-idle's
      // manual-status guard and the next reconnect all read it), then the
      // session's shared PresenceSender, so the tray spends the same 1 update /
      // 10 s server budget instead of opening a second one. With no session
      // mounted the send is a no-op. The tray's legacy "offline" maps to
      // "invisible", as userStatus.ts migrates a stored "offline".
      name: "trayStatus",
      run: () =>
        desktop.trayStatus.onStatusChange((status) => {
          if (
            status === "online" ||
            status === "idle" ||
            status === "dnd" ||
            status === "offline"
          ) {
            const mapped = status === "offline" ? "invisible" : status;
            saveUserStatus(mapped);
            getActivePresenceSender()?.send(mapped);
          }
        }),
    },
    { name: "windowState", run: () => void initWindowState() },
    { name: "deepLinks", run: () => installDeepLinks(api) },
    {
      // A clicked message notification opens the message it was for, through
      // the same jumper a permalink uses.
      name: "notificationClick",
      run: () => desktop.notifier.onMessageActivated(openNotificationTarget),
    },
  ];
}

export function runStartupSteps(steps: readonly StartupStep[], ctx: StartupContext): void {
  for (const step of steps) step.run(ctx);
}
