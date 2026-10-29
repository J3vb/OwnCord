// Audio device listing for the native backend, in the browser's
// `MediaDeviceInfo` shape the settings tab and the device manager consume.
// On Linux the ids are the audio host's (`cpal`'s) stable capture and
// playout device ids (what `NativeRoom.switchActiveDevice` forwards), not
// the webview's, so enumerating through the webview there would offer devices
// the session cannot select and treat every saved id as "removed". Off Linux this
// returns null and the caller keeps its own web enumeration unchanged.
import { desktop } from "../../../platform/desktop";
import type { NativeVoiceCameraSupport } from "../../../platform/contracts/nativeVoice";
import { isLinuxDesktop } from "./platform";
import { voiceText as t } from "../../../i18n/voice";

export type AudioDeviceKind = "audioinput" | "audiooutput";
export type NativeDeviceKind = AudioDeviceKind | "videoinput";

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: NativeDeviceKind;
}

export async function nativeAudioDevices(kind: AudioDeviceKind): Promise<AudioDevice[] | null> {
  if (!isLinuxDesktop()) return null;
  const devices = await desktop.nativeVoice.listDevices();
  const list = kind === "audioinput" ? devices.inputs : devices.outputs;
  return list.map((d) => ({ deviceId: d.id, label: d.name, kind }));
}

/** The native camera list in the browser's `MediaDeviceInfo` shape,
 *  `videoinput`. On Linux the ids come from GStreamer's `DeviceMonitor` (the
 *  ids the native capture can select), so `getUserMedia` ids would offer
 *  devices the session cannot select. Off Linux this returns null and the
 *  caller keeps its own web enumeration. */
export async function nativeCameraDevices(): Promise<AudioDevice[] | null> {
  if (!isLinuxDesktop()) return null;
  const devices = await desktop.nativeVoice.listCameras();
  return cameraLabels(devices).map((label, i) => ({
    deviceId: devices[i]!.id,
    label,
    kind: "videoinput",
  }));
}

/** Picker labels that tell cameras apart: V4L2 cuts a device name at 31
 *  characters, so a laptop's colour camera and its infrared sensor (or two
 *  identical USB cameras) arrive with the same name. The sensor is marked as
 *  infrared, and names still shared are numbered in list order. */
function cameraLabels(devices: readonly { name: string; infrared: boolean }[]): string[] {
  const labels = devices.map((d) =>
    d.infrared && d.name !== "" ? t("call.infraredCamera", { name: d.name }) : d.name,
  );
  const total = new Map<string, number>();
  for (const label of labels) total.set(label, (total.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if (label === "" || (total.get(label) ?? 0) < 2) return label;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return t("call.sameNameCamera", { name: label, n });
  });
}

/** Whether the native camera backend is usable at all (GStreamer initialises
 *  and the capture pipeline's elements exist), as the settings tab and the
 *  camera toggle report. Null off Linux, where the web path owns cameras. */
export async function nativeCameraSupport(): Promise<NativeVoiceCameraSupport | null> {
  if (!isLinuxDesktop()) return null;
  return desktop.nativeVoice.cameraSupport();
}

/** Subscribe to the host's device hot-plug watch (Linux): `handler` runs, with
 *  no payload, each time the capture or playout lists change, in or out of a
 *  call. The event is only a trigger; callers re-list through
 *  `nativeAudioDevices`. Returns a synchronous unsubscribe, or null off Linux,
 *  where the webview's own `devicechange` is the only trigger. */
export function onNativeDevicesChanged(handler: () => void): (() => void) | null {
  if (!isLinuxDesktop()) return null;
  return desktop.nativeVoice.watchDevices(() => handler());
}
