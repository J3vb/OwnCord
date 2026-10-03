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
  return devices.map((d) => ({ deviceId: d.id, label: d.name, kind: "videoinput" }));
}

/** Whether the native camera backend is usable at all (GStreamer initialises
 *  and the capture pipeline's elements exist), as the settings tab and the
 *  camera toggle report. Null off Linux, where the web path owns cameras. */
export async function nativeCameraSupport(): Promise<NativeVoiceCameraSupport | null> {
  if (!isLinuxDesktop()) return null;
  return desktop.nativeVoice.cameraSupport();
}
