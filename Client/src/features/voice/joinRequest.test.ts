import { describe, it, expect, beforeEach } from "vitest";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import {
  OLD_SERVER_JOIN_CODES,
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
