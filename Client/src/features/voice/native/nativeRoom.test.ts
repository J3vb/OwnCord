import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeVoiceEnvelope } from "../../../platform/contracts/nativeVoice";

vi.mock("livekit-client", () => ({
  RoomEvent: {
    Connected: "connected",
    Disconnected: "disconnected",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    EncryptionError: "encryptionError",
  },
  DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1 },
}));
vi.mock("../../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const host = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  handlers: new Set<(e: NativeVoiceEnvelope) => void>(),
  connectResult: Promise.resolve({ session: 1, identity: "user-1" }),
  unsubscribed: 0,
}));
vi.mock("../../../platform/desktop", () => ({
  desktop: {
    nativeVoice: {
      connect: (...args: unknown[]) => {
        host.calls.push(["connect", args]);
        return host.connectResult;
      },
      disconnect: (...args: unknown[]) => {
        host.calls.push(["disconnect", args]);
        return Promise.resolve({ rooms: 0, localTracks: 0, admRefs: 0, threads: 12 });
      },
      setMicrophone: (...args: unknown[]) => {
        host.calls.push(["setMicrophone", args]);
        return Promise.resolve();
      },
      setSubscribed: (...args: unknown[]) => {
        host.calls.push(["setSubscribed", args]);
        return Promise.resolve();
      },
      onEvent: (handler: (e: NativeVoiceEnvelope) => void) => {
        host.handlers.add(handler);
        return () => {
          host.handlers.delete(handler);
          host.unsubscribed++;
        };
      },
    },
  },
}));

import { createNativeRoom } from "./nativeRoom";
import { nativeCounters } from "./counters";

const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const emit = (envelope: NativeVoiceEnvelope) => {
  for (const h of host.handlers) h(envelope);
};

beforeEach(() => {
  host.calls.length = 0;
  host.handlers.clear();
  host.unsubscribed = 0;
  host.connectResult = Promise.resolve({ session: 1, identity: "user-1" });
  nativeCounters.openRooms = 0;
  nativeCounters.listeners = 0;
  nativeCounters.rust = null;
});

describe("NativeRoom connect/disconnect", () => {
  it("subscribes before connecting, then reports connected with our identity", async () => {
    const room = createNativeRoom(audio);
    const connecting = room.connect("ws://127.0.0.1:7881/lk", "tok");
    expect(host.handlers.size).toBe(1);
    expect(room.state).toBe("connecting");
    await connecting;
    expect(room.state).toBe("connected");
    expect(room.localParticipant.identity).toBe("user-1");
    expect(host.calls).toEqual([["connect", ["ws://127.0.0.1:7881/lk", "tok", audio]]]);
    expect(nativeCounters).toMatchObject({ openRooms: 1, listeners: 1 });
  });

  it("replays events that arrived before the session id was known", async () => {
    const room = createNativeRoom(audio);
    let resolveConnect!: (v: { session: number; identity: string }) => void;
    host.connectResult = new Promise((r) => (resolveConnect = r));
    const connecting = room.connect("u", "t");
    emit({
      session: 3,
      event: {
        type: "connected",
        participants: [
          {
            identity: "user-2",
            tracks: [{ sid: "TR_a", kind: "audio", source: "microphone", muted: false }],
          },
        ],
      },
    });
    resolveConnect({ session: 3, identity: "user-1" });
    await connecting;
    expect([...room.remoteParticipants.keys()]).toEqual(["user-2"]);
    expect(room.remoteParticipants.get("user-2")?.audioTrackPublications.size).toBe(1);
  });

  it("ignores events for another session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({ session: 99, event: { type: "participantConnected", identity: "user-5" } });
    expect(room.remoteParticipants.size).toBe(0);
  });

  it("releases the subscription and closes only its own session on disconnect", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    await room.disconnect();
    expect(host.unsubscribed).toBe(1);
    expect(host.calls.at(-1)).toEqual(["disconnect", [1]]);
    expect(room.state).toBe("disconnected");
    expect(nativeCounters).toMatchObject({ openRooms: 0, listeners: 0, rust: { threads: 12 } });
    // Idempotent: a second disconnect issues nothing.
    await room.disconnect();
    expect(host.calls.filter(([n]) => n === "disconnect")).toHaveLength(1);
  });

  it("releases the subscription and rethrows when connect fails", async () => {
    const room = createNativeRoom(audio);
    host.connectResult = Promise.reject(new Error("no key"));
    await expect(room.connect("u", "t")).rejects.toThrow("no key");
    expect(host.unsubscribed).toBe(1);
    expect(room.state).toBe("disconnected");
    expect(nativeCounters).toMatchObject({ openRooms: 0, listeners: 0 });
    // Nothing to close: no native session id was ever issued.
    await room.disconnect();
    expect(host.calls.filter(([n]) => n === "disconnect")).toHaveLength(0);
  });
});

