import { beforeEach, describe, expect, it } from "vitest";
import { activityItems } from "../../../src/features/members/buddies/activityGroups";
import {
  buildModel,
  flattenModel,
  updateModel,
  type ListItem,
} from "../../../src/features/members/memberModel";
import { applyPresenceBatch, membersStore, type Member } from "@stores/members.store";
import type { ReadyRole } from "@lib/types";
import { makeMember, setTestMembers } from "../../helpers/memberListHarness";
import { resetMembersState } from "../../helpers/storeResets";

const NONE: ReadonlySet<string> = new Set();
const GAME = { name: "Starfall", startedAt: 1 };
const SONG = { title: "Song", artist: "A", player: "Spotify", startedAt: 1, durationMs: 0 };

const mapOf = (members: readonly Member[]): ReadonlyMap<number, Member> =>
  new Map(members.map((m) => [m.id, m]));

function items(members: readonly Member[], query = "", roles: readonly ReadyRole[] = []) {
  return activityItems(buildModel(mapOf(members), roles), query, NONE);
}

/** "key: member ids" per group, in order. */
function shape(list: readonly ListItem[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    if (item.kind === "header") out.push(`${item.key}:`);
    else if (item.kind === "row") out[out.length - 1] += ` ${item.member.id}`;
    else out.push(`empty ${item.text}`);
  }
  return out;
}

function groupOf(list: readonly ListItem[], id: number): string | undefined {
  let group: string | undefined;
  for (const item of list) {
    if (item.kind === "header") group = item.key;
    if (item.kind === "row" && item.member.id === id) return group;
  }
  return undefined;
}

describe("activityItems: the grouping table", () => {
  it.each([
    ["online", true, "a:game"],
    ["idle", true, "a:game"],
    ["dnd", true, "a:game"],
    ["online", false, "a:online"],
    ["idle", false, "a:away"],
    ["dnd", false, "a:dnd"],
    ["offline", false, "a:offline"],
    ["offline", true, "a:offline"],
    ["invisible", true, "a:offline"],
  ] as const)("%s with a game: %s goes to %s", (status, game, key) => {
    const member = makeMember({ id: 1, username: "ann", status, activity: game ? GAME : null });
    expect(groupOf(items([member]), 1)).toBe(key);
  });

  it("puts a listener in ONLINE, and a listener in a game in IN GAME", () => {
    const list = items([
      makeMember({ id: 1, username: "ann", listening: SONG }),
      makeMember({ id: 2, username: "bob", listening: SONG, activity: GAME }),
    ]);
    expect(shape(list)).toEqual(["a:game: 2", "a:online: 1"]);
  });

  it("lists your own invisible status in OFFLINE", () => {
    const list = items([makeMember({ id: 1, username: "me", status: "invisible" })]);
    expect(shape(list)).toEqual(["a:offline: 1"]);
  });
});

