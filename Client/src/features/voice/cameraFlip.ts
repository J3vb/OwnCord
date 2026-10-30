// The flip button in the call bar: front to back camera and back, on a phone.
// Loaded on demand, so it stays out of the eager MainPage chunk.
import { loadPref } from "@lib/prefs/preferences";
import { switchVideoDevice } from "@lib/livekitSession";
import { createLogger } from "@lib/logger";

const log = createLogger("cameraFlip");

export type Facing = "user" | "environment";

export interface FacingCamera {
  readonly deviceId: string;
  readonly facing: Facing | null;
}

/** Which way a camera faces: from its capabilities where the engine reports
 *  them (Chromium on Android does), else from a "front"/"back" label. */
export function facingOf(device: MediaDeviceInfo): Facing | null {
  const caps =
    "getCapabilities" in device && typeof device.getCapabilities === "function"
      ? (device as InputDeviceInfo).getCapabilities()
      : null;
  const modes = caps?.facingMode ?? [];
  if (modes.includes("user")) return "user";
  if (modes.includes("environment")) return "environment";
  if (/\bfront\b/i.test(device.label)) return "user";
  if (/\b(back|rear)\b/i.test(device.label)) return "environment";
  return null;
}

/** The camera a flip moves to: the first one facing the other way from the
 *  camera in use. The default camera ("" or one no longer listed) counts as
 *  the front one, which is what a phone opens. */
export function pickFlipTarget(
  cameras: readonly FacingCamera[],
  currentId: string,
): FacingCamera | null {
  const now = cameras.find((c) => c.deviceId === currentId)?.facing ?? "user";
  const want: Facing = now === "user" ? "environment" : "user";
  return cameras.find((c) => c.facing === want) ?? null;
}

async function listFacingCameras(): Promise<FacingCamera[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "videoinput" && d.deviceId !== "")
    .map((d) => ({ deviceId: d.deviceId, facing: facingOf(d) }));
}

/** True on a touch device with both a front and a back camera. Labels and
 *  capabilities are empty until camera permission is granted, so ask again
 *  once the camera is on. */
export async function cameraFlipAvailable(): Promise<boolean> {
  if (typeof window.matchMedia !== "function") return false;
  if (!window.matchMedia("(any-pointer: coarse)").matches) return false;
  try {
    const cameras = await listFacingCameras();
    return (
      cameras.some((c) => c.facing === "user") && cameras.some((c) => c.facing === "environment")
    );
  } catch (err) {
    log.warn("Camera list failed", err);
    return false;
  }
}

let flipping = false;

/** Move the live camera to the one facing the other way. A tap while a flip
 *  is still switching does nothing, so quick taps cannot pile up restarts. */
export async function flipCamera(): Promise<void> {
  if (flipping) return;
  flipping = true;
  try {
    const target = pickFlipTarget(
      await listFacingCameras(),
      loadPref<string>("videoInputDevice", ""),
    );
    if (target !== null) await switchVideoDevice(target.deviceId);
  } catch (err) {
    log.warn("Camera flip failed", err);
  } finally {
    flipping = false;
  }
}
