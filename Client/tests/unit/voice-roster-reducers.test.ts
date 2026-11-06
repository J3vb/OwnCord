import { describe, it, expect } from "vitest";
import { createVoiceState } from "../../src/stores/voiceModel";
import type { VoiceState, VoiceUser } from "../../src/stores/voiceModel";
import {
  ownReadyRow,
  withJoinedChannel,
  withLeftChannel,
  withSpeakers,
  withVoiceState,
} from "../../src/stores/voiceRoster";
import { viewersOfShare, withPeerWatching } from "../../src/stores/voicePeers";
import type { ReadyVoiceState } from "../../src/lib/types";

const user = (userId: number, overrides: Partial<VoiceUser> = {}): VoiceUser => ({
  userId,
  username: `u${userId}`,
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screenshare: false,
  ...overrides,
});

const inChannel = (...users: VoiceUser[]): VoiceState => ({
  ...createVoiceState(),
  currentChannelId: 4,
  voiceStatus: "connected",
  voiceUsers: new Map([[4, new Map(users.map((u) => [u.userId, u]))]]),
});

describe("ownReadyRow", () => {
  const rows = [{ channel_id: 4, user_id: 9 }] as unknown as ReadyVoiceState[];

  it("finds the signed-in user's row only while this device holds the call", () => {
    expect(ownReadyRow(rows, 9, "connected")?.channel_id).toBe(4);
    expect(ownReadyRow(rows, 9, "idle")).toBeUndefined();
    expect(ownReadyRow(rows, 0, "connected")).toBeUndefined();
    expect(ownReadyRow(rows, 8, "connected")).toBeUndefined();
  });
});

describe("withVoiceState", () => {
  const payload = {
    channel_id: 4,
    user_id: 2,
    username: "u2",
    muted: true,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  };

  it("keeps the speaking flag of a user who is already there", () => {
    const next = withVoiceState(inChannel(user(2, { speaking: true })), payload, 1);

    expect(next.voiceUsers.get(4)?.get(2)).toMatchObject({ muted: true, speaking: true });
  });

  it("mirrors the moderator flags only for the signed-in user of a live call", () => {
    const own = { ...payload, user_id: 1, server_muted: true };

    expect(withVoiceState(inChannel(), own, 1).localServerMuted).toBe(true);
    expect(
      withVoiceState({ ...inChannel(), voiceStatus: "idle" }, own, 1).localServerMuted,
    ).toBeFalsy();
    expect(withVoiceState(inChannel(), { ...own, user_id: 2 }, 1).localServerMuted).toBeFalsy();
  });
});

describe("channel membership", () => {
  it("returns the same state when joining the channel already held", () => {
    const state = inChannel();

    expect(withJoinedChannel(state, 4, 100)).toBe(state);
  });

  it("clears speaking rings in the channel being left behind on a switch", () => {
    const next = withJoinedChannel(inChannel(user(2, { speaking: true })), 5, 100);

    expect(next).toMatchObject({ currentChannelId: 5, joinedAt: 100, voiceStatus: "joining" });
    expect(next.voiceUsers.get(4)?.get(2)?.speaking).toBe(false);
  });

  it("drops the signed-in user's row and the empty channel on leave", () => {
    const next = withLeftChannel(inChannel(user(1)), 1);

    expect(next.voiceUsers.has(4)).toBe(false);
    expect(next).toMatchObject({ currentChannelId: null, voiceStatus: "idle", joinedAt: null });
  });
});

describe("withSpeakers", () => {
  it("ignores a frame for another channel", () => {
    const state = inChannel(user(2));

    expect(withSpeakers(state, { channel_id: 9, speakers: [2] }, 1)).toBe(state);
  });

  it("flips only the rows whose flag changed", () => {
    const quiet = user(3);
    const next = withSpeakers(inChannel(user(2), quiet), { channel_id: 4, speakers: [2] }, 1);

    expect(next.voiceUsers.get(4)?.get(2)?.speaking).toBe(true);
    expect(next.voiceUsers.get(4)?.get(3)).toBe(quiet);
  });
});

describe("watching", () => {
  it("ignores a user outside the roster and an unchanged list", () => {
    const state = inChannel(user(2));
    expect(withPeerWatching(state, 7, [1])).toBe(state);

    const watching = withPeerWatching(state, 2, [1]);
    expect(withPeerWatching(watching, 2, [1])).toBe(watching);
    expect(withPeerWatching(state, 2, [])).toBe(state);
  });

  it("lists the viewers of a share, sorted, never the sharer", () => {
    const state: VoiceState = {
      ...inChannel(user(5, { screenshare: true }), user(2), user(3), user(1)),
      peerWatching: new Map([
        [3, [5]],
        [2, [5]],
      ]),
    };

    expect(viewersOfShare(state, 5, true, 1)).toEqual([1, 2, 3]);
    expect(viewersOfShare(state, 5, false, 1)).toEqual([2, 3]);
    expect(viewersOfShare(state, 2, false, 1)).toEqual([]);
  });
});
