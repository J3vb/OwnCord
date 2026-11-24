/**
 * Property tests for Buddies' renderer and grouping.
 *  - every model field changes the drawn row, and a row patched to a model
 *    draws exactly like that model drawn fresh;
 *  - for random flips of status, game, song, role and display name, the
 *    groups built from the incrementally updated role model equal the groups
 *    built from scratch.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  assertEveryFieldDraws,
  dataUriAvatarFetchMock,
  mutateAvatarField,
  settleAvatar as settle,
} from "../../helpers/rowModelProperty";

vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  dataUriAvatarFetchMock(importOriginal),
);

import {
  buddiesRows,
  type BuddyItemModel,
} from "../../../src/features/members/buddies/buddiesRenderer";
import { activityItems } from "../../../src/features/members/buddies/activityGroups";
import { buildModel, updateModel, type ListItem } from "../../../src/features/members/memberModel";
import type { Member } from "@stores/members.store";
import type { ReadyRole, UserStatus } from "../../../src/lib/types";
import { showsPhone, statusColor } from "../../../src/lib/ui/statusIndicator";
import { makeMember } from "../../helpers/memberListHarness";

type RowModel = Extract<BuddyItemModel, { kind: "row" }>;
type HeaderModel = Extract<BuddyItemModel, { kind: "header" }>;

const STATUSES: readonly UserStatus[] = ["online", "idle", "dnd", "invisible", "offline"];
const text = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
const draw = (model: BuddyItemModel): HTMLElement => buddiesRows.draw(model);
const NONE: ReadonlySet<string> = new Set();

const rowModel: fc.Arbitrary<RowModel> = fc
  .record({
    id: fc.integer({ min: 1, max: 100000 }),
    name: text,
    avatarName: text,
    avatarColor: fc.constantFrom("#5865f2", "#3ba55c"),
    colorVar: fc.constantFrom("var(--green)", "#ff0000", "#3366cc"),
    status: fc.constantFrom(...STATUSES),
    mobile: fc.boolean(),
    dimmed: fc.boolean(),
    line: fc.option(
      fc.record({
        kind: fc.constantFrom("game" as const, "song" as const, "status" as const),
        text,
      }),
      { nil: null },
    ),
    room: fc.option(text, { nil: null }),
  })
  .map((r) => ({ kind: "row" as const, ...r, avatarUrl: null }));

function mutateRow(model: RowModel, field: string): RowModel {
  const avatar = mutateAvatarField(model, field);
  if (avatar !== undefined) return avatar;
  switch (field) {
    case "id":
      return { ...model, id: model.id + 1 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "colorVar":
      return { ...model, colorVar: model.colorVar === "#ff0000" ? "#00ff00" : "#ff0000" };
    case "status":
      // A status whose dot looks different.
      return {
        ...model,
        status: STATUSES.filter((s) => statusColor(s) !== statusColor(model.status))[0]!,
      };
    case "mobile": {
      // Only a status that can be on the phone draws the phone.
      const status = showsPhone(model.status, true) ? model.status : "online";
      return { ...model, status, mobile: !model.mobile };
    }
    case "dimmed":
      return { ...model, dimmed: !model.dimmed };
    case "line":
      return { ...model, line: model.line === null ? { kind: "status", text: "x" } : null };
    case "room":
      return { ...model, room: model.room === null ? "Lounge" : `${model.room}x` };
    default:
      throw new Error(`no mutation for ${field}`);
  }
}

describe("buddies rows: every field draws", () => {
  it("every row model field changes the row, and a patch equals a fresh draw", async () => {
    await assertEveryFieldDraws(rowModel, draw, mutateRow, {
      patch: { fields: ["status", "mobile", "dimmed", "room"], apply: buddiesRows.patch.apply },
      bindingOnly: { kind: "discriminant: a different kind is a different model type" },
      settle,
    });
  });

  it("each line kind draws differently", () => {
    const base = fc.sample(rowModel, 1)[0]!;
    const drawn = (["game", "song", "status"] as const).map(
      (kind) => draw({ ...base, line: { kind, text: "x" } }).outerHTML,
    );
    expect(new Set(drawn).size).toBe(3);
  });

  it("a header's text draws and patches; its fold fields are not drawn yet", async () => {
    const header: fc.Arbitrary<HeaderModel> = fc
      .record({ text, group: fc.constantFrom("a:game", "a:online", "a:offline") })
      .map(({ text: t, group }) =>
        buddiesRows.model(
          {
            kind: "header",
            key: group,
            text: t,
            offline: false,
            collapsible: false,
            collapsed: false,
          },
          { rooms: new Map() },
        ),
      )
      .filter((m): m is HeaderModel => m.kind === "header");
    await assertEveryFieldDraws(
      header,
      draw,
      (m, field) => {
        if (field === "text") return { ...m, text: `${m.text}x` };
        if (field === "group") return { ...m, group: m.group === "a:game" ? "a:dnd" : "a:game" };
        if (field === "collapsible") return { ...m, collapsible: !m.collapsible };
        return { ...m, collapsed: !m.collapsed };
      },
      {
        patch: { fields: ["text", "collapsed"], apply: buddiesRows.patch.apply },
        bindingOnly: {
          kind: "discriminant",
          collapsible: "groups do not fold yet: always false",
          collapsed: "groups do not fold yet: always false",
        },
      },
    );
  });
});

/** One change to one member. */
type Flip =
  | { readonly id: number; readonly field: "status"; readonly status: UserStatus }
  | { readonly id: number; readonly field: "game" | "song" | "role" | "name" };

const ROLES: readonly ReadyRole[] = [
  { id: 10, name: "Mods", color: "#ff0000", permissions: 0, position: 3, hoist: true },
  { id: 11, name: "Crew", color: null, permissions: 0, position: 2, hoist: false },
];

function flipped(member: Member, flip: Flip): Member {
  switch (flip.field) {
    case "status":
      return { ...member, status: flip.status };
    case "game":
      return { ...member, activity: member.activity ? null : { name: "G", startedAt: 1 } };
    case "song":
      return {
        ...member,
        listening: member.listening
          ? null
          : { title: "S", artist: "", player: "P", startedAt: 1, durationMs: 0 },
      };
    case "role":
      return { ...member, roleIds: member.roleIds?.[0] === 10 ? [11] : [10] };
    default:
      return { ...member, displayName: member.displayName ? null : `Z${member.id}` };
  }
}

const flip: fc.Arbitrary<Flip> = fc.oneof(
  fc.record({
    id: fc.integer({ min: 1, max: 12 }),
    field: fc.constant("status" as const),
    status: fc.constantFrom(...STATUSES),
  }),
  fc.record({
    id: fc.integer({ min: 1, max: 12 }),
    field: fc.constantFrom("game" as const, "song" as const, "role" as const, "name" as const),
  }),
);

describe("activityItems over an updated role model", () => {
  it("equals the groups of a fresh build after random flips", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(flip, { minLength: 1, maxLength: 4 }), { maxLength: 8 }),
        (steps) => {
          let members = new Map<number, Member>(
            Array.from({ length: 12 }, (_, i) => [
              i + 1,
              makeMember({ id: i + 1, username: `u${(i * 7) % 12}`, roleIds: [11] }),
            ]),
          );
          let model = buildModel(members, ROLES);
          for (const batch of steps) {
            const next = new Map(members);
            for (const f of batch) next.set(f.id, flipped(next.get(f.id)!, f));
            members = next;
            model = updateModel(model, members, ROLES);
            const items: ListItem[] = activityItems(model, "", NONE);
            expect(items).toEqual(activityItems(buildModel(members, ROLES), "", NONE));
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
