// Audio device listing for the native backend, in the browser's
// `MediaDeviceInfo` shape the settings tab and the device manager consume.
// On Linux the ids are the host device module's device names (what
// `NativeRoom.switchActiveDevice` forwards), not the webview's, so
// enumerating through the webview there would offer devices the session
// cannot select and treat every saved id as "removed". Off Linux this
// returns null and the caller keeps its own web enumeration unchanged.
import { desktop } from "../../../platform/desktop";
import { isLinuxDesktop } from "./platform";

export type AudioDeviceKind = "audioinput" | "audiooutput";

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: AudioDeviceKind;
}

export async function nativeAudioDevices(kind: AudioDeviceKind): Promise<AudioDevice[] | null> {
  if (!isLinuxDesktop()) return null;
  const devices = await desktop.nativeVoice.listDevices();
  const list = kind === "audioinput" ? devices.inputs : devices.outputs;
  return list.map((d) => ({ deviceId: d.id, label: d.name, kind }));
}
