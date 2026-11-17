/**
 * The host's "in a call" service. On Android a call only keeps its mic (and
 * camera) once the app is in the background while a foreground service with
 * a visible notification runs; elsewhere there is nothing to keep alive.
 *
 * The same state says when the call has a picture on screen: the Android app
 * then keeps the screen from dimming and locking, and lets it again when the
 * picture goes or the call ends.
 *
 * That notification has the call's buttons, and an incoming call's has Accept
 * and Decline. The host only shows them: a pressed button comes back through
 * `onAction`, and the app acts on it.
 */
export interface CallServiceState {
  /** A call is joining, connected or reconnecting. */
  readonly active: boolean;
  /** The local camera is on, so the service keeps it running too. */
  readonly camera: boolean;
  /** A camera or a stream is on screen, so the screen stays on. */
  readonly videoOnScreen: boolean;
  /** The microphone, as the notification shows it: open, muted by the member,
   *  or muted by a moderator ("locked": not the member's to lift, so the
   *  notification offers no button for it). */
  readonly mic: CallMic;
}

export type CallMic = "live" | "muted" | "locked";

/** A button pressed on one of the host's call notifications. `mute` and
 *  `unmute` name the state the button promised, so a press that crosses a
 *  change never flips the microphone the wrong way. `accept`, `decline` and
 *  `open` (a tap on the ringing call itself) name the conversation that rang,
 *  which may have stopped ringing by the time the press arrives. */
export type CallAction =
  | { readonly kind: "mute" | "unmute" | "leave" }
  | {
      readonly kind: "accept" | "decline" | "open";
      readonly channelId: number;
      /** Set on a ring a push showed with no page running: the push
       *  registration (server and account) it came for. */
      readonly instance?: string;
    };

export interface CallService {
  /** Tell the host the call's state. Never rejects: a host that refuses only
   *  loses the background keep-alive, never the call. Calls reach the host in
   *  the order they are made. */
  update(state: CallServiceState): void;
  /** Hear the buttons of the host's call notifications until `signal` aborts.
   *  One listener at a time: a newer one takes over. Inert where the host has
   *  no such notifications. */
  onAction(signal: AbortSignal, handler: (action: CallAction) => void): void;
}
