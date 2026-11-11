import { describe, it, expect, beforeEach } from "vitest";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { joinVoiceChannel, resetVoiceStore } from "../../stores/voice.store";
import {
  LEAVE_ECHO_WAIT_MS,
  OLD_SERVER_JOIN_CODES,
  leaveEndsEarlierStay,
  noteJoinAnswered,
  noteJoinSent,
  noteTokenAccepted,
  noteTokenIgnored,
  resetJoinRequest,
  takeJoinRefusal,
  takeStrandedMembership,
} from "./joinRequest";

describe("joinRequest", () => {
  beforeEach(() => {
    resetJoinRequest();
    resetServerCapabilities();
  });

  it("lists exactly the codes an older server's join refusal carries", () => {
    expect([...OLD_SERVER_JOIN_CODES].toSorted()).toEqual([
      "ALREADY_JOINED",
      "BAD_REQUEST",
      "CHANNEL_FULL",
      "FORBIDDEN",
      "INTERNAL",
      "NOT_FOUND",
      "RATE_LIMITED",
      "TIMED_OUT",
      "VOICE_ERROR",
    ]);
  });

  it("matches the pending join's id once", () => {
    noteJoinSent("join-1");
    expect(takeJoinRefusal("FORBIDDEN", "join-1")).toBe(true);
    expect(takeJoinRefusal("FORBIDDEN", "join-1")).toBe(false);
  });

  it("ignores an id that is not the latest join's", () => {
    noteJoinSent("join-1");
    noteJoinSent("join-2");
    expect(takeJoinRefusal("FORBIDDEN", "join-1")).toBe(false);
    expect(takeJoinRefusal("FORBIDDEN", "join-2")).toBe(true);
  });

  it("ignores any id while no join is pending", () => {
    expect(takeJoinRefusal("FORBIDDEN", "join-1")).toBe(false);
    noteJoinSent(undefined);
    expect(takeJoinRefusal("FORBIDDEN", "join-1")).toBe(false);
  });

  it("counts an id-less error only for a join code", () => {
    noteJoinSent("join-1");
    expect(takeJoinRefusal("INVALID_JSON", undefined)).toBe(false);
    expect(takeJoinRefusal("UNKNOWN_TYPE", undefined)).toBe(false);
    expect(takeJoinRefusal("CHANNEL_FULL", undefined)).toBe(true);
  });

  it("never counts an id-less error against a server that echoes join ids", () => {
    applyReadyCapabilities({ voice_messages: true });
    noteJoinSent("join-1");
    expect(takeJoinRefusal("FORBIDDEN", undefined)).toBe(false);
    expect(takeJoinRefusal("RATE_LIMITED", undefined)).toBe(false);
    expect(takeJoinRefusal("FORBIDDEN", "join-1")).toBe(true);
  });

  it("keeps the id-less fallback until a ready says otherwise", () => {
    applyReadyCapabilities({ threads: true });
    noteJoinSent("join-1");
    expect(takeJoinRefusal("FORBIDDEN", undefined)).toBe(true);
  });

  it("remembers a let-pass token until it is read or a token is taken up", () => {
    expect(takeStrandedMembership()).toBe(false);
    noteTokenIgnored();
    expect(takeStrandedMembership()).toBe(true);
    expect(takeStrandedMembership()).toBe(false);
    noteTokenIgnored();
    noteTokenAccepted();
    expect(takeStrandedMembership()).toBe(false);
  });
});

/** The user's click: the store names the channel, then the join goes out. */
function join(channelId: number, id: string | undefined): void {
  joinVoiceChannel(channelId);
  noteJoinSent(id);
}

// A voice_leave names a channel, not the stay in it that ended.
describe("which stay in a channel a voice_leave ends", () => {
  beforeEach(() => {
    resetJoinRequest();
    resetServerCapabilities();
    resetVoiceStore();
  });

  it("is the stay wanted now when only one join asked for the channel", () => {
    join(1, "a");
    expect(leaveEndsEarlierStay(1)).toBe(false);
    // And a leave no join accounts for.
    expect(leaveEndsEarlierStay(1)).toBe(false);
    expect(leaveEndsEarlierStay(2)).toBe(false);
  });

  it("is an earlier stay while a later join for the same channel is out", () => {
    join(1, "a");
    join(1, "b");
    expect(leaveEndsEarlierStay(1)).toBe(true);
    expect(leaveEndsEarlierStay(1)).toBe(false);
  });

  it("matches leaves to stays in order across another channel", () => {
    join(1, "a");
    join(2, "b");
    join(1, "c");
    expect(leaveEndsEarlierStay(1)).toBe(true);
    expect(leaveEndsEarlierStay(2)).toBe(false);
    expect(leaveEndsEarlierStay(1)).toBe(false);
  });

  it("counts a switch that keeps the live call by the channel it asks for", () => {
    join(1, "a");
    noteJoinSent("b", false, 2);
    noteJoinSent("c", false, 1);
    expect(leaveEndsEarlierStay(2)).toBe(false);
    expect(leaveEndsEarlierStay(1)).toBe(true);
  });

  it.each([
    ["the latest join, by its id", "b"],
    ["a superseded join, by its id", "a"],
  ])("forgets the stay of a refused join: %s", (_name, refused) => {
    join(1, "a");
    join(1, "b");
    takeJoinRefusal("CHANNEL_FULL", refused);
    expect(leaveEndsEarlierStay(1)).toBe(false);
  });

  it("forgets the latest join's stay on an older server's id-less refusal", () => {
    join(1, "a");
    join(1, "b");
    expect(takeJoinRefusal("CHANNEL_FULL", undefined)).toBe(true);
    expect(leaveEndsEarlierStay(1)).toBe(false);
  });

  it("does not track a join that got no envelope id", () => {
    join(1, "a");
    join(1, undefined);
    expect(leaveEndsEarlierStay(1)).toBe(false);
  });

  it("stops waiting for an earlier stay's leave some time after a later join was granted", () => {
    const now = Date.now();
    join(1, "a");
    join(1, "b");
    noteJoinAnswered(1);
    // Still inside the wait: the leave is the first stay's.
    expect(leaveEndsEarlierStay(1, now + LEAVE_ECHO_WAIT_MS - 1_000)).toBe(true);

    join(1, "c");
    noteJoinAnswered(1);
    // The second stay's leave never came; after the wait a leave ends the third.
    expect(leaveEndsEarlierStay(1, now + LEAVE_ECHO_WAIT_MS + 1_000)).toBe(false);
  });

  it("keeps the stay a granted join asked for, however long ago", () => {
    join(1, "a");
    noteJoinAnswered(1);
    join(1, "b");
    expect(leaveEndsEarlierStay(1, Date.now() + 10 * LEAVE_ECHO_WAIT_MS)).toBe(true);
  });

  it("remembers a bounded number of joins", () => {
    for (let i = 0; i < 20; i++) join(1, `join-${i}`);
    let earlier = 0;
    while (leaveEndsEarlierStay(1)) earlier++;
    expect(earlier).toBe(7);
  });
});
