import type { Room } from "livekit-client";

/** Discard a Room: drop its listeners, remove the devicechange listener its
 *  constructor put on navigator.mediaDevices, then disconnect it. livekit
 *  removes that listener only when a Room that has left "disconnected"
 *  disconnects, so a Room discarded before connect() would otherwise stay
 *  reachable from navigator.mediaDevices for the page's lifetime. */
export function releaseRoom(room: Room): Promise<void> {
  room.removeAllListeners();
  navigator.mediaDevices?.removeEventListener(
    "devicechange",
    (room as unknown as { handleDeviceChange: EventListener }).handleDeviceChange,
  );
  return room.disconnect();
}
