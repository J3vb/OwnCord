import { describe, it, expect, beforeEach } from "vitest";
import {
  OLD_SERVER_JOIN_CODES,
  noteJoinSent,
  resetJoinRequest,
  takeJoinRefusal,
} from "./joinRequest";

describe("joinRequest", () => {
  beforeEach(() => {
    resetJoinRequest();
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
});
