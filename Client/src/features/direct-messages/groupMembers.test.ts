import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addGroupMembers,
  buildGroupPanelView,
  canAddPeople,
  groupActionErrorText,
  isGroupOwner,
  removeGroupMember,
  transferGroupOwner,
} from "./groupMembers";
import { ApiClientError, type ApiClient } from "../../lib/api";
import { authStore } from "../../stores/auth.store";
import { dmStore, type DmChannel, type DmUser } from "../../stores/dm.store";
import { membersStore } from "../../stores/members.store";

const ME = 1;
const user = (id: number, username: string, displayName = ""): DmUser => ({
  id,
  username,
  avatar: "",
  status: "online",
  displayName,
});

function group(participants: DmUser[], over: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 5,
    recipient: participants[0]!,
    participants,
    name: "Crew",
    isGroup: true,
    ownerId: ME,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function seed(dm: DmChannel): void {
  dmStore.setState(() => ({ channels: [dm] }));
}

beforeEach(() => {
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  dmStore.setState(() => ({ channels: [] }));
  authStore.setState(() => ({
    token: "t",
    user: { id: ME, username: "me", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
});

describe("buildGroupPanelView", () => {
  it("lists you first, then the recipients, with the owner marked", () => {
    seed(group([user(2, "alice", "Al"), user(3, "carol")], { ownerId: 3 }));
    const view = buildGroupPanelView(5)!;
    expect(view.members.map((m) => [m.id, m.name, m.isSelf, m.isOwner])).toEqual([
      [1, "me", true, false],
      [2, "Al", false, false],
      [3, "carol", false, true],
    ]);
    expect(view.groupName).toBe("Crew");
  });

  it("prefers the live server member entry for name and presence", () => {
    seed(group([user(2, "alice")]));
    membersStore.setState(() => ({
      members: new Map([
        [
          2,
          {
            id: 2,
            username: "alice",
            displayName: "Alice A",
            avatar: null,
            role: "member",
            status: "dnd" as const,
          },
        ],
      ]),
      typingUsers: new Map(),
    }));
    const m = buildGroupPanelView(5)!.members[1]!;
    expect([m.name, m.status]).toEqual(["Alice A", "dnd"]);
  });

  it("is null for a 1:1 DM or an unknown channel", () => {
    seed(group([user(2, "alice")], { isGroup: false }));
    expect(buildGroupPanelView(5)).toBeNull();
    expect(buildGroupPanelView(404)).toBeNull();
  });

  it("canManage follows the owner; canAdd needs an owner field and room", () => {
    seed(group([user(2, "alice"), user(3, "carol")], { ownerId: 2 }));
    expect(buildGroupPanelView(5)).toMatchObject({ canManage: false, canAdd: true, slotsLeft: 7 });
    seed(group([user(2, "alice")], { ownerId: ME }));
    expect(buildGroupPanelView(5)).toMatchObject({ canManage: true, canAdd: true });
  });
});

describe("Add People / owner gates", () => {
  const nine = Array.from({ length: 9 }, (_, i) => user(i + 2, `u${i}`));

  it("is hidden at 10 members (9 recipients plus you)", () => {
    expect(canAddPeople(group(nine.slice(0, 8)))).toBe(true);
    expect(canAddPeople(group(nine))).toBe(false);
    seed(group(nine));
    expect(buildGroupPanelView(5)).toMatchObject({ canAdd: false, slotsLeft: 0 });
  });

  it("is hidden when the server sent no owner_id, and for a 1:1", () => {
    const { ownerId: _omit, ...noOwner } = group([user(2, "a"), user(3, "b")]);
    expect(canAddPeople(noOwner)).toBe(false);
    expect(isGroupOwner(noOwner, ME)).toBe(false);
    expect(canAddPeople(group([user(2, "a")], { isGroup: false }))).toBe(false);
  });

  it("isGroupOwner is true only for the owner", () => {
    const dm = group([user(2, "a"), user(3, "b")], { ownerId: 2 });
    expect(isGroupOwner(dm, 2)).toBe(true);
    expect(isGroupOwner(dm, ME)).toBe(false);
  });
});

const err = (status: number, code: string): ApiClientError =>
  new ApiClientError(status, code, "server words");

function fakeApi(over: Partial<Record<string, unknown>>): ApiClient {
  return over as unknown as ApiClient;
}

describe("groupActionErrorText", () => {
  it.each([
    [err(409, "GROUP_DM_FULL"), "add", "This group is full"],
    [err(403, "FORBIDDEN"), "add", "You can't add that person"],
    [err(404, "NOT_FOUND"), "add", "That person can't be added"],
    [err(403, "TIMED_OUT"), "add", "You're timed out and can't change this group right now"],
    [err(429, "RATE_LIMITED"), "add", "Too many requests. Try again later."],
    [err(500, "INTERNAL"), "add", "Something went wrong. Try again."],
    [err(403, "FORBIDDEN"), "remove", "Only the group owner can do that"],
    [err(404, "NOT_FOUND"), "remove", "That person isn't in this group anymore"],
    [err(404, "NOT_FOUND"), "owner", "That person isn't in this group anymore"],
    [err(403, "TIMED_OUT"), "owner", "You're timed out and can't change this group right now"],
    [err(429, "RATE_LIMITED"), "remove", "Too many requests. Try again later."],
  ] as const)("%s on %s reads %s", (e, action, text) => {
    expect(groupActionErrorText(e, action)).toBe(text);
  });

  it("treats a non-API failure (a network drop) as generic", () => {
    expect(groupActionErrorText(new TypeError("fetch failed"), "add")).toBe(
      "Something went wrong. Try again.",
    );
  });
});

describe("the three actions", () => {
  it("add resolves null on success (a 200 body and a 204 alike)", async () => {
    const add = vi.fn().mockResolvedValueOnce({ channel_id: 5 }).mockResolvedValueOnce(undefined);
    const api = fakeApi({ addGroupDmMembers: add });
    expect(await addGroupMembers(api, 5, [4, 6])).toBeNull();
    expect(await addGroupMembers(api, 5, [4])).toBeNull();
    expect(add).toHaveBeenCalledWith(5, [4, 6]);
  });

  it("add resolves the error text, never throws", async () => {
    const api = fakeApi({
      addGroupDmMembers: vi.fn().mockRejectedValue(new ApiClientError(409, "GROUP_DM_FULL", "x")),
    });
    expect(await addGroupMembers(api, 5, [4])).toBe("This group is full");
  });

  it("remove and make-owner call the right route and map failures", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const owner = vi.fn().mockRejectedValue(new ApiClientError(403, "FORBIDDEN", "x"));
    const api = fakeApi({ removeGroupDmMember: remove, setGroupDmOwner: owner });
    expect(await removeGroupMember(api, 5, 3)).toBeNull();
    expect(remove).toHaveBeenCalledWith(5, 3);
    expect(await transferGroupOwner(api, 5, 3)).toBe("Only the group owner can do that");
    expect(owner).toHaveBeenCalledWith(5, 3);
  });
});

describe("buildGroupPanelView fallbacks", () => {
  it("names the viewer by display name when the member list has no entry for them", () => {
    seed(group([user(2, "alice")]));
    authStore.setState(() => ({
      token: "t",
      user: {
        id: ME,
        username: "me",
        display_name: "Em Eye",
        avatar: "me.png",
        role: "member",
      },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));
    const self = buildGroupPanelView(5)!.members[0]!;
    expect([self.name, self.username, self.avatar]).toEqual(["Em Eye", "me", "me.png"]);
  });

  it("shows the viewer online unless their own status says otherwise", () => {
    seed(group([user(2, "alice")]));
    expect(buildGroupPanelView(5)!.members[0]!.status).toBe("online");
    authStore.setState(() => ({
      token: "t",
      user: { id: ME, username: "me", avatar: null, role: "member", status: "idle" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));
    expect(buildGroupPanelView(5)!.members[0]!.status).toBe("idle");
  });

  it("reads an empty recipient avatar as none and keeps a real one", () => {
    seed(
      group([
        { ...user(2, "alice"), avatar: "" },
        { ...user(3, "carol"), avatar: "carol.png" },
      ]),
    );
    const [, alice, carol] = buildGroupPanelView(5)!.members;
    expect(alice!.avatar).toBeNull();
    expect(carol!.avatar).toBe("carol.png");
  });
});

describe("group ownership gate", () => {
  it("never makes the viewer the owner of a conversation that is not a group", () => {
    const dm = group([user(2, "alice")], { isGroup: false, ownerId: ME });
    expect(isGroupOwner(dm, ME)).toBe(false);
  });
});

describe("groupActionErrorText rate limits", () => {
  it("reads a 429 as rate limited whatever code it carries", () => {
    expect(groupActionErrorText(err(429, "SOMETHING_ELSE"), "remove")).toBe(
      "Too many requests. Try again later.",
    );
  });

  it("reads the rate-limited code as rate limited whatever status carries it", () => {
    expect(groupActionErrorText(err(400, "RATE_LIMITED"), "owner")).toBe(
      "Too many requests. Try again later.",
    );
  });
});
