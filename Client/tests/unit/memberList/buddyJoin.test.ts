import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../helpers/memberListMocks";
import "../../../src/features/profiles/userProfilePopup";
import "../../../src/features/moderation/AdminActions";
import { createMemberList } from "../../../src/features/members/MemberList";
import type { MemberListOptions } from "../../../src/features/members/memberListOptions";
import { joinMenuParams } from "../../../src/features/members/memberRowMenu";
import { buddiesListOptions } from "../../../src/features/members/buddies/buddiesSetup";
import { channelsStore, type Channel } from "@stores/channels.store";
import { setConnectionStatus } from "@stores/ui.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { safetyStore } from "../../../src/features/safety/store";
import { makeChannel } from "../../helpers/channelFactory";
import { resetVoiceState, signInAsAdmin } from "../../helpers/storeSeeds";
import { voiceUser } from "../../helpers/voiceUsers";
import { useMountContainer } from "../../helpers/mountContainer";
import {
  defaultOpts,
  makeMember,
  resetStore,
  rightClickMember,
  setTestMembers,
  topMenuLabels,
} from "../../helpers/memberListHarness";

const LOUNGE_ID = 6;
const DEN_ID = 7;
const AFK_ID = 9;
const DM_ID = 20;

function lounge(over: Partial<Channel> = {}): Channel {
  return makeChannel({ id: LOUNGE_ID, name: "Lounge", type: "voice", ...over });
}

const DEN = makeChannel({ id: DEN_ID, name: "Den", type: "voice" });
const AFK = makeChannel({ id: AFK_ID, name: "Sleepers", type: "voice", afk: true });
const DM = makeChannel({ id: DM_ID, name: "dm", type: "dm" });

/** Classic's top-level items for an admin on a member, as before Join. */
const CLASSIC_LABELS: readonly string[] = [
  "Profile",
  "Mention",
  "Change Role",
  "Force Logout",
  "Ban",
  "Block",
];

function setChannelList(...list: Channel[]): void {
  channelsStore.setState((prev) => ({ ...prev, channels: new Map(list.map((c) => [c.id, c])) }));
  channelsStore.flush();
}

/** Who is in which room: `[channelId, userIds]` pairs. */
function setRooms(...rooms: Array<[number, number[]]>): void {
  const users = (ids: number[]): Map<number, VoiceUser> =>
    new Map(ids.map((id) => [id, voiceUser(id)]));
  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: new Map(rooms.map(([id, ids]) => [id, users(ids)])),
  }));
  voiceStore.flush();
}

/** The viewer is testuser (1). Rin (2) and Marco (3) are in Lounge, Pim (4) in
 *  the AFK room, Dot (5) in a DM call, and Sam (6) in no room. */
function seedScene(): void {
  signInAsAdmin();
  setTestMembers([
    makeMember({ id: 1, username: "testuser", role: "admin" }),
    makeMember({ id: 2, username: "Rin" }),
    makeMember({ id: 3, username: "Marco" }),
    makeMember({ id: 4, username: "Pim", status: "idle" }),
    makeMember({ id: 5, username: "Dot" }),
    makeMember({ id: 6, username: "Sam" }),
  ]);
  setChannelList(lounge(), DEN, AFK, DM);
  setRooms([LOUNGE_ID, [2, 3]], [AFK_ID, [4]], [DM_ID, [5]]);
  setConnectionStatus("connected");
}

