import type { Room, RoomEventCallbacks } from "livekit-client";

type AppListener = [event: keyof RoomEventCallbacks, listener: (...args: never[]) => void];
const appListeners = new WeakMap<Room, AppListener[]>();

/** Subscribe the app to a Room event, recorded so detachRoom can remove it. */
export function onRoom<E extends keyof RoomEventCallbacks>(
  room: Room,
  event: E,
  listener: RoomEventCallbacks[E],
): void {
  room.on(event, listener);
  const listeners = appListeners.get(room) ?? [];
  listeners.push([event, listener]);
  appListeners.set(room, listeners);
}

/** Remove the app's listeners from a Room it is abandoning, so none of its
 *  handlers run for that Room's disconnect. Never room.removeAllListeners():
 *  livekit also listens on its own Room, and its once(Disconnected) cleanups
 *  (the 10 s wait for a LocalTrackSubscribed publication, deferred track
 *  callbacks) must still run when disconnect() fires the event, or their
 *  timers and closures outlive the Room. */
export function detachRoom(room: Room): void {
  for (const [event, listener] of appListeners.get(room) ?? []) room.off(event, listener);
  appListeners.delete(room);
}

/** Discard a Room: drop the app's listeners (detachRoom), remove the devicechange listener its
 *  constructor put on navigator.mediaDevices, then disconnect it. livekit
 *  removes that listener only when a Room that has left "disconnected"
 *  disconnects, so a Room discarded before connect() would otherwise stay
 *  reachable from navigator.mediaDevices for the page's lifetime. */
export function releaseRoom(room: Room): Promise<void> {
  detachRoom(room);
  navigator.mediaDevices?.removeEventListener(
    "devicechange",
    (room as unknown as { handleDeviceChange: EventListener }).handleDeviceChange,
  );
  return room.disconnect();
}
