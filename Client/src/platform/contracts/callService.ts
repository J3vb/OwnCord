/**
 * The host's "in a call" service. On Android a call only keeps its mic (and
 * camera) once the app is in the background while a foreground service with
 * a visible notification runs; elsewhere there is nothing to keep alive.
 *
 * The same state says when the call has a picture on screen: the Android app
 * then keeps the screen from dimming and locking, and lets it again when the
 * picture goes or the call ends.
 */
export interface CallServiceState {
  /** A call is joining, connected or reconnecting. */
  readonly active: boolean;
  /** The local camera is on, so the service keeps it running too. */
  readonly camera: boolean;
  /** A camera or a stream is on screen, so the screen stays on. */
  readonly videoOnScreen: boolean;
}

export interface CallService {
  /** Tell the host the call's state. Never rejects: a host that refuses only
   *  loses the background keep-alive, never the call. Calls reach the host in
   *  the order they are made. */
  update(state: CallServiceState): void;
}
