// Brings back the camera and screen share an auto-reconnect dropped
// (teardownForReconnect stops both). The camera comes back on its own; a share
// needs the OS picker again except on Linux native with its source still
// there, so for a share that could not come back the user gets a toast with
// one button to share again.

import { showActionToast } from "../../lib/ui/toast";
import { voiceText } from "../../i18n/voice";

export interface LostMedia {
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface TurnOnAgain {
  readonly camera: () => void;
  readonly screenshare: () => void;
}

export interface RestoreMedia {
  /** Whether the camera / a share is on now (the user may have turned it on). */
  readonly isOn: (kind: keyof LostMedia) => boolean;
  /** Turn the camera on; a failure or a video-limit refusal toasts itself. */
  readonly enableCamera: () => Promise<void>;
  /** Share again without asking; false when that needs the user's pick. */
  readonly restartScreenshare: () => Promise<boolean>;
  /** False once the call this restore was for has ended or been replaced. */
  readonly stillCurrent: () => boolean;
  readonly turnOn: TurnOnAgain;
}

let dismissNotice: (() => void) | null = null;

/** Remove the notice, if one is up (leaving voice: there is nothing to turn on). */
export function dismissMediaLostNotice(): void {
  dismissNotice?.();
  dismissNotice = null;
}

export async function restoreLostMedia(lost: LostMedia, r: RestoreMedia): Promise<void> {
  if (lost.camera && !r.isOn("camera")) await r.enableCamera();
  if (!r.stillCurrent()) return;
  const shareLost = lost.screenshare && !r.isOn("screenshare") && !(await r.restartScreenshare());
  if (shareLost && r.stillCurrent())
    showMediaLostNotice({ camera: false, screenshare: true }, r.turnOn);
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
  dismissNotice = showActionToast(
    message,
    "warning",
    {
      label,
      run: () => {
        dismissNotice = null;
        if (lost.camera) turnOn.camera();
        if (lost.screenshare) turnOn.screenshare();
      },
    },
    Infinity,
  );
}
