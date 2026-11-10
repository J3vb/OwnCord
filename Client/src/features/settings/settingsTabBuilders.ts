/** The content builder of each Settings tab, keyed by tab name. */

import { createElement } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { buildAccountTab } from "./AccountTab";
import { buildAppearanceTab } from "./AppearanceTab";
import { buildNotificationsTab } from "./NotificationsTab";
import { buildTextImagesTab } from "./TextImagesTab";
import { buildAccessibilityTab } from "./AccessibilityTab";
import { buildKeybindsTab } from "./KeybindsTab";
import { buildAdvancedTab } from "./AdvancedTab";
import type { SettingsOverlayOptions } from "./settingsOverlayOptions";
import type { TabName } from "./settingsTabs";

const log = createLogger("SettingsOverlay");

export type TabBuilder = (signal: AbortSignal) => HTMLDivElement;

export interface TabBuilderDeps {
  readonly options: SettingsOverlayOptions;
  /** Wrap a request whose response is the only copy of a new secret. */
  readonly holdOpen: <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ) => (...args: A) => Promise<R>;
  /** The Account tab reports whether it holds a half-typed form. */
  readonly setDirtyCheck: (isDirty: () => boolean) => void;
  readonly buildVoiceTab: TabBuilder;
  readonly buildLogsTab: TabBuilder;
  /** Re-mark search hits once the lazily loaded About tab arrives. */
  readonly markSearchHits: () => void;
}

/** Loaded on first open: the release notes renderer stays out of this chunk. */
function buildAboutPlaceholder(signal: AbortSignal, markSearchHits: () => void): HTMLDivElement {
  const host = createElement("div", { class: "settings-pane active" });
  void import("./AboutTab").then(
    ({ buildAboutTab }) => {
      if (signal.aborted) return;
      host.replaceWith(buildAboutTab(signal));
      // The real tab arrived after renderActiveTab's pass: mark it too.
      markSearchHits();
    },
    (err: unknown) => {
      log.warn("About tab failed to load", { error: String(err) });
    },
  );
  return host;
}

export function createTabBuilders(deps: TabBuilderDeps): Readonly<Record<TabName, TabBuilder>> {
  const { options, holdOpen } = deps;
  return {
    Account: (signal) =>
      buildAccountTab(
        {
          ...options,
          onEnrolRecoveryKit: holdOpen(options.onEnrolRecoveryKit),
          onRegenerateRecoveryCodes: holdOpen(options.onRegenerateRecoveryCodes),
        },
        signal,
        (isDirty) => {
          deps.setDirtyCheck(isDirty);
        },
      ),
    // Only reachable through its tab button, which exists only with the option.
    Safety: (signal) => options.safetyTab?.(signal) ?? createElement("div"),
    Appearance: (signal) => buildAppearanceTab(signal),
    Notifications: (signal) => buildNotificationsTab(signal),
    // Only reachable through its tab button, which exists only with the option.
    "My uploads": (signal) => options.myUploadsTab?.(signal) ?? createElement("div"),
    "Text & Images": (signal) => buildTextImagesTab(signal),
    Accessibility: (signal) => buildAccessibilityTab(signal),
    "Voice & Video": deps.buildVoiceTab,
    Keybinds: (signal) => buildKeybindsTab(signal),
    Advanced: (signal) => buildAdvancedTab(signal),
    Logs: deps.buildLogsTab,
    About: (signal) => buildAboutPlaceholder(signal, deps.markSearchHits),
  };
}
