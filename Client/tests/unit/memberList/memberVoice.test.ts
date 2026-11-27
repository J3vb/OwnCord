import { describe, expect, it } from "vitest";
import { roomsKey, voiceRoomsByUser } from "../../../src/features/members/memberVoice";
import type { Channel } from "@stores/channels.store";
import type { VoiceUser } from "@stores/voice.store";
import { makeChannel } from "../../helpers/channelFactory";
import { voiceUser } from "../../helpers/voiceUsers";

const roster = (
  ...rooms: Array<[number, VoiceUser[]]>
): ReadonlyMap<number, ReadonlyMap<number, VoiceUser>> =>
  new Map(rooms.map(([id, users]) => [id, new Map(users.map((u) => [u.userId, u]))]));

const channels = (...list: Channel[]): ReadonlyMap<number, Channel> =>
  new Map(list.map((c) => [c.id, c]));

const LOUNGE = makeChannel({ id: 6, name: "Lounge", type: "voice" });
const AFK = makeChannel({ id: 7, name: "Away", type: "voice", afk: true });
const GENERAL = makeChannel({ id: 3, name: "general", type: "text" });

describe("voiceRoomsByUser", () => {
  it("maps each member in a server voice room to that room", () => {
    const rooms = voiceRoomsByUser(
      roster([6, [voiceUser(2), voiceUser(3)]]),
      channels(LOUNGE, GENERAL),
    );
    expect([...rooms]).toEqual([
      [2, { channelId: 6, name: "Lounge", afk: false }],
      [3, { channelId: 6, name: "Lounge", afk: false }],
    ]);
  });

  it("ignores DM calls and channels that are not voice rooms", () => {
    // 90 is a DM call: the channel store has no such channel.
    const rooms = voiceRoomsByUser(
      roster([90, [voiceUser(2)]], [3, [voiceUser(4)]]),
      channels(LOUNGE, GENERAL),
    );
    expect(rooms.size).toBe(0);
  });

  it("keeps the first room for a member listed twice", () => {
    const rooms = voiceRoomsByUser(
      roster([7, [voiceUser(2)]], [6, [voiceUser(2), voiceUser(5)]]),
      channels(LOUNGE, AFK),
    );
    expect(rooms.get(2)).toEqual({ channelId: 7, name: "Away", afk: true });
    expect(rooms.get(5)?.channelId).toBe(6);
  });

  it("carries the AFK flag, absent read as false", () => {
    const rooms = voiceRoomsByUser(
      roster([6, [voiceUser(1)]], [7, [voiceUser(2)]]),
      channels(LOUNGE, AFK),
    );
    expect(rooms.get(1)?.afk).toBe(false);
    expect(rooms.get(2)?.afk).toBe(true);
  });
});

describe("roomsKey", () => {
  const both = channels(LOUNGE, AFK);

  it("does not depend on the order of the rooms or the users", () => {
    const a = voiceRoomsByUser(
      roster([6, [voiceUser(2), voiceUser(3)]], [7, [voiceUser(4)]]),
      both,
    );
    const b = voiceRoomsByUser(
      roster([7, [voiceUser(4)]], [6, [voiceUser(3), voiceUser(2)]]),
      both,
    );
    expect(roomsKey(a)).toBe(roomsKey(b));
  });

  it("ignores speaking, mute, deafen, camera and screen share", () => {
    const quiet = voiceRoomsByUser(roster([6, [voiceUser(2)]]), both);
    const busy = voiceRoomsByUser(
      roster([
        6,
        [
          voiceUser(2, {
            speaking: true,
            muted: true,
            deafened: true,
            camera: true,
            screenshare: true,
          }),
        ],
      ]),
      both,
    );
    expect(roomsKey(busy)).toBe(roomsKey(quiet));
  });

  it("changes on a move, a rename and the AFK flag", () => {
    const base = roomsKey(voiceRoomsByUser(roster([6, [voiceUser(2)]]), both));
    const moved = roomsKey(voiceRoomsByUser(roster([7, [voiceUser(2)]]), both));
    const renamed = roomsKey(
      voiceRoomsByUser(roster([6, [voiceUser(2)]]), channels({ ...LOUNGE, name: "Den" })),
    );
    const afk = roomsKey(
      voiceRoomsByUser(roster([6, [voiceUser(2)]]), channels({ ...LOUNGE, afk: true })),
    );
    expect(new Set([base, moved, renamed, afk]).size).toBe(4);
    expect(roomsKey(new Map())).toBe("");
  });

  it("a name with the separator in it cannot collide with another pair", () => {
    const odd = channels({ ...LOUNGE, name: 'a"],[3' });
    const key = roomsKey(voiceRoomsByUser(roster([6, [voiceUser(2)]]), odd));
    expect(key.split("\n")).toHaveLength(1);
  });
});
