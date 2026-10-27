/**
 * Property tests for the member-list row view (memberRow.view.ts).
 *
 * `reconcileModels` derives a row's signature from its model, so the model is
 * only honest if every field changes the DOM the view draws, and a row patched
 * in place equals one drawn fresh:
 *  - changing any one model field changes the row's outerHTML
 *  - patchMemberItem(drawMemberItem(a), b) renders exactly like drawMemberItem(b)
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

// The avatar image is behind the session token; stub the authenticated fetch
// with a URL-derived data URI so a changed avatarUrl shows in the DOM.
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return {
    ...actual,
    fetchImageAsObjectUrl: vi.fn((url: string) =>
      Promise.resolve(`data:,${encodeURIComponent(url)}`),
    ),
  };
});

import {
  MEMBER_PATCH_FIELDS,
  drawMemberItem,
  patchMemberItem,
  statusColor,
  type MemberEmptyModel,
  type MemberHeaderModel,
  type MemberItemModel,
  type MemberRowModel,
} from "../../src/features/members/memberRow.view";
import { createAvatarElement } from "../../src/components/message-list/avatar";
import { assertEveryFieldDraws } from "../helpers/rowModelProperty";
import type { UserStatus } from "../../src/lib/types";

const draw = (model: MemberItemModel): HTMLElement => drawMemberItem(model, createAvatarElement);

const STATUSES: readonly UserStatus[] = ["online", "idle", "dnd", "invisible", "offline"];

/** A flush long enough for the avatar's microtask fetch and its image swap. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

const text = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);

const rowModel: fc.Arbitrary<MemberRowModel> = fc
  .record({
    id: fc.integer({ min: 1, max: 100000 }),
    name: text,
    avatarName: text,
    avatarColor: fc.constantFrom("#5865f2", "#3ba55c", "#faa61a"),
    customStatus: fc.option(text, { nil: null }),
    activity: fc.option(text, { nil: null }),
    activityIcon: fc.constantFrom("gamepad-2" as const, "music" as const),
    colorVar: fc.constantFrom("var(--green)", "#ff0000", "#3366cc", "var(--text-micro)"),
    status: fc.constantFrom(...STATUSES),
    away: fc.boolean(),
  })
  // The list builder never sets both: a custom status wins the second line.
  .map((r) => (r.customStatus === null ? r : { ...r, activity: null }))
  // A loaded picture hides the letter and its colour, so the base has none
  // and the mutation of avatarUrl adds one.
  .map((r) => ({ kind: "row" as const, ...r, avatarUrl: null }));

function mutateRow(model: MemberRowModel, field: string): MemberRowModel {
  switch (field) {
    case "id":
      return { ...model, id: model.id + 1 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "avatarName":
      return { ...model, avatarName: model.avatarName.toUpperCase().startsWith("Q") ? "R" : "Q" };
    case "avatarColor":
      return { ...model, avatarColor: model.avatarColor === "#123456" ? "#654321" : "#123456" };
    case "avatarUrl":
      return {
        ...model,
        avatarUrl: model.avatarUrl === null ? "/api/v1/files/p" : `${model.avatarUrl}x`,
      };
    case "customStatus":
      return { ...model, customStatus: model.customStatus === null ? "hi" : null };
    case "activity":
      // Clearing the custom status too keeps the model one the builder can make.
      return {
        ...model,
        customStatus: null,
        activity: model.activity === null ? "Playing x" : null,
      };
    case "activityIcon":
      // The icon only draws beside a line, and the line needs no custom status.
      return {
        ...model,
        customStatus: null,
        activity: model.activity ?? "Listening to x",
        activityIcon: model.activityIcon === "music" ? "gamepad-2" : "music",
      };
    case "colorVar":
      return { ...model, colorVar: model.colorVar === "#ff0000" ? "#00ff00" : "#ff0000" };
    case "status": {
      const next = STATUSES.find(
        (s) => s !== model.status && statusColor(s) !== statusColor(model.status),
      );
      return { ...model, status: next ?? "online" };
    }
    case "away":
      return { ...model, away: !model.away };
    default:
      throw new Error(`no mutation for ${field}`);
  }
}

describe("member row view", () => {
  it("every row model field changes the row's DOM", async () => {
    await assertEveryFieldDraws(rowModel, draw, mutateRow, {
      patch: { fields: ["status", "away"], apply: patchMemberItem },
      bindingOnly: { kind: "discriminant: a different kind is a different model type" },
      settle,
    });
  });

  it("every header model field changes the header's DOM", async () => {
    const header: fc.Arbitrary<MemberHeaderModel> = fc.record({
      kind: fc.constant("header" as const),
      text,
      offline: fc.boolean(),
    });
    await assertEveryFieldDraws(
      header,
      draw,
      (m, field) =>
        field === "text" ? { ...m, text: `${m.text}x` } : { ...m, offline: !m.offline },
      {
        patch: { fields: ["text"], apply: patchMemberItem },
        bindingOnly: { kind: "discriminant" },
      },
    );
  });

  it("the empty model's text changes the DOM", async () => {
    const empty: fc.Arbitrary<MemberEmptyModel> = fc.record({
      kind: fc.constant("empty" as const),
      text,
    });
    await assertEveryFieldDraws(empty, draw, (m) => ({ ...m, text: `${m.text}x` }), {
      patch: { fields: ["text"], apply: patchMemberItem },
      bindingOnly: { kind: "discriminant" },
    });
  });

  it("the patch fields are exactly the ones patchMemberItem handles", () => {
    expect([...MEMBER_PATCH_FIELDS].sort()).toEqual(["away", "status", "text"]);
  });
});
