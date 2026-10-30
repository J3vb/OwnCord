/**
 * The Linux microphone for a voice message. Voice & Audio settings save the
 * native audio host's device id there (features/voice/native/devices.ts), but
 * a voice message records through the webview, whose device ids differ. Both
 * name a device by its sound-server description, so the saved device is found
 * again by its name. Anything unclear (no match, two devices with that name, a
 * failed listing) records from the system default, as before.
 */

import { nativeAudioDevices, type AudioDevice } from "../voice/native/devices";

export interface LinuxMicDeps {
  listNative(): Promise<readonly AudioDevice[] | null>;
  enumerate(): Promise<readonly MediaDeviceInfo[]>;
}

const defaultDeps: LinuxMicDeps = {
  listNative: () => nativeAudioDevices("audioinput"),
  enumerate: () => navigator.mediaDevices.enumerateDevices(),
};

/** The webview device id of the saved native microphone, or "" for the default. */
export async function webviewMicId(
  savedId: string,
  deps: LinuxMicDeps = defaultDeps,
): Promise<string> {
  if (savedId === "") return "";
  const native = await deps.listNative().catch(() => []);
  if (native === null) return savedId;
  const name = native.find((d) => d.deviceId === savedId)?.label.trim() ?? "";
  if (name === "") return "";
  const devices = await deps.enumerate().catch(() => []);
  const matches = devices.filter((d) => d.kind === "audioinput" && d.label.trim() === name);
  return matches.length === 1 ? matches[0]!.deviceId : "";
}
