// The native room's audio device switch, split from nativeRoom.ts. The session
// id is read by the caller at call time and used as given; there is no await
// between the check and the command.
import { desktop } from "../../../platform/desktop";
import { isDeviceFallback } from "./screenTrack";

/** `session` is the room's native session id, null while not connected. */
export async function switchNativeDevice(
  session: number | null,
  kind: string,
  deviceId: string,
): Promise<boolean> {
  if (kind !== "audioinput" && kind !== "audiooutput") return false;
  // i18n-exempt: internal native-room state guard, consumed by joinOrchestration's catalog toast
  if (session === null) throw new Error("native room is not connected");
  try {
    await desktop.nativeVoice.setDevice(session, kind, deviceId === "default" ? "" : deviceId);
  } catch (err) {
    // The host reports "device not found; switched to the default" as a
    // rejection, but the switch itself succeeded — surface it as success,
    // not "mic failed" (voice #19). A real failure still rejects.
    if (isDeviceFallback(err)) return true;
    throw err;
  }
  return true;
}
