import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoomEvent, type Room } from "livekit-client";
import { attachRecorder } from "@lib/diagnostics/eventSink";
import { attachVoiceEventLog } from "./voiceEventLog";

type Handler = (...args: unknown[]) => void;

class FakeMedia extends EventTarget {
  constructor(private readonly deviceId: string) {
    super();
  }
  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId, width: 1280, height: 720, frameRate: 30 };
  }
  getConstraints(): MediaTrackConstraints {
    return { width: { ideal: 1280 } };
  }
}

function fakeTrack(media: FakeMedia) {
  const handlers = new Map<string, Handler>();
  return {
    mediaStreamTrack: media as unknown as MediaStreamTrack,
    on: (event: string, fn: Handler) => handlers.set(event, fn),
    off: (event: string) => handlers.delete(event),
    emit: (event: string) => handlers.get(event)?.(),
    handlers,
  };
}

function fakeRoom() {
  const listeners = new Map<string, Handler[]>();
  const room = {
    once: (event: string, fn: Handler) => listeners.set(`once:${event}`, [fn]),
  };
  const onRoom = (_room: Room, event: string, fn: Handler): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn]);
  };
  const fire = (event: string, ...args: unknown[]): void => {
    for (const fn of listeners.get(event) ?? []) fn(...args);
    for (const fn of listeners.get(`once:${event}`) ?? []) fn(...args);
  };
  return { room: room as unknown as Room, onRoom, fire };
}

describe("voice event log", () => {
  let seen: { code: string; fields: Readonly<Record<string, unknown>> }[];
  let detach: () => void;
  beforeEach(() => {
    seen = [];
    detach = attachRecorder((code, fields) => seen.push({ code, fields }));
  });
  afterEach(() => detach());

  it("follows the camera onto the new track the SDK makes after a restart", () => {
    const { room, onRoom, fire } = fakeRoom();
    attachVoiceEventLog(room, onRoom as never);
    const first = new FakeMedia("cam-a");
    const track = fakeTrack(first);
    const pub = { source: "camera", trackSid: "TR_1", track, mimeType: "video/VP8" };
    fire(RoomEvent.LocalTrackPublished, pub);

    const second = new FakeMedia("cam-b");
    track.mediaStreamTrack = second as unknown as MediaStreamTrack;
    track.emit("restarted");
    first.dispatchEvent(new Event("mute"));
    second.dispatchEvent(new Event("mute"));

    expect(seen.map((e) => e.code)).toEqual([
      "track.published",
      "camera.started",
      "camera.started",
      "camera.muted",
    ]);
    const devices = seen.filter((e) => e.code === "camera.started").map((e) => e.fields.device);
    expect(devices[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(devices[1]).not.toBe(devices[0]);
    expect(JSON.stringify(seen)).not.toContain("cam-a");
  });

  it("releases the track listeners when the room disconnects without app listeners", () => {
    const { room, onRoom, fire } = fakeRoom();
    attachVoiceEventLog(room, onRoom as never);
    const media = new FakeMedia("cam");
    const track = fakeTrack(media);
    fire(RoomEvent.LocalTrackPublished, { source: "camera", trackSid: "TR_1", track });
    fire(RoomEvent.Disconnected, 1);
    seen.length = 0;
    media.dispatchEvent(new Event("ended"));
    expect(seen).toEqual([]);
    expect(track.handlers.has("restarted")).toBe(false);
  });

  it("never lets a recording failure escape into the room's handlers", () => {
    const { room, onRoom, fire } = fakeRoom();
    attachVoiceEventLog(room, onRoom as never);
    const broken = { source: "camera", trackSid: "TR_2", track: { on: () => undefined } };
    expect(() => fire(RoomEvent.LocalTrackPublished, broken)).not.toThrow();
  });
});
