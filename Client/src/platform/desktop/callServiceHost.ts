// The host side of `callService`, loaded in the Android app only
// (`src-tauri/src/call_service.rs`, `CallServicePlugin.kt`).
import { addPluginListener, type PluginListener } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import { callNotificationText } from "../../i18n/callNotification";
import { invokeOrThrow, tryInvoke } from "./nativeInvoke";
import type { CallAction, CallMic, CallServiceState } from "../contracts/callService";

const log = createLogger("callService");
/** Settles when the last state sent was answered; the next goes out then. */
let answered: Promise<unknown> = Promise.resolve();

/** What the service's notification says for each microphone state, and the
 *  button it offers. A moderator's mute is not the member's to lift, so it
 *  gets none. */
const FACES = {
  live: { text: "inCall", micLabel: "mute" },
  muted: { text: "inCallMuted", micLabel: "unmute" },
  locked: { text: "inCallLocked", micLabel: null },
} as const satisfies Record<CallMic, unknown>;

/** The notification's words, as `set_call_service` takes them. */
function face(mic: CallMic): {
  mic: CallMic;
  text: string;
  micLabel: string | null;
  leaveLabel: string;
} {
  const { text, micLabel } = FACES[mic];
  return {
    mic,
    text: callNotificationText(text),
    micLabel: micLabel === null ? null : callNotificationText(micLabel),
    leaveLabel: callNotificationText("leave"),
  };
}

/** One state at a time: the host runs each command as a task of its own, and
 *  two on their way at once (a camera going on as its picture appears) could
 *  reach the plugin either way round. `tryInvoke` never rejects, so a refused
 *  state does not hold up the next. */
export function update(state: CallServiceState): void {
  answered = answered
    .then(() =>
      tryInvoke<void>("set_call_service", {
        active: state.active,
        camera: state.camera,
        videoOnScreen: state.videoOnScreen,
        face: face(state.mic),
      }),
    )
    .then((result) => {
      if (result.ok) return;
      log.warn("Call service refused; the call may stop in the background", result.error.message);
    });
}

/** Bumped by each `onAction`: the newest listener owns the buttons. */
let generation = 0;

/** The plugin's event as an action, or null for anything else. */
function readAction(raw: unknown): CallAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const kind: unknown = "kind" in raw ? raw.kind : undefined;
  const channelId: unknown = "channelId" in raw ? raw.channelId : undefined;
  const instance: unknown = "instance" in raw ? raw.instance : undefined;
  switch (kind) {
    case "mute":
    case "unmute":
    case "leave":
      return { kind };
    case "accept":
    case "decline":
    case "open":
      if (typeof channelId !== "number") return null;
      return typeof instance === "string" ? { kind, channelId, instance } : { kind, channelId };
    default:
      return null;
  }
}

function stop(listener: PluginListener): void {
  void listener.unregister().catch((err: unknown) => log.debug("Unlisten failed", err));
}

export function onAction(signal: AbortSignal, handler: (action: CallAction) => void): void {
  // An owner that is gone already takes nothing over.
  if (signal.aborted) return;
  const mine = ++generation;
  void addPluginListener<unknown>("owncord-call-service", "action", (raw) => {
    if (signal.aborted || mine !== generation) return;
    const action = readAction(raw);
    if (action === null) log.warn("Unknown call notification button");
    else handler(action);
  }).then(
    (listener) => {
      if (signal.aborted) stop(listener);
      else signal.addEventListener("abort", () => stop(listener), { once: true });
    },
    (err: unknown) => log.warn("Call notification buttons unavailable", err),
  );
}

/** An incoming call's notification, in the app's words. */
export interface CallRing {
  readonly channelId: number;
  readonly title: string;
  readonly text: string;
  /** Shown without the phone's ringtone: the ring sound is off in the app. */
  readonly quiet: boolean;
  /** Android takes it down by itself after this long. */
  readonly timeoutMs: number;
}

/** Settles when the last ring command was answered; the next goes out then,
 *  so a ring never comes down before it went up. */
let ringAnswered: Promise<unknown> = Promise.resolve();

function ringCommand(send: () => Promise<void>): Promise<void> {
  const sent = ringAnswered.then(send);
  ringAnswered = sent.catch(() => undefined);
  return sent;
}

/** Show the incoming call's notification, or show it again so its time
 *  starts over. Rejects when Android would not show it (notifications are
 *  off): the app then rings by itself. */
export function showRing(ring: CallRing): Promise<void> {
  return ringCommand(() =>
    invokeOrThrow<void>("show_call_ring", {
      ring: {
        channelId: ring.channelId,
        title: ring.title,
        text: ring.text,
        acceptLabel: callNotificationText("accept"),
        declineLabel: callNotificationText("decline"),
        channelName: callNotificationText(ring.quiet ? "quietRingChannel" : "ringChannel"),
        channelDescription: callNotificationText(
          ring.quiet ? "quietRingChannelDesc" : "ringChannelDesc",
        ),
        quiet: ring.quiet,
        timeoutMs: ring.timeoutMs,
      },
    }),
  );
}

/** Take the incoming call's notification down, if the one up is this
 *  conversation's. */
export function clearRing(channelId: number): Promise<void> {
  return ringCommand(() => invokeOrThrow<void>("clear_call_ring", { channelId }));
}