describe("Join in the Buddies row menu", () => {
  let host: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;
  const onJoinVoice = vi.fn<(channelId: number) => void>();

  useMountContainer(
    (c) => {
      host = c;
    },
    () => {
      list?.destroy?.();
      list = null;
      document.body.querySelectorAll(".context-menu").forEach((el) => el.remove());
    },
  );

  beforeEach(() => {
    resetStore();
    resetVoiceState();
    onJoinVoice.mockReset();
    seedScene();
  });

  afterEach(() => {
    setConnectionStatus("disconnected");
    safetyStore.setState((prev) => ({ ...prev, timeout: null }));
    setChannelList();
  });

  function mount(extra: Partial<MemberListOptions>): void {
    list = createMemberList({ ...defaultOpts(), ...extra });
    list.mount(host);
  }

  /** Mount the Deck list and right-click `id`; returns the Join row, or null. */
  async function deckMenuJoinRow(id: number): Promise<HTMLElement | null> {
    mount(buddiesListOptions(onJoinVoice));
    await rightClickMember(host, id);
    return document.body.querySelector<HTMLElement>('[data-testid="member-menu-join"]');
  }

  it('offers "Join {room}" for a member in another room, and the click joins it', async () => {
    const row = await deckMenuJoinRow(2);
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe("Join Lounge");
    row!.click();
    expect(onJoinVoice).toHaveBeenCalledTimes(1);
    expect(onJoinVoice).toHaveBeenCalledWith(LOUNGE_ID);
    // The row closes the menu.
    expect(document.body.querySelector(".context-menu")).toBeNull();
  });

  it("puts the row after Call in the top group", async () => {
    mount({ ...buddiesListOptions(onJoinVoice), onCallUser: vi.fn() });
    await rightClickMember(host, 2);
    const menu = document.body.querySelector<HTMLElement>(".context-menu")!;
    const labels = topMenuLabels(menu);
    expect(labels.indexOf("Join Lounge")).toBe(labels.indexOf("Call") + 1);
  });

  it("draws an untrusted room name as text", async () => {
    setChannelList(lounge({ name: "<img src=x onerror=1>" }), DEN, AFK, DM);
    const row = await deckMenuJoinRow(2);
    expect(row!.textContent).toBe("Join <img src=x onerror=1>");
    expect(row!.querySelector("img")).toBeNull();
  });

  it("offers no Join on yourself, a member in no room, a DM call or the AFK room", async () => {
    for (const id of [1, 6, 5, 4]) {
      expect(await deckMenuJoinRow(id)).toBeNull();
      list?.destroy?.();
    }
    expect(onJoinVoice).not.toHaveBeenCalled();
  });

  it("offers no Join for your own room", async () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: LOUNGE_ID }));
    voiceStore.flush();
    expect(await deckMenuJoinRow(2)).toBeNull();
  });

  it("offers no Join while the socket is down, during a switch, or while timed out", async () => {
    setConnectionStatus("reconnecting");
    expect(await deckMenuJoinRow(2)).toBeNull();
    list?.destroy?.();
    setConnectionStatus("connected");

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: DEN_ID, switchingTo: AFK_ID }));
    voiceStore.flush();
    expect(await deckMenuJoinRow(2)).toBeNull();
    list?.destroy?.();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, switchingTo: null }));
    voiceStore.flush();

    safetyStore.setState((prev) => ({ ...prev, timeout: { expiresAt: "2099-01-01T00:00:00Z" } }));
    expect(await deckMenuJoinRow(2)).toBeNull();
  });

  describe("a room with a user limit", () => {
    it("full: no row when canModerateVoice is false or absent, a row when true", async () => {
      setChannelList(lounge({ voiceMaxUsers: 2, canModerateVoice: false }), DEN, AFK, DM);
      expect(await deckMenuJoinRow(2)).toBeNull();
      list?.destroy?.();

      setChannelList(lounge({ voiceMaxUsers: 2 }), DEN, AFK, DM);
      expect(await deckMenuJoinRow(2)).toBeNull();
      list?.destroy?.();

      setChannelList(lounge({ voiceMaxUsers: 2, canModerateVoice: true }), DEN, AFK, DM);
      expect((await deckMenuJoinRow(2))?.textContent).toBe("Join Lounge");
    });

    it("one below its limit has a row", async () => {
      setChannelList(lounge({ voiceMaxUsers: 3, canModerateVoice: false }), DEN, AFK, DM);
      expect((await deckMenuJoinRow(2))?.textContent).toBe("Join Lounge");
    });

    it("a limit of 0 is no limit", async () => {
      setChannelList(lounge({ voiceMaxUsers: 0, canModerateVoice: false }), DEN, AFK, DM);
      expect((await deckMenuJoinRow(3))?.textContent).toBe("Join Lounge");
    });

    it("a room that fills between menu open and click: the click calls nothing", async () => {
      setChannelList(lounge({ voiceMaxUsers: 3, canModerateVoice: false }), DEN, AFK, DM);
      const row = await deckMenuJoinRow(2);
      expect(row).not.toBeNull();
      setRooms([LOUNGE_ID, [2, 3, 6]], [AFK_ID, [4]]);
      row!.click();
      expect(onJoinVoice).not.toHaveBeenCalled();
    });
  });

  it("the click reads the target again: a member who moved is joined in the new room", async () => {
    const row = await deckMenuJoinRow(2);
    setRooms([DEN_ID, [2]], [LOUNGE_ID, [3]]);
    row!.click();
    expect(onJoinVoice).toHaveBeenCalledTimes(1);
    expect(onJoinVoice).toHaveBeenCalledWith(DEN_ID);
  });

  it("the click reads the target again: a member who left joins nothing", async () => {
    const row = await deckMenuJoinRow(2);
    setRooms([LOUNGE_ID, [3]]);
    row!.click();
    expect(onJoinVoice).not.toHaveBeenCalled();
  });

  it("a menu opened before the socket drops sends nothing on click", async () => {
    const row = await deckMenuJoinRow(2);
    setConnectionStatus("disconnected");
    row!.click();
    expect(onJoinVoice).not.toHaveBeenCalled();
  });

  it("after the rooms are replaced, the menu follows the new rooms", async () => {
    // A reconnect's ready frame replaces the whole roster at once.
    setRooms([DEN_ID, [2, 3]]);
    const row = await deckMenuJoinRow(3);
    expect(row?.textContent).toBe("Join Den");
  });

  it("the Deck options without onJoinVoice offer no Join", async () => {
    mount(buddiesListOptions());
    await rightClickMember(host, 2);
    expect(document.body.querySelector('[data-testid="member-menu-join"]')).toBeNull();
  });

  it("Classic never offers Join, and its menu items are as before", async () => {
    mount({});
    await rightClickMember(host, 2);
    const menu = document.body.querySelector<HTMLElement>(".context-menu")!;
    expect(menu.querySelector('[data-testid="member-menu-join"]')).toBeNull();
    expect(topMenuLabels(menu)).toEqual(CLASSIC_LABELS);
  });
});

describe("joinMenuParams", () => {
  it("returns nothing without joinRoomFor", () => {
    expect(joinMenuParams({}, 2)).toEqual({});
  });

  it("returns nothing when the resolver names no room at open", () => {
    const resolve = vi.fn().mockReturnValue(null);
    expect(joinMenuParams({ joinRoomFor: resolve }, 2)).toEqual({});
    expect(resolve).toHaveBeenCalledWith(2);
  });

  it("returns the label, and a join that asks the resolver again on the click", () => {
    const first = vi.fn();
    const second = vi.fn();
    const resolve = vi
      .fn()
      .mockReturnValueOnce({ label: "Join Lounge", join: first })
      .mockReturnValueOnce({ label: "Join Den", join: second })
      .mockReturnValueOnce(null);
    const params = joinMenuParams({ joinRoomFor: resolve }, 2);
    expect(params).toMatchObject({ joinRoomLabel: "Join Lounge" });
    if (!("onJoinRoom" in params)) throw new Error("no onJoinRoom");
    params.onJoinRoom();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenNthCalledWith(2, 2);
    // A target gone by the click does nothing.
    params.onJoinRoom();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
