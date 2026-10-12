// Tells the user which of their camera and screen share an auto-reconnect
// dropped, with one button to turn them back on. teardownForReconnect stops
// both tracks; nothing restores them yet (WP 1C-6).

import { showActionToast } from "../../lib/toast";
import { voiceText } from "../../i18n/voice";

export interface LostMedia {
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface TurnOnAgain {
  readonly camera: () => void;
  readonly screenshare: () => void;
}

export function showMediaLostNotice(lost: LostMedia, turnOn: TurnOnAgain): void {
  if (!lost.camera && !lost.screenshare) return;
  const message = !lost.screenshare
    ? voiceText("reconnect.cameraLost")
    : !lost.camera
      ? voiceText("reconnect.screenshareLost")
      : voiceText("reconnect.mediaLost");
  const label = lost.camera
    ? voiceText("reconnect.turnOnAgain")
    : voiceText("reconnect.shareAgain");
  // Sticky: the drop can happen while the user is away from the screen.
  showActionToast(
    message,
    "warning",
    {
      label,
      run: () => {
        if (lost.camera) turnOn.camera();
        if (lost.screenshare) turnOn.screenshare();
      },
    },
    Infinity,
  );
}
