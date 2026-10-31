/**
 * B7-13 / BPR-034: one live media session at a time, across a profile switch.
 *
 * The LiveKit session is a module singleton that holds at most one room. A
 * profile switch tears it down with `cleanupAll` (MainPage.destroy calls it),
 * and the next profile's join must start from nothing: the first room is
 * disconnected before the second is built, and the liveness predicate reads
 * false in between. The harness is the livekitSession/ tests' (helpers/livekitSessionMocks.ts), except that
 * every `new Room()` is a distinct object so live rooms can be counted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../helpers/livekitSessionMocks";

// Every `new Room()` gets its own object so the test can tell rooms apart
// and count the live ones.
const rooms = vi.hoisted(() => ({
  constructed: [] as Array<{ disconnect: { mock: { calls: unknown[] } } }>,
  events: [] as string[],
}));

function makeRoom() {
  const index = rooms.constructed.length;
  const room = {
    ...mocks.mockRoom,
    localParticipant: { ...mocks.mockRoom.localParticipant },
    disconnect: vi.fn(async () => {
      rooms.events.push(`disconnect:${index}`);
    }),
    name: `room-${index}`,
  };
  rooms.events.push(`construct:${index}`);
  rooms.constructed.push(room);
  return room;
}

vi.mock("livekit-client", () => ({
  ...mocks.livekitClientMock(),
  // vitest 4 mocks honor construct semantics — `new` needs a real function, not an arrow.
  Room: vi.fn(function () {
    return makeRoom();
  }),
}));
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

// Now import
import {
  cleanupAll,
  getRoomForStats,
  handleVoiceToken,
  isVoiceSessionActive,
  setServerHost,
  setWsClient,
} from "../../src/lib/voice/livekitSession";

/** Rooms built and not yet disconnected. */
function liveRooms(): number {
  return rooms.constructed.filter((room) => room.disconnect.mock.calls.length === 0).length;
}

describe("one live media session across a profile switch", () => {
  beforeEach(() => {
    rooms.constructed.length = 0;
    rooms.events.length = 0;
    mocks.mockVoiceState.currentChannelId = 1;
  });

  it("disconnects the first profile's room before the next profile's room exists", async () => {
    setServerHost("localhost:7880");
    setWsClient({ send: vi.fn() } as unknown as Parameters<typeof setWsClient>[0]);
    await handleVoiceToken("token-a", "/livekit", 1, "ws://localhost:7880", true);

    expect(isVoiceSessionActive()).toBe(true);
    expect(liveRooms()).toBe(1);
    const roomA = getRoomForStats();
    expect(roomA).toBe(rooms.constructed[0]);

    // The switch: MainPage.destroy's deep teardown.
    cleanupAll();
    await vi.waitFor(() => expect(liveRooms()).toBe(0));
    expect(isVoiceSessionActive()).toBe(false);
    expect(getRoomForStats()).toBeNull();

    setServerHost("localhost:7881");
    setWsClient({ send: vi.fn() } as unknown as Parameters<typeof setWsClient>[0]);
    await handleVoiceToken("token-b", "/livekit", 1, "ws://localhost:7881", true);

    expect(isVoiceSessionActive()).toBe(true);
    expect(liveRooms()).toBe(1);
    expect(getRoomForStats()).toBe(rooms.constructed[1]);
    expect(rooms.events).toEqual(["construct:0", "disconnect:0", "construct:1"]);

    cleanupAll();
    await vi.waitFor(() => expect(liveRooms()).toBe(0));
  });
});