describe("activityItems: groups and headers", () => {
  const roster = [
    makeMember({ id: 1, username: "Zed", status: "offline" }),
    makeMember({ id: 2, username: "yan", status: "dnd" }),
    makeMember({ id: 3, username: "xi", status: "idle" }),
    makeMember({ id: 4, username: "wu" }),
    makeMember({ id: 5, username: "vi", activity: GAME }),
    makeMember({ id: 6, username: "ulf", activity: GAME, status: "idle" }),
  ];

  it("orders IN GAME, ONLINE, AWAY, DO NOT DISTURB, OFFLINE, each by name", () => {
    expect(shape(items(roster))).toEqual([
      "a:game: 6 5",
      "a:online: 4",
      "a:away: 3",
      "a:dnd: 2",
      "a:offline: 1",
    ]);
  });

  it("leaves out empty groups", () => {
    expect(shape(items(roster.filter((m) => m.id === 3 || m.id === 1)))).toEqual([
      "a:away: 3",
      "a:offline: 1",
    ]);
  });

  it("uses keys no role group can have", () => {
    const keys = items(roster)
      .filter((i) => i.kind === "header")
      .map((i) => i.key);
    const roleKeys = flattenModel(buildModel(mapOf(roster), []), "")
      .filter((i) => i.kind === "header")
      .map((i) => i.key);
    expect(keys.filter((k) => roleKeys.includes(k))).toEqual([]);
    expect(keys.every((k) => k.startsWith("a:"))).toBe(true);
  });

  it("writes Classic-style header text and marks only OFFLINE offline", () => {
    const headers = items(roster).filter((i) => i.kind === "header");
    expect(headers.map((h) => h.text)).toEqual([
      "IN GAME — 2",
      "ONLINE — 1",
      "AWAY — 1",
      "DO NOT DISTURB — 1",
      "OFFLINE — 1",
    ]);
    expect(headers.at(-1)).toMatchObject({ offline: true, collapsible: false, collapsed: false });
    expect(headers[0]).toMatchObject({ offline: false, collapsible: false, collapsed: false });
  });

  it("gives each row its member's key and role colour", () => {
    const row = items(roster).find((i) => i.kind === "row" && i.member.id === 4);
    expect(row).toMatchObject({ key: "u:4", colorVar: "var(--role-member, #949ba4)" });
  });

  it("filters within groups, and a header counts its matches", () => {
    const list = items([...roster, makeMember({ id: 7, username: "vicky", activity: GAME })], "vi");
    expect(shape(list)).toEqual(["a:game: 5 7"]);
    expect(list[0]).toMatchObject({ kind: "header", text: "IN GAME — 2" });
  });

  it("says when nobody is listed and when the search matches nobody", () => {
    expect(items([])).toEqual([{ kind: "empty", key: "empty", text: "No members online" }]);
    expect(items(roster, "nobody")).toEqual([
      { kind: "empty", key: "empty", text: "No members match your search" },
    ]);
  });

  it("sorts a member with hoisted roles by name among the rest", () => {
    const roles: ReadyRole[] = [
      { id: 10, name: "Mods", color: "#ff0000", permissions: 0, position: 5, hoist: true },
      { id: 11, name: "Members", color: null, permissions: 0, position: 1, hoist: false },
    ];
    const list = items(
      [
        makeMember({ id: 1, username: "cat", roleIds: [10] }),
        makeMember({ id: 2, username: "bea", roleIds: [11] }),
        makeMember({ id: 3, username: "dan", roleIds: [11] }),
      ],
      "",
      roles,
    );
    expect(shape(list)).toEqual(["a:online: 2 1 3"]);
    expect(list.find((i) => i.kind === "row" && i.member.id === 1)).toMatchObject({
      colorVar: "#ff0000",
    });
  });
});

describe("activityItems after a full presence snapshot", () => {
  beforeEach(() => resetMembersState());

  it("equals a fresh build, and nobody it made offline stays in a game", () => {
    const members: Member[] = Array.from({ length: 90 }, (_, i) =>
      makeMember({
        id: i + 1,
        username: `m${String(i + 1).padStart(3, "0")}`,
        activity: i % 2 === 0 ? GAME : null,
        status: i % 3 === 0 ? "idle" : "online",
      }),
    );
    setTestMembers(members);
    membersStore.flush();
    const prev = buildModel(membersStore.getState().members, []);
    // Only the first ten are listed: the other 80 (past the delta cap) go offline.
    applyPresenceBatch(
      members.slice(0, 10).map((m) => ({ user_id: m.id, status: "online", custom_status: null })),
      true,
    );
    membersStore.flush();
    const next = membersStore.getState().members;
    const updated = activityItems(updateModel(prev, next, []), "", NONE);
    expect(updated).toEqual(activityItems(buildModel(next, []), "", NONE));
    const offline = new Set(members.slice(10).map((m) => m.id));
    for (const id of offline) expect(groupOf(updated, id)).toBe("a:offline");
  });
});
