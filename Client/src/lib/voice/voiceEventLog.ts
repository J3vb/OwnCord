// Records a voice room's facts into the diagnostic event log: reconnects and
// disconnects, local camera and microphone tracks (started, stopped, muted or
// ended by the browser), remote subscriptions and device errors. Only enum
// words, numbers, hashes and pseudonyms leave here; never a name or label.
import {
  DisconnectReason,
  RoomEvent,
  type LocalTrackPublication,
  type Participant,
  type Room,
  type RoomEventCallbacks,
  type TrackPublication,
} from "livekit-client";
import { recordEvent } from "@lib/diagnostics/eventSink";
import { pseudonym, reportHash } from "@lib/diagnostics/identifiers";
import { Disposable } from "@lib/disposable";

type Source = "camera" | "microphone" | "screen_share" | "screen_share_audio" | "unknown";
type MediaError =
  | "not_allowed"
  | "not_found"
  | "not_readable"
  | "overconstrained"
  | "abort"
  | "security"
  | "type"
  | "unknown";

const DISCONNECT_REASONS = [
  "unknown_reason",
  "client_initiated",
  "duplicate_identity",
  "server_shutdown",
  "participant_removed",
  "room_deleted",
  "state_mismatch",
  "join_failure",
  "migration",
  "signal_close",
  "room_closed",
  "user_unavailable",
  "user_rejected",
  "sip_trunk_failure",
  "connection_timeout",
  "media_failure",
] as const;

function sourceOf(pub: TrackPublication): Source {
  const s = pub.source as string;
  return s === "camera" || s === "microphone" || s === "screen_share" || s === "screen_share_audio"
    ? s
    : "unknown";
}

function participantOf(p: Participant): string {
  return pseudonym("u", p.identity);
}

function mediaError(err: Error): MediaError {
  switch (err.name) {
    case "NotAllowedError":
      return "not_allowed";
    case "NotFoundError":
      return "not_found";
    case "NotReadableError":
      return "not_readable";
    case "OverconstrainedError":
      return "overconstrained";
    case "AbortError":
      return "abort";
    case "SecurityError":
      return "security";
    case "TypeError":
      return "type";
    default:
      return "unknown";
  }
}

function disconnectReason(reason: DisconnectReason | undefined) {
  const name = reason === undefined ? "" : String(DisconnectReason[reason] ?? "").toLowerCase();
  return (DISCONNECT_REASONS as readonly string[]).includes(name)
    ? (name as (typeof DISCONNECT_REASONS)[number])
    : "unknown_reason";
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** The constraint's ideal or exact value, when the app asked for a number. */
function asked(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value !== null && typeof value === "object") {
    const c = value as { ideal?: unknown; exact?: unknown };
    return num(c.exact) ?? num(c.ideal);
  }
  return null;
}

function localTrackStarted(pub: LocalTrackPublication, owner: Disposable): void {
  const media = pub.track?.mediaStreamTrack;
  const source = sourceOf(pub);
  if (media === undefined || (source !== "camera" && source !== "microphone")) return;
  const settings = media.getSettings();
  const device = settings.deviceId ? reportHash(settings.deviceId) : null;
  if (source === "camera") {
    const wanted = media.getConstraints();
    const facing = settings.facingMode;
    recordEvent("camera.started", {
      device,
      width: num(settings.width),
      height: num(settings.height),
      fps: num(settings.frameRate),
      requested_width: asked(wanted.width),
      requested_height: asked(wanted.height),
      requested_fps: asked(wanted.frameRate),
      facing: facing === "user" || facing === "environment" ? facing : "unknown",
    });
    const opts = { signal: owner.signal };
    media.addEventListener("mute", () => recordEvent("camera.muted", { by: "browser" }), opts);
    media.addEventListener("unmute", () => recordEvent("camera.unmuted", { by: "browser" }), opts);
    media.addEventListener("ended", () => recordEvent("camera.ended"), opts);
  } else {
    recordEvent("mic.started", { device, sample_rate: num(settings.sampleRate) });
    media.addEventListener("ended", () => recordEvent("mic.ended"), { signal: owner.signal });
  }
}

