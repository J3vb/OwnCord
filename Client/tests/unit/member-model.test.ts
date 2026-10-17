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
