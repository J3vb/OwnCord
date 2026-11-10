/**
 * Microphone lookup and getUserMedia helpers for the voice-message recorder:
 * which device to ask for, the constraints, and how a rejection is named.
 */

import { loadPref } from "@lib/prefs/preferences";

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

/** The device picked in Voice & Audio settings, on Linux. The saved id there
 *  is the native audio host's, which the webview does not know, so it is
 *  looked up again by the device's name. */
export async function linuxMicDeviceId(): Promise<string> {
  const saved = loadPref<string>("audioInputDevice", "");
  if (saved === "") return "";
  const { webviewMicId } = await import("./linuxMic");
  return webviewMicId(saved);
}

/** The microphone request: `deviceId`, or the system default when "". */
export function audioConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: loadPref("echoCancellation", true),
      noiseSuppression: loadPref("noiseSuppression", true),
      ...(deviceId === "" ? {} : { deviceId: { exact: deviceId } }),
    },
  };
}

export function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

export function resolveGetUserMedia(injected: GetUserMedia | undefined): GetUserMedia | undefined {
  if (injected !== undefined) return injected;
  if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined) {
    return (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c);
  }
  return undefined;
}

/** How a getUserMedia rejection is told to the caller. */
export function openErrorKind(name: string): "denied" | "no-device" | "failed" {
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "OverconstrainedError" || name === "NotFoundError") return "no-device";
  return "failed";
}
