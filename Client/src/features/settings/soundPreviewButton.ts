/**
 * The play button beside each per-sound switch in Settings > Notifications.
 * It previews the sounds behind the switch whether the switch is on or off;
 * pressing it again while they play stops them.
 */

import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { previewSounds, type SoundPreview } from "@lib/media/soundPreview";
import type { AppSound } from "@lib/media/soundTables";
import type { SoundSwitch } from "@lib/prefs/soundPrefs";
import { settingsText as t } from "../../i18n/settings";

/** What each switch's button plays, in order. */
export const PREVIEW_SOUNDS: Readonly<Record<SoundSwitch, readonly AppSound[]>> = {
  message: ["message"],
  mention: ["mention"],
  ring: ["ring"],
  ringback: ["ringback", "callEnded"],
  joinLeave: ["join", "leave", "moved"],
  muteDeafen: ["mute", "unmute", "deafen", "undeafen"],
  stream: ["streamStart", "streamEnd", "viewerJoin", "viewerLeave"],
  connection: ["connectionLost", "join"],
  ptt: ["pttOn", "pttOff"],
};

/** Put a play button for `sound` in front of `row`'s switch. */
export function addSoundPreviewButton(
  row: HTMLElement,
  sound: SoundSwitch,
  label: string,
  signal: AbortSignal,
): void {
  const button = createElement("button", {
    class: "sound-preview-btn",
    type: "button",
    "aria-label": t("notifications.sound.preview", { sound: label }),
    "aria-pressed": "false",
    "data-testid": `sound-preview-${sound}`,
  });
  let running: SoundPreview | null = null;
  const show = (on: boolean): void => {
    button.setAttribute("aria-pressed", String(on));
    button.replaceChildren(createIcon(on ? "square" : "play", 16));
  };
  show(false);
  button.addEventListener(
    "click",
    () => {
      if (running !== null) {
        running.stop();
        return;
      }
      running = previewSounds(PREVIEW_SOUNDS[sound], signal, () => {
        running = null;
        show(false);
      });
      show(running !== null);
    },
    { signal },
  );
  const toggle = row.lastElementChild!;
  const actions = createElement("div", { class: "sound-preview" });
  toggle.before(actions);
  actions.append(button, toggle);
}