describe("NativeRoom room surface", () => {
  it("routes the microphone toggle to the native session", async () => {
    const room = createNativeRoom(audio);
    await expect(room.localParticipant.setMicrophoneEnabled(true)).rejects.toThrow(/not connected/);
    await room.connect("u", "t");
    await room.localParticipant.setMicrophoneEnabled(true);
    expect(host.calls.at(-1)).toEqual(["setMicrophone", [1, true]]);
    expect(room.isMicrophonePublished).toBe(true);
    await room.localParticipant.setMicrophoneEnabled(false);
    expect(room.isMicrophonePublished).toBe(false);
  });

  it("deafen unsubscribes remote audio publications through the session", async () => {
    const room = createNativeRoom(audio);
    await room.connect("u", "t");
    emit({
      session: 1,
      event: {
        type: "trackPublished",
        identity: "user-2",
        track: { sid: "TR_a", kind: "audio", source: "microphone", muted: false },
      },
    });
    const pub = room.remoteParticipants.get("user-2")!.audioTrackPublications.get("TR_a")!;
    pub.setSubscribed(false);
    pub.setSubscribed(false); // unchanged: no second command
    expect(host.calls.filter(([n]) => n === "setSubscribed")).toEqual([
      ["setSubscribed", [1, "user-2", "TR_a", false]],
    ]);
    expect(pub.isSubscribed).toBe(false);
  });

  it("maps native events onto livekit RoomEvents", async () => {
    const room = createNativeRoom(audio);
    const speakers = vi.fn();
    const disconnected = vi.fn();
    const encryptionError = vi.fn();
    room
      .on("activeSpeakersChanged", speakers)
      .on("disconnected", disconnected)
      .on("encryptionError", encryptionError);
    await room.connect("u", "t");
    emit({ session: 1, event: { type: "activeSpeakers", identities: ["user-2", "user-3"] } });
    expect(speakers).toHaveBeenCalledWith([{ identity: "user-2" }, { identity: "user-3" }]);
    emit({ session: 1, event: { type: "reconnecting" } });
    expect(room.state).toBe("reconnecting");
    emit({ session: 1, event: { type: "reconnected" } });
    expect(room.state).toBe("connected");
    emit({ session: 1, event: { type: "encryptionStatus", identity: "user-1", encrypted: false } });
    expect(encryptionError).toHaveBeenCalledTimes(1);
    emit({ session: 1, event: { type: "participantConnected", identity: "user-2" } });
    emit({ session: 1, event: { type: "participantDisconnected", identity: "user-2" } });
    expect(room.remoteParticipants.size).toBe(0);
    emit({ session: 1, event: { type: "disconnected", reason: "ServerShutdown" } });
    expect(disconnected).toHaveBeenCalledWith(0);
    expect(room.state).toBe("disconnected");
    room.removeAllListeners();
    emit({ session: 1, event: { type: "disconnected", reason: "ClientInitiated" } });
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("answers the Room calls the shared modules make without a browser", async () => {
    const room = createNativeRoom(audio);
    await expect(room.setE2EEEnabled(true)).resolves.toBeUndefined();
    await expect(room.startAudio()).resolves.toBeUndefined();
    await expect(room.switchActiveDevice("audioinput", "x")).resolves.toBe(true);
    expect(room.canPlaybackAudio).toBe(true);
    expect(room.engine.pcManager).toBeUndefined();
    expect(room.localParticipant.getTrackPublication()).toBeUndefined();
    expect(room.localParticipant.permissions).toBeUndefined();
    await expect(room.localParticipant.setCameraEnabled()).rejects.toThrow(/Linux/);
  });
});
