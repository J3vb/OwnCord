/**
 * Property tests for the text channel row view (channelRow.view.ts).
 *
 * `reconcileModels` derives a row's signature from its model, so the model is
 * only honest if every drawn field changes the DOM the view draws. The two
 * fields the row binds handlers from, not draws (`orderIds`, `access`), are
 * named in `bindingOnly` with the reason.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  drawTextChannelRow,
  type ChannelAccess,
  type TextChannelRowModel,
} from "../../src/features/channels/channelRow.view";
import { assertEveryFieldDraws } from "../helpers/rowModelProperty";

const text = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);

const access: fc.Arbitrary<ChannelAccess> = fc.record({
  manageChannels: fc.boolean(),
  manageMessages: fc.boolean(),
  manageInvites: fc.boolean(),
});

const rowModel: fc.Arbitrary<TextChannelRowModel> = fc.record({
  kind: fc.constantFrom("text", "announcement"),
  channelId: fc.integer({ min: 1, max: 100000 }),
  name: text,
  nsfw: fc.boolean(),
  private: fc.boolean(),
  active: fc.boolean(),
  unread: fc.boolean(),
  mentionCount: fc.integer({ min: 0, max: 99 }),
  muted: fc.boolean(),
  draggable: fc.boolean(),
  orderIds: fc.array(fc.integer({ min: 1, max: 99 }), { maxLength: 5 }).map((ids) => ids.join(",")),
  access,
});

function mutate(model: TextChannelRowModel, field: string): TextChannelRowModel {
  switch (field) {
    case "kind":
      return { ...model, kind: model.kind === "text" ? "announcement" : "text" };
    case "channelId":
      return { ...model, channelId: model.channelId + 1 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "nsfw":
      return { ...model, nsfw: !model.nsfw };
    case "private":
      return { ...model, private: !model.private };
    case "active":
      return { ...model, active: !model.active };
    case "unread":
      return { ...model, unread: !model.unread };
    case "mentionCount":
      return { ...model, mentionCount: model.mentionCount + 1 };
    case "muted":
      return { ...model, muted: !model.muted };
    case "draggable":
      return { ...model, draggable: !model.draggable };
    case "orderIds":
      return { ...model, orderIds: `${model.orderIds},0` };
    case "access":
      return {
        ...model,
        access: { ...model.access, manageMessages: !model.access.manageMessages },
      };
    default:
      throw new Error(`no mutation for ${field}`);
  }
}

describe("text channel row view", () => {
  it("every drawn model field changes the row's DOM", async () => {
    await assertEveryFieldDraws(rowModel, drawTextChannelRow, mutate, {
      bindingOnly: {
        orderIds:
          "the drag and Move Up/Down handlers capture the group's order at bind time; a reorder must rebind",
        access:
          "the context menu decides Edit, Delete, Move, Purge and Invite at bind time; a role or mask change must rebind (OC-0142)",
      },
    });
  });

  it("draws no tabindex but the roving -1, which the navigation owns", () => {
    fc.assert(
      fc.property(rowModel, (model) => {
        const row = drawTextChannelRow(model);
        expect(row.getAttribute("tabindex")).toBe("-1");
        expect(row.querySelectorAll("[tabindex]")).toHaveLength(0);
      }),
    );
  });

  it("the binding-only fields leave the DOM unchanged", () => {
    fc.assert(
      fc.property(rowModel, (model) => {
        const html = drawTextChannelRow(model).outerHTML;
        expect(drawTextChannelRow(mutate(model, "orderIds")).outerHTML).toBe(html);
        expect(drawTextChannelRow(mutate(model, "access")).outerHTML).toBe(html);
      }),
    );
  });

  it("draws the row exactly as the sidebar always has, attribute for attribute", () => {
    const row = drawTextChannelRow({
      kind: "announcement",
      channelId: 7,
      name: "news",
      nsfw: true,
      private: true,
      active: true,
      unread: true,
      mentionCount: 3,
      muted: true,
      draggable: true,
      orderIds: "7,8",
      access: { manageChannels: true, manageMessages: false, manageInvites: false },
    });
    expect(Array.from(row.attributes).map((a) => a.name)).toEqual([
      "class",
      "data-testid",
      "role",
      "tabindex",
      "data-channel-id",
      "aria-current",
      "data-drag-channel-id",
    ]);
    expect(row.className).toBe("channel-item active unread mentioned muted channel-draggable");
    expect(Array.from(row.children).map((c) => c.className)).toEqual([
      "ch-icon",
      "ch-name",
      "ch-nsfw",
      "ch-lock",
      "mention-badge",
    ]);
  });
});
