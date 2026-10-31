import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeDm } from "../helpers/dmHarness";
import {
  applyPresenceBatch,
  membersStore,
  resetMembersStore,
  setMembers,
  updatePresence,
} from "@stores/members.store";
import { dmStore, resetDmStore, setDmChannels } from "@stores/dm.store";
import { handlePresence, handlePresenceBatch } from "../../src/features/channels/wsHandlers";
import type { Payload } from "../../src/features/connection/dispatchContext";
import type { ReadyMember } from "@lib/types";

const ALICE: ReadyMember = {
  id: 1,
  username: "alice",
  avatar: null,
  role: "member",
  status: "online",
};

function mobileOf(id: number): boolean | undefined {
  return membersStore.getState().members.get(id)?.mobile;
}

describe("members store: on the phone app", () => {
  beforeEach(() => {
    resetMembersStore();
    resetDmStore();
  });
  afterEach(() => {
    resetMembersStore();
    resetDmStore();
  });

  it("a ready member without the field is not on the phone, one with it is", () => {
    setMembers([ALICE, { ...ALICE, id: 2, username: "bob", mobile: true }]);
    expect(mobileOf(1) === true).toBe(false);
    expect(mobileOf(2)).toBe(true);
  });

  it("a presence with mobile true sets it and a later one without it clears it", () => {
    setMembers([ALICE]);
    updatePresence(1, "online", undefined, undefined, undefined, undefined, true);
    expect(mobileOf(1)).toBe(true);
    updatePresence(1, "online", undefined, undefined, undefined, undefined, false);
    expect(mobileOf(1)).toBe(false);
  });

  it("an optimistic local status flip keeps the flag the server last sent", () => {
    setMembers([ALICE]);
    updatePresence(1, "online", undefined, undefined, undefined, undefined, true);
    updatePresence(1, "dnd", null, "2030-01-01T00:00:00Z");
    expect(membersStore.getState().members.get(1)?.status).toBe("dnd");
    expect(mobileOf(1)).toBe(true);
  });

  it("a presence_batch entry sets and clears it, and a full snapshot clears whoever it leaves out", () => {
    setMembers([ALICE, { ...ALICE, id: 2, username: "bob" }]);
    applyPresenceBatch(
      [
        { user_id: 1, status: "online", custom_status: null, mobile: true },
        { user_id: 2, status: "idle", custom_status: null },
      ],
      false,
    );
    expect(mobileOf(1)).toBe(true);
    expect(mobileOf(2)).toBe(false);

    applyPresenceBatch([{ user_id: 2, status: "online", custom_status: null }], true);
    expect(mobileOf(1)).toBe(false);
    expect(membersStore.getState().members.get(1)?.status).toBe("offline");
  });

  it("the dispatcher handlers treat an absent mobile as false and reach the DM list copy", () => {
    setMembers([ALICE]);
    setDmChannels([
      makeDm({
        channelId: 9,
        recipient: { id: 1, username: "alice", avatar: "", status: "online" },
        participants: [{ id: 1, username: "alice", avatar: "", status: "online" }],
      }),
    ]);
    handlePresence({ user_id: 1, status: "online", mobile: true } as Payload<"presence">);
    expect(mobileOf(1)).toBe(true);
    expect(dmStore.getState().channels[0]?.recipient.mobile).toBe(true);

    handlePresence({ user_id: 1, status: "online" } as Payload<"presence">);
    expect(mobileOf(1)).toBe(false);
    expect(dmStore.getState().channels[0]?.recipient.mobile).toBe(false);

    handlePresenceBatch({
      updates: [{ user_id: 1, status: "idle", custom_status: null, mobile: true }],
    } as Payload<"presence_batch">);
    expect(mobileOf(1)).toBe(true);
    expect(dmStore.getState().channels[0]?.recipient.mobile).toBe(true);
  });
});
