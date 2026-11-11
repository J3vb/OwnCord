/**
 * MemberList helpers that touch no DOM: the virtual-list sizing constants,
 * row height kinds, the model memo and the plain-data model a row draws.
 */

import { isImeCommit } from "@lib/text/ime";
import { createElement } from "@lib/dom";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { resolveDisplayName } from "@lib/ui/avatar";
import { memberDisplayName, type Member } from "@stores/members.store";
import type { ReadyRole } from "@lib/types";
import { pickAvatarColor } from "../profiles/avatar";
import { shellText } from "../../i18n/shell";
import { rowActivity } from "./listeningLine";
import type { MemberItemModel } from "./memberRow.view";
import {
  buildModel,
  isAwayStatus,
  updateModel,
  type ListItem,
  type MemberModel,
} from "./memberModel";

/**
 * Closers for the profile popups this list opened. destroy() runs only these:
 * each is a no-op once another opener replaced its popup, so a card MessageList
 * opened stays up when the sidebar switches away from the member list.
 */
export const ownPopupClosers = new Set<() => void>();

/**
 * Above this many members the list draws only the rows in view. At or below it
 * every row is in the DOM, which keeps native find and screen-reader browse
 * mode complete on small servers. Tests over this size must reach a row by
 * search or by keyboard, never by assuming every testid is rendered.
 */
export const VIRTUAL_ABOVE = 200;

/** Items drawn beyond each edge of the viewport. */
export const OVERSCAN = 10;

const HEADER = 0;
const ROW = 1;
const ROW_STATUS = 2;
const EMPTY = 3;

/** Starting heights per kind (margins included), until a rendered row is measured. */
export const ESTIMATED_HEIGHTS: readonly number[] = [35, 42, 42, 80];

/** The height kind of a list item. */
export function kindOf(item: ListItem): number {
  if (item.kind === "header") return HEADER;
  if (item.kind === "empty") return EMPTY;
  const custom = item.member.customStatus;
  const hasLine =
    (typeof custom === "string" && custom.length > 0) ||
    item.member.activity != null ||
    item.member.listening != null;
  return hasLine ? ROW_STATUS : ROW;
}

/** `kindOf` for a drawn child: the same height kind, read from its model. */
export function kindOfModel(model: MemberItemModel): number {
  if (model.kind === "header") return HEADER;
  if (model.kind === "empty") return EMPTY;
  return model.customStatus === null && model.activity === null ? ROW : ROW_STATUS;
}

/** The last model the virtual list built, so a reopened column resumes from it
 *  instead of sorting again. Model only: it holds no DOM. */
let modelMemo: MemberModel | null = null;

// app-lifetime: registered once at load; the memo itself is dropped with the session.
void registerSessionReset(
  "members:model-memo",
  () => {
    modelMemo = null;
  },
  { phase: "cache" },
);

/** The model for the roster, taken from the memo when there is one. */
export function memberModelFor(
  members: ReadonlyMap<number, Member>,
  roles: readonly ReadyRole[],
): MemberModel {
  modelMemo =
    modelMemo === null ? buildModel(members, roles) : updateModel(modelMemo, members, roles);
  return modelMemo;
}

/** Whether a model is memoised. For tests. */
export function hasMemberModelMemo(): boolean {
  return modelMemo !== null;
}

/** The member a row draws, resolved into plain data for `reconcileModels`. */
export function itemModel(item: ListItem): MemberItemModel {
  if (item.kind === "header") return { kind: "header", text: item.text, offline: item.offline };
  if (item.kind === "empty") return { kind: "empty", text: item.text };
  const { member } = item;
  const custom = member.customStatus;
  const customStatus = typeof custom === "string" && custom.length > 0 ? custom : null;
  // The custom status wins the line, then a game, then music; the full card
  // shows in the profile.
  const shown = customStatus === null ? rowActivity(member.activity, member.listening) : null;
  return {
    kind: "row",
    id: member.id,
    name: memberDisplayName(member),
    avatarName: resolveDisplayName({ username: member.username, displayName: member.displayName }),
    avatarColor: pickAvatarColor(member.username),
    avatarUrl: member.avatar,
    customStatus,
    activity: shown === null ? null : shown.text,
    activityIcon: shown === null ? "gamepad-2" : shown.icon,
    colorVar: item.colorVar,
    status: member.status,
    mobile: member.mobile === true,
    away: isAwayStatus(member.status),
  };
}

/** Rows that fit in the scroller, at least one: the PageUp/PageDown stride. */
function pageSize(from: HTMLElement): number {
  let scroller = from.parentElement;
  while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement;
  }
  const rowHeight = from.offsetHeight;
  if (scroller === null || rowHeight <= 0) return 10;
  return Math.max(1, Math.floor(scroller.clientHeight / rowHeight));
}

/** Re-measure each kind from the rows in the DOM, writing into `heights`;
 *  true when a height changed. The larger measurement within a kind wins, so a
 *  taller glyph fallback leaves a gap and never an overlap. */
export function measureKindHeights(
  root: HTMLElement,
  kindByEl: WeakMap<Element, number>,
  heights: number[],
): boolean {
  const seen = [0, 0, 0, 0];
  const margins = [0, 0, 0, 0];
  for (const child of root.children) {
    const kind = kindByEl.get(child);
    if (kind === undefined) continue;
    const height = child.getBoundingClientRect().height;
    if (!(height > 0)) continue;
    if (seen[kind] === 0) {
      const style = getComputedStyle(child);
      margins[kind] = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }
    seen[kind] = Math.max(seen[kind]!, height);
  }
  let changed = false;
  for (let kind = 0; kind < heights.length; kind++) {
    if (seen[kind] === 0) continue;
    const total = seen[kind]! + margins[kind]!;
    if (Math.abs(total - heights[kind]!) < 0.01) continue;
    heights[kind] = total;
    changed = true;
  }
  return changed;
}

/** The search box above the list. `onQuery` gets the text after each edit and
 *  after Escape clears it. */
export function createMemberSearchInput(
  signal: AbortSignal,
  onQuery: (query: string) => void,
): HTMLInputElement {
  const label = shellText("members.search");
  const search = createElement("input", {
    type: "search",
    class: "dm-search member-search",
    "data-testid": "member-search",
    maxlength: "100",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: label,
    "aria-label": label,
  });
  search.addEventListener("input", () => onQuery(search.value), { signal });
  search.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || isImeCommit(e) || search.value === "") return;
      e.preventDefault();
      e.stopPropagation();
      search.value = "";
      onQuery("");
    },
    { signal },
  );
  return search;
}

/** The row index a navigation key moves to, from row `at` of rows 0..`last`.
 *  `from` is the focused row, whose scroller sets the page stride. */
export function navigationTarget(key: string, at: number, last: number, from: HTMLElement): number {
  switch (key) {
    case "ArrowDown":
      return Math.min(last, at + 1);
    case "ArrowUp":
      return Math.max(0, at - 1);
    case "PageDown":
      return Math.min(last, at + pageSize(from));
    case "PageUp":
      return Math.max(0, at - pageSize(from));
    case "Home":
      return 0;
    default:
      return last;
  }
}
