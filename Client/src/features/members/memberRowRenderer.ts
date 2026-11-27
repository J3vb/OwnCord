/**
 * The member list's row renderer: what a row is made of, apart from the list
 * that places, focuses and virtualises it. The list takes one through
 * `MemberListOptions.rows`, or bound to its row context through
 * `MemberListOptions.view`; Classic's is the default.
 */
import type { ModelRowOptions, RowModel } from "@lib/net/reconcile";
import { createAvatarElement } from "../profiles/avatar";
import type { ListItem } from "./memberModel";
import { ESTIMATED_HEIGHTS, itemModel, kindOf, kindOfModel } from "./memberListModel";
import {
  MEMBER_PATCH_FIELDS,
  drawMemberItem,
  patchMemberItem,
  type MemberItemModel,
} from "./memberRow.view";

/** What every renderer's model has in common: the list reads `kind`, and a
 *  row's `id`. */
export type MemberRowModelBase = RowModel &
  (
    | { readonly kind: "row"; readonly id: number }
    | { readonly kind: "header" }
    | { readonly kind: "empty" }
  );

export interface MemberRowRenderer<M extends MemberRowModelBase = MemberItemModel, C = void> {
  /** One list item as the plain data its row draws, given the row context. */
  readonly model: (item: ListItem, ctx: C) => M;
  /** Draws a row model with no handlers. A row model's element must carry class
   *  "member-item", data-testid "member-<id>", role="button", tabindex="0" and an
   *  accessible name. */
  readonly draw: (model: M) => HTMLElement;
  readonly patch: NonNullable<ModelRowOptions<ListItem, M>["patch"]>;
  /** Height kind of a list item and of a drawn model. They must agree. */
  readonly itemKind: (item: ListItem) => number;
  readonly modelKind: (model: M) => number;
  readonly estimatedHeights: readonly number[];
}

/** State a row model needs that is not on the member. The source owns its
 *  subscriptions, decides when the context changed, and `read()` returns a
 *  cached object. */
export interface RowContextSource<C> {
  read(): C;
  subscribe(signal: AbortSignal, onChange: () => void): void;
}

/** A renderer and its context, with their types hidden from the list. */
export interface MemberRows {
  use<R>(run: <M extends MemberRowModelBase, C>(rows: MemberRowRenderer<M, C>, ctx: C) => R): R;
  subscribe(signal: AbortSignal, onChange: () => void): void;
}

export function memberRows<M extends MemberRowModelBase, C>(
  rows: MemberRowRenderer<M, C>,
  source: RowContextSource<C>,
): MemberRows {
  return {
    use: (run) => run(rows, source.read()),
    subscribe: (signal, onChange) => source.subscribe(signal, onChange),
  };
}

export const classicMemberRows = {
  model: itemModel,
  draw: (model) => drawMemberItem(model, createAvatarElement),
  patch: { fields: MEMBER_PATCH_FIELDS, apply: patchMemberItem },
  itemKind: kindOf,
  modelKind: kindOfModel,
  estimatedHeights: ESTIMATED_HEIGHTS,
} satisfies MemberRowRenderer;

/** No context, and it never changes. */
const NO_CONTEXT: RowContextSource<void> = {
  read: () => undefined,
  subscribe: () => undefined,
};

/** A renderer that needs no row context, bound to a source that never fires. */
export function classicView(rows: MemberRowRenderer = classicMemberRows): MemberRows {
  return memberRows(rows, NO_CONTEXT);
}
