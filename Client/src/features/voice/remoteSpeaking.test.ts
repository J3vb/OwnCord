import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Track, type Room } from "livekit-client";
import { isLinuxDesktop } from "./native/platform";
import { RemoteSpeaking, SPEAKING_HOLD_MS } from "./remoteSpeaking";

vi.mock("./native/platform", () => ({ isLinuxDesktop: vi.fn(() => false) }));

/** A room whose one remote participant (user 2) receives audio on `trk-2`,
 *  with inbound-rtp counters the test advances. */
function fakeRoom() {
  const counters = { energy: 0, duration: 0 };
  const room = {
    engine: {
      pcManager: {
        subscriber: {
          getStats: async () =>
            new Map([
              [
                "in-1",
                {
                  type: "inbound-rtp",
                  kind: "audio",
                  trackIdentifier: "trk-2",
                  totalAudioEnergy: counters.energy,
                  totalSamplesDuration: counters.duration,
                },
              ],
            ]),
        },
      },
    },
    remoteParticipants: new Map([
      [
        "user-2",
        {
          identity: "user-2",
          getTrackPublication: (s: string) =>
            s === Track.Source.Microphone
              ? { track: { mediaStreamTrack: { id: "trk-2" } } }
              : undefined,
        },
      ],
    ]),
  } as unknown as Room;
  /** Receive `seconds` of audio at RMS `level` (energy is level² × time). */
  const receive = (level: number, seconds = 0.05): void => {
    counters.energy += level * level * seconds;
    counters.duration += seconds;
  };
  return { room, receive };
}

describe("RemoteSpeaking", () => {
  let changes: Array<number[]>;
  let detector: RemoteSpeaking;

  beforeEach(() => {
    vi.useFakeTimers();
    changes = [];
    detector = new RemoteSpeaking((ids) => changes.push([...ids]));
  });

  afterEach(() => {
    detector.setRoom(null);
    vi.useRealTimers();
  });

  it("lights a remote ring on the first poll its received audio carries speech", async () => {
    const { room, receive } = fakeRoom();
    detector.setRoom(room);
    await detector.poll(); // baseline
    receive(0.1);
    await detector.poll();
    expect(changes).toEqual([[2]]);
  });

  it("ignores received audio below speech level", async () => {
    const { room, receive } = fakeRoom();
    detector.setRoom(room);
    await detector.poll();
    receive(0.001);
    await detector.poll();
    expect(changes).toEqual([]);
  });

  it("holds the ring through a short pause, then drops it", async () => {
    const { room, receive } = fakeRoom();
    detector.setRoom(room);
    await detector.poll();
    receive(0.1);
    await detector.poll();
    vi.advanceTimersByTime(SPEAKING_HOLD_MS / 2);
    receive(0);
    await detector.poll();
    expect(changes).toEqual([[2]]);
    vi.advanceTimersByTime(SPEAKING_HOLD_MS);
    receive(0);
    await detector.poll();
    expect(changes).toEqual([[2], []]);
  });

  it("skips the stats read while no remote participant has a microphone track", async () => {
    const { room } = fakeRoom();
    const getStats = vi.fn(async () => new Map());
    (
      room as unknown as { engine: { pcManager: { subscriber: unknown } } }
    ).engine.pcManager.subscriber = { getStats };
    room.remoteParticipants.clear();
    detector.setRoom(room);
    await detector.poll();
    expect(getStats).not.toHaveBeenCalled();
  });

  it("clears its speakers when the room goes away", async () => {
    const { room, receive } = fakeRoom();
    detector.setRoom(room);
    await detector.poll();
    receive(0.1);
    await detector.poll();
    detector.setRoom(null);
    expect(changes).toEqual([[2], []]);
  });

  it("waits for the room's peer connection, which exists only once it connects", async () => {
    const { room, receive } = fakeRoom();
    const engine = (room as unknown as { engine: { pcManager?: unknown } }).engine;
    const pcManager = engine.pcManager;
    engine.pcManager = undefined;
    detector.setRoom(room);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    engine.pcManager = pcManager;
    await vi.advanceTimersByTimeAsync(100);
    receive(0.1);
    await vi.advanceTimersByTimeAsync(100);
    expect(changes).toEqual([[2]]);
  });

  it("polls nothing for the Linux native room, which has no browser peer connection", async () => {
    vi.mocked(isLinuxDesktop).mockReturnValueOnce(true);
    detector.setRoom(fakeRoom().room);
    expect(vi.getTimerCount()).toBe(0);
    expect(changes).toEqual([]);
  });
});
