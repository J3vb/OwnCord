/**
 * The owed voice leave: a leave the server may not have seen is sent again on
 * the next handshake while this device holds no call, and only then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionResets } from "../../lib/net/sessionRegistry";
import {
  clearOwedLeave,
  isVoiceLeaveOwed,
  noteVoiceLeave,
  sendOwedVoiceLeave,
  settleVoiceLeave,
} from "./leaveOwed";
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  resetVoiceStore,
  setVoiceStatus,
} from "../../stores/voice.store";

function socketStub() {
  return { send: vi.fn(() => "id") };
}

function leaveFrom(channelId: number): void {
  joinVoiceChannel(channelId);
  noteVoiceLeave();
  leaveVoiceChannel();
}

beforeEach(() => resetVoiceStore());
afterEach(() => clearOwedLeave());

describe("owed voice leave", () => {
  it("is sent once on the next handshake while idle", () => {
    leaveFrom(7);
    const ws = socketStub();
    expect(sendOwedVoiceLeave(ws)).toBe(true);
    expect(ws.send).toHaveBeenCalledExactlyOnceWith({ type: "voice_leave", payload: {} });
    expect(sendOwedVoiceLeave(ws)).toBe(false);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("is settled by the server's leave of the same channel only", () => {
    leaveFrom(7);
    settleVoiceLeave(8);
    expect(isVoiceLeaveOwed()).toBe(true);
    settleVoiceLeave(7);
    expect(isVoiceLeaveOwed()).toBe(false);
    expect(sendOwedVoiceLeave(socketStub())).toBe(false);
  });

  it("is dropped, not sent, when this device is in a call again", () => {
    leaveFrom(7);
    joinVoiceChannel(9);
    setVoiceStatus("connected");
    const ws = socketStub();
    expect(sendOwedVoiceLeave(ws)).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(isVoiceLeaveOwed()).toBe(false);
  });

  it("is cleared by a new join and by a session reset", () => {
    leaveFrom(7);
    clearOwedLeave();
    expect(isVoiceLeaveOwed()).toBe(false);
    leaveFrom(7);
    runSessionResets("user");
    expect(isVoiceLeaveOwed()).toBe(false);
  });

  it("sends nothing when no leave was made", () => {
    const ws = socketStub();
    expect(sendOwedVoiceLeave(ws)).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
