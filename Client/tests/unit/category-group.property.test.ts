/**
 * Property tests for the category group view (channelRow.view.ts). The
 * uncategorized group (`name` null) draws only its container, so the arbitrary
 * here never produces it; `channel-row-model.test.ts` covers that case.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  drawCategoryGroup,
  type CategoryGroupModel,
} from "../../src/features/channels/channelRow.view";
import { assertEveryFieldDraws } from "../helpers/rowModelProperty";

const text = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);

const groupModel: fc.Arbitrary<CategoryGroupModel> = fc.record({
  key: text,
  name: text,
  categoryId: fc.integer({ min: 0, max: 50 }),
  label: text,
  collapsed: fc.boolean(),
  showCreate: fc.boolean(),
  draggable: fc.boolean(),
});

function mutate(model: CategoryGroupModel, field: string): CategoryGroupModel {
  switch (field) {
    case "key":
      return { ...model, key: `${model.key}x` };
    case "categoryId":
      // 0 draws no id; any positive id draws one, so step between the two kinds.
      return { ...model, categoryId: model.categoryId === 0 ? 1 : 0 };
    case "name":
      return { ...model, name: `${model.name}x` };
    case "label":
      return { ...model, label: `${model.label}x` };
    case "collapsed":
      return { ...model, collapsed: !model.collapsed };
    case "showCreate":
      return { ...model, showCreate: !model.showCreate };
    case "draggable":
      return { ...model, draggable: !model.draggable };
    default:
      throw new Error(`no mutation for ${field}`);
  }
}

describe("category group view", () => {
  it("every model field changes the group's DOM", async () => {
    await assertEveryFieldDraws(groupModel, drawCategoryGroup, mutate);
  });

  it("always ends in an empty rows container, and the collapse state shows in the header", () => {
    fc.assert(
      fc.property(groupModel, (model) => {
        const group = drawCategoryGroup(model);
        const container = group.lastElementChild;
        expect(container?.className).toBe("category-channels-container");
        expect(container?.childElementCount).toBe(0);
        const header = group.querySelector(".category");
        expect(header?.classList.contains("collapsed")).toBe(model.collapsed);
        expect(header?.querySelector(".category-arrow")?.getAttribute("aria-expanded")).toBe(
          model.collapsed ? "false" : "true",
        );
        expect(header?.querySelector(".category-add-btn") !== null).toBe(model.showCreate);
      }),
    );
  });
});
