import { describe, expect, it } from "vitest";
import {
  joinTarget,
  type JoinInputs,
  type RoomCapacity,
} from "../../../src/features/members/buddies/joinTarget";
import type { VoiceRoom } from "../../../src/features/members/memberVoice";

const LOUNGE: VoiceRoom = { channelId: 6, name: "Lounge", afk: false };
const DEN: VoiceRoom = { channelId: 7, name: "Den", afk: false };
const AFK: VoiceRoom = { channelId: 9, name: "Sleepers", afk: true };

/** Viewer 1 is connected, in no room, and may join; Rin (2) is in Lounge,
 *  Marco (3) in Den, Pim (4) in the AFK room, the viewer is listed in Den too. */
function inputs(over: Partial<JoinInputs> = {}): JoinInputs {
  return {
    selfId: 1,
    rooms: new Map([
      [1, DEN],
      [2, LOUNGE],
      [3, DEN],
      [4, AFK],
    ]),
    capacity: new Map(),
    currentChannelId: null,
    switching: false,
    connected: true,
    timedOut: false,
    ...over,
  };
}

const cap = (
  connected: number,
  max: number,
  canModerateVoice: boolean | undefined,
): ReadonlyMap<number, RoomCapacity> => new Map([[6, { connected, max, canModerateVoice }]]);

describe("joinTarget", () => {
  it("offers the member's room when every rule passes", () => {
    expect(joinTarget(2, inputs())).toBe(LOUNGE);
    expect(joinTarget(3, inputs())).toBe(DEN);
  });

  it("never offers a Join on yourself, even in a room you are not in", () => {
    expect(joinTarget(1, inputs())).toBeNull();
    // Before sign-in there is no self id: a member is still judged by the rest.
    expect(joinTarget(2, inputs({ selfId: null }))).toBe(LOUNGE);
  });

  it("offers nothing for a member in no server voice room (a DM call is never in the map)", () => {
    expect(joinTarget(5, inputs())).toBeNull();
  });

  it("offers nothing for your own room", () => {
    expect(joinTarget(3, inputs({ currentChannelId: 7 }))).toBeNull();
    // Another room while you are in one is a switch, and is offered.
    expect(joinTarget(2, inputs({ currentChannelId: 7 }))).toBe(LOUNGE);
  });

  it("offers nothing while a switch waits for the server", () => {
    expect(joinTarget(2, inputs({ switching: true }))).toBeNull();
  });

  it("never offers the AFK room", () => {
    expect(joinTarget(4, inputs())).toBeNull();
  });

  describe("a room with a user limit", () => {
    it("full: no Join when canModerateVoice is false or absent, a Join when true", () => {
      expect(joinTarget(2, inputs({ capacity: cap(2, 2, false) }))).toBeNull();
      expect(joinTarget(2, inputs({ capacity: cap(2, 2, undefined) }))).toBeNull();
      expect(joinTarget(2, inputs({ capacity: cap(2, 2, true) }))).toBe(LOUNGE);
    });

    it("over its limit is full too", () => {
      expect(joinTarget(2, inputs({ capacity: cap(3, 2, false) }))).toBeNull();
    });

    it("one below its limit is offered", () => {
      expect(joinTarget(2, inputs({ capacity: cap(1, 2, false) }))).toBe(LOUNGE);
      expect(joinTarget(2, inputs({ capacity: cap(1, 2, undefined) }))).toBe(LOUNGE);
    });

    it("a limit of 0 is no limit", () => {
      expect(joinTarget(2, inputs({ capacity: cap(5, 0, false) }))).toBe(LOUNGE);
    });

    it("another room's limit does not matter", () => {
      expect(joinTarget(3, inputs({ capacity: cap(2, 2, false) }))).toBe(DEN);
    });
  });

  it("offers nothing while the socket is down or you are timed out (a frozen room)", () => {
    expect(joinTarget(2, inputs({ connected: false }))).toBeNull();
    expect(joinTarget(2, inputs({ timedOut: true }))).toBeNull();
  });

  it("checks the rules in order: each earlier rule wins with the later ones passing", () => {
    // Every later rule would also refuse; the result is the same none.
    const allBad = inputs({
      switching: true,
      connected: false,
      timedOut: true,
      capacity: cap(2, 2, false),
    });
    expect(joinTarget(2, allBad)).toBeNull();
    // Lifting the earlier refusals one by one leaves the next one refusing.
    expect(joinTarget(2, { ...allBad, switching: false })).toBeNull();
    expect(joinTarget(2, { ...allBad, switching: false, capacity: new Map() })).toBeNull();
    expect(
      joinTarget(2, { ...allBad, switching: false, capacity: new Map(), connected: true }),
    ).toBeNull();
    expect(
      joinTarget(2, {
        ...allBad,
        switching: false,
        capacity: new Map(),
        connected: true,
        timedOut: false,
      }),
    ).toBe(LOUNGE);
  });
});
