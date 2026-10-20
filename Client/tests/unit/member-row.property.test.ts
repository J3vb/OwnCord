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
  type MemberRowModel,
} from "../../src/components/member-list/memberRow.view";
import { pickAvatarColor } from "../../src/components/message-list/avatar";
import { assertEveryFieldDraws } from "../helpers/rowModelProperty";
import type { UserStatus } from "../../src/lib/types";

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
    avatarUser: text,
    avatarDisplayName: fc.option(text, { nil: null }),
    avatarUrl: fc.option(
      text.map((t) => `/api/v1/files/${t}`),
      { nil: null },
    ),
    customStatus: fc.option(text, { nil: null }),
    colorVar: fc.constantFrom("var(--green)", "#ff0000", "#3366cc", "var(--text-micro)"),
    status: fc.constantFrom(...STATUSES),
    away: fc.boolean(),
  })
  // With a picture loaded the letter and its colour are gone and the alt text
  // is the display name, so the username is drawn only through the alt fallback.
  .map((r) => ({
    kind: "row" as const,
    ...r,
    avatarUrl: r.avatarDisplayName === null ? r.avatarUrl : null,
  }));

function otherLetter(model: MemberRowModel): string {
  const shown = (model.avatarDisplayName ?? model.avatarUser).charAt(0).toUpperCase();
  return shown === "Q" ? "R" : "Q";
}

function mutateRow(model: MemberRowModel, field: string): MemberRowModel {
  switch (field) {
    case "id":
      return { ...model, id: model.id + 1 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "avatarUser": {
      // Without a nickname the username sets the letter and alt text; with one
      // it shows only through the letter's colour, so the colour must differ.
      for (let i = 0; ; i++) {
        const avatarUser = `${otherLetter(model)}${i}`;
        const sameColor = pickAvatarColor(avatarUser) === pickAvatarColor(model.avatarUser);
        if (model.avatarDisplayName === null || !sameColor) return { ...model, avatarUser };
      }
    }
    case "avatarDisplayName":
      return {
        ...model,
        avatarDisplayName:
          model.avatarDisplayName === null ? otherLetter(model) : `${otherLetter(model)}z`,
      };
    case "avatarUrl":
      return {
        ...model,
        avatarUrl: model.avatarUrl === null ? "/api/v1/files/p" : `${model.avatarUrl}x`,
      };
    case "customStatus":
      return { ...model, customStatus: model.customStatus === null ? "hi" : null };
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
    await assertEveryFieldDraws(rowModel, drawMemberItem, mutateRow, {
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
      drawMemberItem,
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
    await assertEveryFieldDraws(empty, drawMemberItem, (m) => ({ ...m, text: `${m.text}x` }), {
      bindingOnly: { kind: "discriminant" },
    });
  });

  it("the patch fields are exactly the ones patchMemberItem handles", () => {
    expect([...MEMBER_PATCH_FIELDS].sort()).toEqual(["away", "status", "text"]);
  });
});
