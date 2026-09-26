import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalE2EEKeyProvider, Room, RoomEvent } from "livekit-client";

// The installed livekit-client, patched in patches/livekit-client+2.22.3.patch.
// The E2EE worker acknowledges every `enable` it is sent; the manager then looks
// the participant up by identity. A peer who left between the post and the ack
// (a quick leave, or the room's own reconnect re-posting for every peer) is no
// longer there, and the unpatched SDK threw from the worker's onmessage, an
// uncaught error nothing in the app can catch.
function roomWithWorker() {
  const worker = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    onerror: null,
    postMessage() {},
    terminate() {},
  };
  const room = new Room({
    e2ee: { keyProvider: new ExternalE2EEKeyProvider(), worker: worker as unknown as Worker },
  });
  const ack = (participantIdentity: string) =>
    worker.onmessage!({
      data: { kind: "enable", data: { enabled: true, participantIdentity } },
    } as MessageEvent);
  return { room, ack };
}

describe("livekit E2EE enable acknowledgement", () => {
  // jsdom has no WebRTC; this is the global livekit feature-detects E2EE by.
  beforeEach(() => vi.stubGlobal("RTCRtpScriptTransform", class {}));
  afterEach(() => vi.unstubAllGlobals());

  it("ignores the ack for a participant who already left", () => {
    const { ack } = roomWithWorker();
    expect(() => ack("user-1:departed")).not.toThrow();
  });

  it("still reports the local participant's encryption status", () => {
    const { room, ack } = roomWithWorker();
    room.localParticipant.identity = "user-2:local";
    const statuses: boolean[] = [];
    room.on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled) => statuses.push(enabled));
    ack("user-2:local");
    expect(statuses).toEqual([true]);
  });
});