type OnRoom = <E extends keyof RoomEventCallbacks>(
  room: Room,
  event: E,
  listener: RoomEventCallbacks[E],
) => void;

/** Attach the event-log listeners to a room through the caller's onRoom, so
 *  they are removed with the room's other app listeners. */
export function attachVoiceEventLog(room: Room, onRoom: OnRoom): void {
  const owners = new Map<string, Disposable>();
  let reconnectingAt: number | null = null;
  let attempt = 0;

  const release = (sid: string): void => {
    owners.get(sid)?.destroy();
    owners.delete(sid);
  };

  onRoom(room, RoomEvent.Connected, () => recordEvent("voice.joined"));
  onRoom(room, RoomEvent.SignalReconnecting, () => {
    reconnectingAt ??= Date.now();
    recordEvent("voice.reconnecting", { attempt: ++attempt, kind: "signal" });
  });
  onRoom(room, RoomEvent.Reconnecting, () => {
    reconnectingAt ??= Date.now();
    recordEvent("voice.reconnecting", { attempt: ++attempt, kind: "full" });
  });
  onRoom(room, RoomEvent.Reconnected, () => {
    recordEvent("voice.reconnected", {
      after_ms: reconnectingAt === null ? null : Date.now() - reconnectingAt,
    });
    reconnectingAt = null;
    attempt = 0;
  });
  onRoom(room, RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    const named = disconnectReason(reason);
    recordEvent("voice.disconnected", { reason: named, unexpected: named !== "client_initiated" });
    for (const sid of owners.keys()) release(sid);
  });

  onRoom(room, RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
    const source = sourceOf(pub);
    const mime = pub.mimeType;
    recordEvent("track.published", {
      source,
      codec: mime ? (mime.split("/")[1] ?? null) : null,
      simulcast: pub.simulcasted ?? null,
    });
    release(pub.trackSid);
    const owner = new Disposable();
    owners.set(pub.trackSid, owner);
    localTrackStarted(pub, owner);
  });
  onRoom(room, RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
    const source = sourceOf(pub);
    recordEvent("track.unpublished", { source, reason: "unknown" });
    if (source === "camera") recordEvent("camera.stopped", { reason: "unknown" });
    if (source === "microphone") recordEvent("mic.stopped", { reason: "unknown" });
    release(pub.trackSid);
  });
  onRoom(room, RoomEvent.TrackMuted, (pub: TrackPublication, p: Participant) => {
    if (p.isLocal && sourceOf(pub) === "camera") recordEvent("camera.muted", { by: "user" });
  });
  onRoom(room, RoomEvent.TrackUnmuted, (pub: TrackPublication, p: Participant) => {
    if (p.isLocal && sourceOf(pub) === "camera") recordEvent("camera.unmuted", { by: "user" });
  });

  onRoom(room, RoomEvent.TrackSubscribed, (_track, pub, p) =>
    recordEvent("track.subscribed", { source: sourceOf(pub), participant: participantOf(p) }),
  );
  onRoom(room, RoomEvent.TrackUnsubscribed, (_track, pub, p) =>
    recordEvent("track.unsubscribed", { source: sourceOf(pub), participant: participantOf(p) }),
  );
  onRoom(room, RoomEvent.TrackSubscriptionFailed, (_sid, p) =>
    recordEvent("track.subscription_failed", { participant: participantOf(p) }),
  );

  onRoom(room, RoomEvent.MediaDevicesError, (err: Error, kind?: MediaDeviceKind) => {
    const error = mediaError(err);
    if (kind === "audioinput") recordEvent("mic.permission_error", { error });
    else if (kind === "videoinput") recordEvent("camera.permission_error", { error });
  });
}
