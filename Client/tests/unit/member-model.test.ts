import { describe, it, expect } from "vitest";
import {
  MAX_DELTA,
  buildItems,
  buildModel,
  compareEntries,
  flattenModel,
  updateModel,
  type Entry,
} from "../../src/features/members/memberModel";
import type { Member } from "../../src/stores/members.store";
import type { ReadyRole, UserStatus } from "../../src/lib/types";

const ROLES: readonly ReadyRole[] = [
  { id: 1, name: "Owner", color: null, permissions: 0 },
  { id: 2, name: "Admin", color: "#ff0000", permissions: 0 },
  { id: 3, name: "Member", color: null, permissions: 0 },
];
const STATUSES: readonly UserStatus[] = ["online", "idle", "dnd", "offline", "invisible"];
const ROLE_NAMES = ["owner", "admin", "member", "ghost"];

function member(id: number, over: Partial<Member> = {}): Member {
  return {
    id,
    username: `user${id}`,
    avatar: null,
    role: "member",
    status: "online",
    ...over,
  };
}

function mapOf(list: readonly Member[]): Map<number, Member> {
  return new Map(list.map((m) => [m.id, m]));
}

/** Small seeded PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countingCompare(): { compare: (a: Entry, b: Entry) => number; calls: () => number } {
  let n = 0;
  return {
    compare: (a, b) => {
      n += 1;
      return compareEntries(a, b);
    },
    calls: () => n,
  };
}

function names(members: ReadonlyMap<number, Member>): string[] {
  return buildItems(members, ROLES, "").map((i) => i.key);
}

describe("memberModel", () => {
  it("builds the grouped list with headers, an OFFLINE group and empty states", () => {
    const members = mapOf([
      member(1, { username: "zed", role: "owner" }),
      member(2, { username: "amy", role: "member" }),
      member(3, { username: "bob", role: "member", status: "invisible" }),
      member(4, { username: "cat", role: "ghost" }),
    ]);
    expect(buildItems(members, ROLES, "").map((i) => i.key)).toEqual([
      "g:owner",
      "u:1",
      "g:member",
      "u:2",
      "g:ghost",
      "u:4",
      "offline",
      "u:3",
    ]);
    expect(buildItems(new Map(), ROLES, "")).toMatchObject([{ kind: "empty", key: "empty" }]);
    expect(buildItems(members, ROLES, "nomatch")).toMatchObject([{ kind: "empty" }]);
  });

  it("incremental update equals a full build over random event sequences", () => {
    const rand = prng(20261017);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
    let members = mapOf(
      Array.from({ length: 150 }, (_, i) =>
        member(i + 1, {
          username: `name${Math.floor(rand() * 90)}`,
          role: pick(ROLE_NAMES),
          status: pick(STATUSES),
        }),
      ),
    );
    let model = buildModel(members, ROLES);
    let nextId = 1000;
    for (let step = 0; step < 300; step++) {
      const next = new Map(members);
      const events = 1 + Math.floor(rand() * 6);
      for (let e = 0; e < events; e++) {
        const ids = [...next.keys()];
        const id = pick(ids);
        const current = next.get(id)!;
        const kind = Math.floor(rand() * 5);
        if (kind === 0) next.set(id, { ...current, status: pick(STATUSES) });
        else if (kind === 1) next.set(id, { ...current, role: pick(ROLE_NAMES) });
        else if (kind === 2) {
          next.set(id, {
            ...current,
            displayName: rand() < 0.3 ? null : `dn${Math.floor(rand() * 90)}`,
          });
        } else if (kind === 3) {
          next.set(
            nextId,
            member(nextId, { username: `name${Math.floor(rand() * 90)}`, role: pick(ROLE_NAMES) }),
          );
          nextId += 1;
        } else if (next.size > 20) next.delete(id);
      }
      model = updateModel(model, next, ROLES);
      members = next;
      for (const query of ["", "name1", "@dn"]) {
        expect(flattenModel(model, query)).toEqual(buildItems(members, ROLES, query));
      }
    }
  });

  it("one presence flip on 2,000 members makes at most 2·log2(n)+4 comparator calls", () => {
    const list = Array.from({ length: 2000 }, (_, i) =>
      member(i + 1, {
        username: `n${String((i * 7919) % 2000).padStart(4, "0")}`,
        status: i % 3 === 0 ? "offline" : "online",
      }),
    );
    const members = mapOf(list);
    const counter = countingCompare();
    const model = buildModel(members, ROLES, counter.compare);
    const before = counter.calls();
    const next = new Map(members);
    next.set(500, {
      ...members.get(500)!,
      status: members.get(500)!.status === "online" ? "offline" : "online",
    });
    const updated = updateModel(model, next, ROLES, counter.compare);
    expect(counter.calls() - before).toBeLessThanOrEqual(2 * Math.log2(2000) + 4);
    expect(flattenModel(updated, "")).toEqual(buildItems(next, ROLES, ""));
  });

  it("a roles change, a setMembers snapshot or more than 64 changes rebuild fully", () => {
    const members = mapOf(
      Array.from({ length: 200 }, (_, i) => member(i + 1, { username: `u${i}` })),
    );
    const counter = countingCompare();
    const model = buildModel(members, ROLES, counter.compare);
    // A full rebuild makes exactly the comparator calls of a fresh build.
    const fullBuildCalls = (next: Map<number, Member>, roles: readonly ReadyRole[]): number => {
      const ref = countingCompare();
      buildModel(next, roles, ref.compare);
      return ref.calls();
    };

    // roles: a new reference swaps group order and colours, so no delta applies
    const reordered: readonly ReadyRole[] = [ROLES[2]!, ROLES[1]!, ROLES[0]!];
    let start = counter.calls();
    const swapped = updateModel(model, members, reordered, counter.compare);
    expect(counter.calls() - start).toBe(fullBuildCalls(members, reordered));
    expect(flattenModel(swapped, "")).toEqual(buildItems(members, reordered, ""));

    // snapshot: every object replaced
    const snapshot = new Map([...members].map(([id, m]) => [id, { ...m }]));
    start = counter.calls();
    const rebuilt = updateModel(model, snapshot, ROLES, counter.compare);
    expect(counter.calls() - start).toBe(fullBuildCalls(snapshot, ROLES));
    expect(rebuilt.members).toBe(snapshot);
    expect(flattenModel(rebuilt, "")).toEqual(buildItems(snapshot, ROLES, ""));

    // more than 64 changes: e.g. a presence_batch marking hundreds offline
    const batch = new Map(members);
    for (let id = 1; id <= MAX_DELTA + 1; id++)
      batch.set(id, { ...members.get(id)!, status: "offline" });
    start = counter.calls();
    const bulk = updateModel(model, batch, ROLES, counter.compare);
    expect(counter.calls() - start).toBe(fullBuildCalls(batch, ROLES));
    expect(flattenModel(bulk, "")).toEqual(buildItems(batch, ROLES, ""));

    // exactly the cap stays incremental
    const capped = new Map(members);
    for (let id = 1; id <= MAX_DELTA; id++)
      capped.set(id, { ...members.get(id)!, status: "offline" });
    start = counter.calls();
    const delta = updateModel(model, capped, ROLES, counter.compare);
    expect(counter.calls() - start).toBeLessThan(MAX_DELTA * 2 * 10);
    expect(flattenModel(delta, "")).toEqual(buildItems(capped, ROLES, ""));
  });

  it("returns the previous model for identical references and never mutates it", () => {
    const members = mapOf([member(1), member(2, { username: "aaa" })]);
    const model = buildModel(members, ROLES);
    expect(updateModel(model, members, ROLES)).toBe(model);
    const before = names(members);
    const next = new Map(members);
    next.set(1, { ...members.get(1)!, status: "offline" });
    updateModel(model, next, ROLES);
    expect(flattenModel(model, "").map((i) => i.key)).toEqual(before);
  });

  it("search filters while flattening with no comparator calls", () => {
    const members = mapOf(
      Array.from({ length: 300 }, (_, i) =>
        member(i + 1, {
          username: i % 10 === 0 ? `ali${i}` : `bo${i}`,
          status: i % 4 === 0 ? "offline" : "online",
        }),
      ),
    );
    const counter = countingCompare();
    const model = buildModel(members, ROLES, counter.compare);
    const before = counter.calls();
    const items = flattenModel(model, "  @ALI ");
    expect(counter.calls()).toBe(before);
    expect(items.filter((i) => i.kind === "row")).toHaveLength(30);
    expect(items).toEqual(buildItems(members, ROLES, "ali"));
    const headers = items.filter((i) => i.kind === "header");
    expect(headers.every((h) => h.kind === "header" && /\d/.test(h.text))).toBe(true);
  });
});

describe("memberModel with several roles", () => {
  const MULTI: readonly ReadyRole[] = [
    { id: 1, name: "Owner", color: "#e74c3c", permissions: 0, position: 40, hoist: true },
    { id: 2, name: "Staff", color: "#3498db", permissions: 0, position: 30, hoist: true },
    { id: 3, name: "Helper", color: "#2ecc71", permissions: 0, position: 20, hoist: false },
    { id: 4, name: "Member", color: null, permissions: 0, position: 10, hoist: false },
  ];
  const keys = (members: Map<number, Member>, roles = MULTI): string[] =>
    buildItems(members, roles, "").map((i) => i.key);

  it("groups by highest hoisted role", () => {
    const members = mapOf([
      member(1, { role: "helper", roleIds: [3, 2, 4] }),
      member(2, { role: "owner", roleIds: [4, 1] }),
      member(3, { role: "staff", roleIds: [2, 4] }),
    ]);
    // role_ids order is not trusted past the head: position decides.
    expect(keys(members)).toEqual(["g:owner", "u:2", "g:staff", "u:1", "u:3"]);
  });

  it("non-hoisted online members go to Online, between the role groups and Offline", () => {
    const members = mapOf([
      member(1, { role: "staff", roleIds: [2] }),
      member(2, { role: "helper", roleIds: [3, 4] }),
      member(3, { role: "member", roleIds: [4], status: "offline" }),
      member(4, { role: "member", roleIds: [4], status: "idle" }),
    ]);
    const items = buildItems(members, MULTI, "");
    expect(items.map((i) => i.key)).toEqual([
      "g:staff",
      "u:1",
      "online",
      "u:2",
      "u:4",
      "offline",
      "u:3",
    ]);
    const online = items.find((i) => i.key === "online");
    expect(online?.kind === "header" && online.text).toBe("ONLINE — 2");
    expect(online?.kind === "header" && online.offline).toBe(false);
  });

  it("no hoist field keeps per-role groups", () => {
    const old: readonly ReadyRole[] = [
      { id: 1, name: "Owner", color: null, permissions: 0, position: 30 },
      { id: 3, name: "Member", color: null, permissions: 0, position: 10 },
    ];
    const members = mapOf([
      member(1, { role: "owner" }),
      member(2, { role: "member" }),
      member(3, { role: "member", roleIds: [3] }),
    ]);
    expect(keys(members, old)).toEqual(["g:owner", "u:1", "g:member", "u:2", "u:3"]);
  });

  it("colour from highest coloured role", () => {
    const members = mapOf([
      // Member has no colour, Helper (20) beats nothing above it that is held.
      member(1, { role: "helper", roleIds: [3, 4] }),
      // Held [Member, Owner]: Owner has the highest position.
      member(2, { role: "owner", roleIds: [4, 1] }),
      // Only an uncoloured role: today's fallback colour.
      member(3, { role: "member", roleIds: [4] }),
    ]);
    const colors = new Map(
      buildItems(members, MULTI, "").flatMap((i) =>
        i.kind === "row" ? [[i.key, i.colorVar]] : [],
      ),
    );
    expect(colors.get("u:1")).toBe("#2ecc71");
    expect(colors.get("u:2")).toBe("#e74c3c");
    expect(colors.get("u:3")).toBe("var(--role-member, #949ba4)");
  });

  it("an incremental update that drops the hoisted role moves the row and equals a full build", () => {
    const before = mapOf([member(1, { role: "staff", roleIds: [2, 4] }), member(2)]);
    const prev = buildModel(before, MULTI);
    const after = new Map(before);
    after.set(1, { ...before.get(1)!, role: "member", roleIds: [4] });
    const next = updateModel(prev, after, MULTI);
    expect(flattenModel(next, "").map((i) => i.key)).toEqual(
      buildItems(after, MULTI, "").map((i) => i.key),
    );
    expect(flattenModel(prev, "").map((i) => i.key)).toContain("g:staff");
    expect(flattenModel(next, "").map((i) => i.key)).not.toContain("g:staff");
  });
});

describe("memberModel without a server role list", () => {
  it("falls back to the seeded roles, in rank order, with their theme colours", () => {
    const members = mapOf([
      member(1, { role: "member", username: "m" }),
      member(2, { role: "moderator", username: "mo" }),
      member(3, { role: "admin", username: "ad" }),
      member(4, { role: "owner", username: "ow" }),
    ]);
    const items = buildItems(members, [], "");
    expect(items.map((i) => i.key)).toEqual([
      "g:owner",
      "u:4",
      "g:admin",
      "u:3",
      "g:moderator",
      "u:2",
      "g:member",
      "u:1",
    ]);
    expect(
      items.filter((i) => i.kind === "header").map((i) => i.kind === "header" && i.text),
    ).toEqual(["OWNER — 1", "ADMIN — 1", "MODERATOR — 1", "MEMBER — 1"]);
    const colours = items.flatMap((i) => (i.kind === "row" ? [i.colorVar] : []));
    expect(colours).toEqual([
      "var(--role-owner, #e74c3c)",
      "var(--role-admin, #f39c12)",
      "var(--role-mod, #2ecc71)",
      "var(--role-member, #949ba4)",
    ]);
  });

  it("lists the member group before a role it does not know", () => {
    const members = mapOf([
      member(1, { role: "ghost", username: "g" }),
      member(2, { role: "member", username: "m" }),
    ]);
    const items = buildItems(members, [], "");
    expect(items.map((i) => i.key)).toEqual(["g:member", "u:2", "g:ghost", "u:1"]);
  });
});

describe("memberModel ordering and search text", () => {
  it("treats names that differ only by case or accent as equal and falls back to the id", () => {
    const byCase = mapOf([member(1, { username: "Bob" }), member(2, { username: "bob" })]);
    expect(names(byCase)).toEqual(["g:member", "u:1", "u:2"]);
    const byAccent = mapOf([member(1, { username: "résumé" }), member(2, { username: "resume" })]);
    expect(names(byAccent)).toEqual(["g:member", "u:1", "u:2"]);
  });

  it("sorts by display name when one is set", () => {
    const members = mapOf([
      member(1, { username: "aaa", displayName: "Zoe" }),
      member(2, { username: "zzz", displayName: "Amy" }),
    ]);
    expect(names(members)).toEqual(["g:member", "u:2", "u:1"]);
  });

  it("matches ignoring case, accents and a leading @", () => {
    const members = mapOf([
      member(1, { username: "user1", displayName: "José" }),
      member(2, { username: "other" }),
    ]);
    const rows = (query: string): string[] =>
      buildItems(members, ROLES, query).flatMap((i) => (i.kind === "row" ? [i.key] : []));
    expect(rows("josé")).toEqual(["u:1"]);
    expect(rows("JOSE")).toEqual(["u:1"]);
    expect(rows("@ jose")).toEqual(["u:1"]);
    expect(rows("José")).toEqual(["u:1"]);
  });

  it("strips only a leading @ from the query", () => {
    const members = mapOf([member(1, { username: "a@b" }), member(2, { username: "ab" })]);
    const rows = (query: string): string[] =>
      buildItems(members, ROLES, query).flatMap((i) => (i.kind === "row" ? [i.key] : []));
    expect(rows("a@b")).toEqual(["u:1"]);
    expect(rows("@ab")).toEqual(["u:2"]);
  });

  it("does not fold ß into ss", () => {
    const members = mapOf([member(1, { username: "Straße" })]);
    expect(buildItems(members, ROLES, "strasse")).toMatchObject([{ kind: "empty" }]);
    expect(buildItems(members, ROLES, "straße")).toMatchObject([
      { kind: "header" },
      { key: "u:1" },
    ]);
  });

  it("answers an empty list and a search with no match with the same empty row", () => {
    const members = mapOf([member(1)]);
    const none = buildItems(members, ROLES, "zzz");
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({ kind: "empty", key: "empty" });
    expect(none[0]).toMatchObject({ text: "No members match your search" });
    const nobody = buildItems(new Map(), ROLES, "");
    expect(nobody[0]).toMatchObject({ kind: "empty", text: "No members online" });
  });
});

describe("memberModel role resolution", () => {
  const role = (id: number, name: string, over: Partial<ReadyRole> = {}): ReadyRole => ({
    id,
    name,
    color: null,
    permissions: 0,
    ...over,
  });

  const colourOf = (
    members: Map<number, Member>,
    roles: readonly ReadyRole[],
    id: number,
  ): string | undefined => {
    const row = buildItems(members, roles, "").find((i) => i.key === `u:${id}`);
    return row?.kind === "row" ? row.colorVar : undefined;
  };

  it("does not group by a role marked as not hoisted", () => {
    const roles = [
      role(1, "Staff", { position: 30, hoist: false }),
      role(2, "Helper", { position: 20, hoist: true }),
    ];
    const members = mapOf([member(1, { role: "staff", roleIds: [1, 2] })]);
    expect(buildItems(members, roles, "").map((i) => i.key)).toEqual(["g:helper", "u:1"]);
    const onlyUnhoisted = mapOf([member(1, { role: "staff", roleIds: [1] })]);
    expect(buildItems(onlyUnhoisted, roles, "").map((i) => i.key)).toEqual(["online", "u:1"]);
  });

  it("falls back to the member's role name when none of its role ids are known", () => {
    const roles = [role(1, "Admin", { color: "#ff0000" }), role(2, "Member")];
    const members = mapOf([
      member(1, { role: "admin", roleIds: [999] }),
      member(2, { role: "admin", roleIds: [] }),
    ]);
    expect(buildItems(members, roles, "").map((i) => i.key)).toEqual(["g:admin", "u:1", "u:2"]);
    expect(colourOf(members, roles, 1)).toBe("#ff0000");
  });

  it("ranks roles without a position by their place in the list, first highest", () => {
    const roles = [role(1, "Owner"), role(2, "Staff"), role(3, "Crew")];
    const lowFirst = mapOf([member(1, { role: "crew", roleIds: [3, 2] })]);
    expect(buildItems(lowFirst, roles, "").map((i) => i.key)).toEqual(["g:staff", "u:1"]);
    const highFirst = mapOf([member(1, { role: "owner", roleIds: [1, 3] })]);
    expect(buildItems(highFirst, roles, "").map((i) => i.key)).toEqual(["g:owner", "u:1"]);
  });

  it.each([
    ["lowest first", [3, 2, 1]],
    ["highest first", [1, 2, 3]],
    ["middle first", [2, 1, 3]],
  ])("groups under the top hoisted role whatever the id order (%s)", (_label, roleIds) => {
    const roles = [
      role(1, "Owner", { position: 50 }),
      role(2, "Staff", { position: 40 }),
      role(3, "Crew", { position: 30 }),
    ];
    const members = mapOf([member(1, { role: "crew", roleIds })]);
    expect(buildItems(members, roles, "").map((i) => i.key)).toEqual(["g:owner", "u:1"]);
  });

  it("keeps the first of two hoisted roles with the same rank", () => {
    const roles = [role(1, "Alpha", { position: 30 }), role(2, "Beta", { position: 30 })];
    const ab = mapOf([member(1, { role: "alpha", roleIds: [1, 2] })]);
    expect(buildItems(ab, roles, "").map((i) => i.key)).toEqual(["g:alpha", "u:1"]);
    const ba = mapOf([member(1, { role: "beta", roleIds: [2, 1] })]);
    expect(buildItems(ba, roles, "").map((i) => i.key)).toEqual(["g:beta", "u:1"]);
  });

  it("colours a name by the highest-ranked role that has a colour", () => {
    const roles = [
      role(1, "Top", { position: 50 }),
      role(2, "Mid", { position: 40, color: "#222222" }),
      role(3, "Low", { position: 30, color: "#333333" }),
      role(4, "Twin", { position: 40, color: "#444444" }),
    ];
    const m = (id: number, roleIds: number[]): Member => member(id, { role: "top", roleIds });
    const members = mapOf([
      m(1, [3, 2]),
      m(2, [2, 3]),
      m(3, [1, 3]),
      m(4, [3, 1, 2]),
      m(5, [2, 4]),
      m(6, [4, 2]),
    ]);
    expect(colourOf(members, roles, 1)).toBe("#222222");
    expect(colourOf(members, roles, 2)).toBe("#222222");
    // An uncoloured higher role does not hide a coloured lower one.
    expect(colourOf(members, roles, 3)).toBe("#333333");
    expect(colourOf(members, roles, 4)).toBe("#222222");
    // Equal rank: the first held wins.
    expect(colourOf(members, roles, 5)).toBe("#222222");
    expect(colourOf(members, roles, 6)).toBe("#444444");
  });

  it("with no coloured role, uses the seeded colour of the top held role", () => {
    const roles = [
      role(1, "Owner", { position: 50, hoist: false }),
      role(2, "Admin", { position: 40, hoist: false }),
      role(3, "Crew", { position: 30, hoist: false }),
    ];
    const m = (id: number, roleIds: number[]): Member => member(id, { role: "crew", roleIds });
    const members = mapOf([m(1, [3, 2, 1]), m(2, [1, 2, 3]), m(3, [3, 2]), m(4, [2, 3])]);
    expect(colourOf(members, roles, 1)).toBe("var(--role-owner, #e74c3c)");
    expect(colourOf(members, roles, 2)).toBe("var(--role-owner, #e74c3c)");
    expect(colourOf(members, roles, 3)).toBe("var(--role-admin, #f39c12)");
    expect(colourOf(members, roles, 4)).toBe("var(--role-admin, #f39c12)");
  });

  it("breaks a tie between equally ranked uncoloured roles with the first held", () => {
    const roles = [
      role(1, "Admin", { position: 40, hoist: false }),
      role(2, "Owner", { position: 40, hoist: false }),
    ];
    const members = mapOf([member(1, { role: "admin", roleIds: [1, 2] })]);
    expect(colourOf(members, roles, 1)).toBe("var(--role-admin, #f39c12)");
  });

  it("uses the first role's colour when two roles share a name", () => {
    const roles = [role(1, "Mod", { color: "#111111" }), role(2, "mod", { color: "#222222" })];
    const members = mapOf([member(1, { role: "mod" })]);
    expect(colourOf(members, roles, 1)).toBe("#111111");
  });

  it("renders one group for two roles that share a name", () => {
    const roles = [role(1, "Mod"), role(2, "mod")];
    const members = mapOf([member(1, { role: "mod" })]);
    expect(buildItems(members, roles, "").map((i) => i.key)).toEqual(["g:mod", "u:1"]);
  });

  it("sorts the Online group by name", () => {
    const roles = [role(1, "Crew", { hoist: false })];
    const members = mapOf([
      member(1, { username: "carol", role: "crew", roleIds: [1] }),
      member(2, { username: "alice", role: "crew", roleIds: [1] }),
      member(3, { username: "bob", role: "crew", roleIds: [1] }),
    ]);
    expect(buildItems(members, roles, "").map((i) => i.key)).toEqual([
      "online",
      "u:2",
      "u:3",
      "u:1",
    ]);
  });
});

describe("memberModel incremental update bounds", () => {
  const SIZE = 2000;
  const sameGroup = (): Map<number, Member> =>
    mapOf(
      Array.from({ length: SIZE }, (_, i) =>
        member(i + 1, { username: `n${String(i).padStart(5, "0")}` }),
      ),
    );

  it.each([
    ["64 changed members are repositioned one by one", MAX_DELTA, true],
    ["65 changed members rebuild the groups", MAX_DELTA + 1, false],
  ])("%s", (_label, count, incremental) => {
    const members = sameGroup();
    const counter = countingCompare();
    const model = buildModel(members, ROLES, counter.compare);
    const next = new Map(members);
    for (let id = 1; id <= count; id++) next.set(id, { ...members.get(id)!, avatar: "a.png" });
    const before = counter.calls();
    const updated = updateModel(model, next, ROLES, counter.compare);
    const used = counter.calls() - before;
    // Sorting 2,000 entries, even already in order, takes n-1 comparisons; a delta takes ~2·log2(n) each.
    if (incremental) expect(used).toBeLessThan(SIZE - 200);
    else expect(used).toBeGreaterThanOrEqual(SIZE - 1);
    expect(flattenModel(updated, "")).toEqual(buildItems(next, ROLES, ""));
  });

  it.each([
    ["64 removed members are spliced out one by one", MAX_DELTA, true],
    ["65 removed members rebuild the groups", MAX_DELTA + 1, false],
  ])("%s", (_label, count, incremental) => {
    const members = sameGroup();
    const counter = countingCompare();
    const model = buildModel(members, ROLES, counter.compare);
    const next = new Map(members);
    for (let id = 1; id <= count; id++) next.delete(id);
    const before = counter.calls();
    const updated = updateModel(model, next, ROLES, counter.compare);
    const used = counter.calls() - before;
    if (incremental) expect(used).toBeLessThan(SIZE - 200);
    else expect(used).toBeGreaterThanOrEqual(SIZE - count - 1);
    expect(flattenModel(updated, "")).toEqual(buildItems(next, ROLES, ""));
  });

  it("a single removed member is not enough to rebuild", () => {
    const members = sameGroup();
    const counter = countingCompare();
    const model = buildModel(members, ROLES, counter.compare);
    const next = new Map(members);
    next.delete(1000);
    const before = counter.calls();
    updateModel(model, next, ROLES, counter.compare);
    expect(counter.calls() - before).toBeLessThan(40);
  });

  it("finds a member among equally ordered ones when it moves to another group", () => {
    // Everyone compares equal, so the binary search lands on the first of them.
    const tie: (a: Entry, b: Entry) => number = () => 0;
    const members = mapOf([member(1), member(2), member(3)]);
    const model = buildModel(members, ROLES, tie);
    const next = new Map(members);
    next.set(3, { ...members.get(3)!, status: "offline" });
    const updated = updateModel(model, next, ROLES, tie);
    expect(flattenModel(updated, "").map((i) => i.key)).toEqual([
      "g:member",
      "u:1",
      "u:2",
      "offline",
      "u:3",
    ]);
  });
});
