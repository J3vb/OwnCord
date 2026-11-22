/**
 * The member list's row renderer: what a row is made of, apart from the list
 * that places, focuses and virtualises it. The list takes one through
 * `MemberListOptions.rows`; Classic's is the default.
 */
import type { ModelRowOptions } from "@lib/net/reconcile";
import { createAvatarElement } from "../profiles/avatar";
import type { ListItem } from "./memberModel";
import { ESTIMATED_HEIGHTS, itemModel, kindOf, kindOfModel } from "./memberListModel";
import {
  MEMBER_PATCH_FIELDS,
  drawMemberItem,
  patchMemberItem,
  type MemberItemModel,
} from "./memberRow.view";

export interface MemberRowRenderer {
  /** One list item as the plain data its row draws. */
  readonly model: (item: ListItem) => MemberItemModel;
  /** Draws a row model with no handlers. A row model's element must carry class
   *  "member-item", data-testid "member-<id>", role="button", tabindex="0" and an
   *  accessible name. */
  readonly draw: (model: MemberItemModel) => HTMLElement;
  readonly patch: NonNullable<ModelRowOptions<ListItem, MemberItemModel>["patch"]>;
  /** Height kind of a list item and of a drawn model. They must agree. */
  readonly itemKind: (item: ListItem) => number;
  readonly modelKind: (model: MemberItemModel) => number;
  readonly estimatedHeights: readonly number[];
}

export const classicMemberRows = {
  model: itemModel,
  draw: (model) => drawMemberItem(model, createAvatarElement),
  patch: { fields: MEMBER_PATCH_FIELDS, apply: patchMemberItem },
  itemKind: kindOf,
  modelKind: kindOfModel,
  estimatedHeights: ESTIMATED_HEIGHTS,
} satisfies MemberRowRenderer;
