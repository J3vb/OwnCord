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
vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
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
import { createAvatarElement } from "../../src/features/profiles/avatar";
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

describe("member row view markup", () => {
  const base: MemberRowModel = {
    kind: "row",
    id: 7,
    name: "Ada",
    avatarName: "Ada",
    avatarColor: "#5865f2",
    avatarUrl: null,
    customStatus: null,
    activity: null,
    activityIcon: "gamepad-2",
    colorVar: "#ff0000",
    status: "online",
    away: false,
  };

  it("maps each status to its dot colour, and an unknown one to the muted colour", () => {
    expect(statusColor("online")).toBe("var(--green)");
    expect(statusColor("idle")).toBe("var(--yellow)");
    expect(statusColor("dnd")).toBe("var(--red)");
    expect(statusColor("invisible")).toBe("var(--text-micro)");
    expect(statusColor("offline")).toBe("var(--text-micro)");
    expect(statusColor("brb" as UserStatus)).toBe("var(--text-micro)");
  });

  it("draws a focusable button that opens a dialog and is named after the member", () => {
    const row = draw(base);
    expect(row.classList.contains("member-item")).toBe(true);
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row.getAttribute("aria-label")).toBe("Ada");
    expect(row.getAttribute("data-testid")).toBe("member-7");
    expect(row.getAttribute("aria-describedby")).toBe("mi-status-7");
    expect(row.querySelector(".mi-text .mi-name")?.textContent).toBe("Ada");
    expect(row.querySelector(".mi-custom-status")).toBeNull();
    expect(row.querySelector(".mi-activity")).toBeNull();
  });

  it("dims an away member and draws the status dot in its colour", () => {
    const row = draw({ ...base, away: true, status: "idle" });
    expect(row.classList.contains("offline")).toBe(true);
    const dot = row.querySelector<HTMLElement>(".mi-status");
    expect(dot?.style.background).toBe("var(--yellow)");
    expect(dot?.getAttribute("aria-label")).toBe(dot?.title);
    expect(dot?.id).toBe("mi-status-7");
  });

  it("draws a custom status under the name and describes the row by it", () => {
    const row = draw({ ...base, customStatus: "Out for lunch", activity: null });
    const custom = row.querySelector<HTMLElement>(".mi-text > .mi-custom-status");
    expect(custom?.textContent).toBe("Out for lunch");
    expect(custom?.getAttribute("data-testid")).toBe("member-custom-status-7");
    expect(custom?.id).toBe("mi-custom-status-7");
    expect(row.getAttribute("aria-describedby")).toBe("mi-custom-status-7 mi-status-7");
  });

  it("draws an activity line with a decorative icon and describes the row by it", () => {
    const row = draw({ ...base, activity: "Playing Chess", activityIcon: "music" });
    const activity = row.querySelector<HTMLElement>(".mi-text > .mi-activity");
    expect(activity).not.toBeNull();
    expect(activity?.getAttribute("data-testid")).toBe("member-activity-7");
    expect(activity?.id).toBe("mi-activity-7");
    const icon = activity?.querySelector(".mi-activity-icon");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(activity?.querySelector("span.mi-activity-text")?.textContent).toBe("Playing Chess");
    expect(row.getAttribute("aria-describedby")).toBe("mi-activity-7 mi-status-7");
  });

  it("draws the header and the empty state with their classes", () => {
    const header = draw({ kind: "header", text: "ADMIN — 1", offline: false });
    expect(header.className).toBe("member-role-group");
    expect(header.hasAttribute("data-testid")).toBe(false);
    const offline = draw({ kind: "header", text: "OFFLINE — 1", offline: true });
    expect(offline.getAttribute("data-testid")).toBe("member-group-offline");
    const empty = draw({ kind: "empty", text: "Nobody" });
    expect(empty.className).toBe("member-list-empty");
    expect(empty.querySelector("p.member-list-empty-text")?.textContent).toBe("Nobody");
  });
});

describe("member row view patching", () => {
  it("leaves a header's text node alone when the text is unchanged", () => {
    const header = draw({ kind: "header", text: "ADMIN — 1", offline: false });
    const node = header.firstChild;
    patchMemberItem(header, { kind: "header", text: "ADMIN — 1", offline: false });
    expect(header.firstChild).toBe(node);
    patchMemberItem(header, { kind: "header", text: "ADMIN — 2", offline: false });
    expect(header.textContent).toBe("ADMIN — 2");
  });

  it("leaves the empty state's text node alone when the text is unchanged", () => {
    const empty = draw({ kind: "empty", text: "Nobody" });
    const text = empty.querySelector(".member-list-empty-text")!;
    const node = text.firstChild;
    patchMemberItem(empty, { kind: "empty", text: "Nobody" });
    expect(text.firstChild).toBe(node);
    patchMemberItem(empty, { kind: "empty", text: "Still nobody" });
    expect(text.textContent).toBe("Still nobody");
  });
});
