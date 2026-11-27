import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuddyContext } from "../../../src/features/members/buddies/buddyContext";
import { channelsStore, type Channel } from "@stores/channels.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { voiceUser as user } from "../../helpers/voiceUsers";
import { makeChannel } from "../../helpers/channelFactory";
import { resetVoiceState } from "../../helpers/storeSeeds";

const LOUNGE = makeChannel({ id: 6, name: "Lounge", type: "voice" });
const DEN = makeChannel({ id: 7, name: "Den", type: "voice" });

function setRooms(...rooms: Array<[number, VoiceUser[]]>): void {
  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: new Map(rooms.map(([id, users]) => [id, new Map(users.map((u) => [u.userId, u]))])),
  }));
  voiceStore.flush();
}

function setChannelList(...list: Channel[]): void {
  channelsStore.setState((prev) => ({ ...prev, channels: new Map(list.map((c) => [c.id, c])) }));
  channelsStore.flush();
}

describe("createBuddyContext", () => {
  let owner: AbortController;

  beforeEach(() => {
    owner = new AbortController();
    resetVoiceState();
    setChannelList(LOUNGE, DEN);
    setRooms([6, [user(2), user(3)]]);
  });

  afterEach(() => {
    owner.abort();
    vi.useRealTimers();
  });

  it("reads the rooms at construction, as one cached object", () => {
    const source = createBuddyContext();
    expect(source.read().rooms.get(2)?.name).toBe("Lounge");
    expect(source.read()).toBe(source.read());
  });

  it("sees a change made between construction and subscribe", () => {
    const source = createBuddyContext();
    setRooms([7, [user(2)]]);
    expect(source.read().rooms.get(2)?.name).toBe("Lounge");
    source.subscribe(owner.signal, () => undefined);
    expect(source.read().rooms.get(2)?.name).toBe("Den");
    expect(source.read().rooms.has(3)).toBe(false);
  });

  it("stays silent on speaking, mute, deafen, camera and screen share", () => {
    const source = createBuddyContext();
    const onChange = vi.fn();
    source.subscribe(owner.signal, onChange);
    const before = source.read();
    setRooms([6, [user(2, { speaking: true, muted: true }), user(3, { camera: true })]]);
    setRooms([6, [user(2, { deafened: true }), user(3, { screenshare: true })]]);
    expect(onChange).not.toHaveBeenCalled();
    expect(source.read()).toBe(before);
  });

  it.each([
    ["a move", () => setRooms([6, [user(2)]], [7, [user(3)]])],
    ["a leave", () => setRooms([6, [user(2)]])],
    ["a room rename", () => setChannelList({ ...LOUNGE, name: "Lobby" }, DEN)],
    ["the AFK flag", () => setChannelList({ ...LOUNGE, afk: true }, DEN)],
  ])("fires once on %s, with the new context read", (_name, change) => {
    const source = createBuddyContext();
    const onChange = vi.fn();
    source.subscribe(owner.signal, onChange);
    const before = source.read();
    change();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(source.read()).not.toBe(before);
  });

  it("reads the new context inside onChange", () => {
    const source = createBuddyContext();
    let seen: string | undefined;
    source.subscribe(owner.signal, () => {
      seen = source.read().rooms.get(3)?.name;
    });
    setRooms([6, [user(2)]], [7, [user(3)]]);
    expect(seen).toBe("Den");
  });

  it("stops when its owner aborts", () => {
    const source = createBuddyContext();
    const onChange = vi.fn();
    source.subscribe(owner.signal, onChange);
    owner.abort();
    setRooms([7, [user(2)]]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts no timer", () => {
    vi.useFakeTimers();
    const source = createBuddyContext();
    source.subscribe(owner.signal, () => undefined);
    setRooms([7, [user(2)]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
