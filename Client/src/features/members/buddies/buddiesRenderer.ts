/**
 * Buddies' rows: Command Deck's member renderer. It only draws: the list owns
 * focus, menus, search and the virtual window. Every row has two lines of a
 * fixed height, so a row that gains or loses a line, the voice icon or the
 * dimmed look keeps its height.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { UserStatus } from "@lib/types";
import { resolveDisplayName } from "@lib/ui/avatar";
import { applyStatusIndicator } from "@lib/ui/statusIndicator";
import { memberDisplayName, type Member } from "@stores/members.store";
import { buddiesText } from "../../../i18n/buddies";
import { createAvatarElement, pickAvatarColor } from "../../profiles/avatar";
import { listeningLine } from "../listeningLine";
import { isAwayStatus, type ListItem } from "../memberModel";
import { drawAvatarWithDot, drawEmptyState, drawMemberName } from "../memberRow.view";
import type { MemberRowRenderer } from "../memberRowRenderer";
import type { BuddyContext } from "./buddyContext";

/** Line 2: the game, the song or the custom status. */
type BuddyLine = { readonly kind: "game" | "song" | "status"; readonly text: string };

type BuddyRowModel = {
  readonly kind: "row";
  readonly id: number;
  readonly name: string;
  readonly avatarName: string;
  readonly avatarColor: string;
  readonly avatarUrl: string | null;
  readonly colorVar: string;
  /** Patch field, with `mobile`, `dimmed` and `room`. */
  readonly status: UserStatus;
  readonly mobile: boolean;
  /** Offline or invisible: the row is dimmed. */
  readonly dimmed: boolean;
  readonly line: BuddyLine | null;
  /** The server voice room's name, or null. */
  readonly room: string | null;
};

type BuddyHeaderModel = {
  readonly kind: "header";
  /** The group's item key. */
  readonly group: string;
  /** Patch field: the count changes without a rebuild. */
  readonly text: string;
  /** A rebuild field: a foldable header is a button, a plain one text. */
  readonly collapsible: boolean;
  /** Patch field: a fold keeps the header element and its focus. */
  readonly collapsed: boolean;
};

type BuddyEmptyModel = { readonly kind: "empty"; readonly text: string };

export type BuddyItemModel = BuddyRowModel | BuddyHeaderModel | BuddyEmptyModel;

const PATCH_FIELDS = ["status", "mobile", "dimmed", "room", "text", "collapsed"] as const;

const HEADER = 0;
const ROW = 1;
const EMPTY = 3;

function nonEmpty(text: string | null | undefined): string | null {
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** Line 2's rules: offline shows only the custom status; otherwise a game
 *  wins, then the custom status, then the song. */
function lineOf(member: Member, dimmed: boolean): BuddyLine | null {
  const custom = nonEmpty(member.customStatus);
  const status: BuddyLine | null = custom === null ? null : { kind: "status", text: custom };
  if (dimmed) return status;
  if (member.activity != null) return { kind: "game", text: member.activity.name };
  if (status !== null) return status;
  if (member.listening != null) return { kind: "song", text: listeningLine(member.listening) };
  return null;
}

function rowModel(item: Extract<ListItem, { kind: "row" }>, ctx: BuddyContext): BuddyRowModel {
  const { member } = item;
  const dimmed = isAwayStatus(member.status);
  return {
    kind: "row",
    id: member.id,
    name: memberDisplayName(member),
    avatarName: resolveDisplayName({ username: member.username, displayName: member.displayName }),
    avatarColor: pickAvatarColor(member.username),
    avatarUrl: member.avatar,
    colorVar: item.colorVar,
    status: member.status,
    mobile: member.mobile === true,
    dimmed,
    line: lineOf(member, dimmed),
    room: ctx.rooms.get(member.id)?.name ?? null,
  };
}

function itemModel(item: ListItem, ctx: BuddyContext): BuddyItemModel {
  if (item.kind === "header") {
    return {
      kind: "header",
      group: item.key,
      text: item.text,
      collapsible: item.collapsible === true,
      collapsed: item.collapsed === true,
    };
  }
  if (item.kind === "empty") return { kind: "empty", text: item.text };
  return rowModel(item, ctx);
}

/** The height kind of an item or of its model: both carry the same `kind`. */
function kindOf(entry: ListItem | BuddyItemModel): number {
  if (entry.kind === "header") return HEADER;
  return entry.kind === "empty" ? EMPTY : ROW;
}

/** The line 2 element, `#bi-line-<id>`. */
function drawLine(id: number, line: BuddyLine): HTMLElement {
  if (line.kind === "status") {
    const el = createElement("span", {
      class: "mi-custom-status",
      "data-testid": `member-custom-status-${id}`,
      id: `bi-line-${id}`,
    });
    setText(el, line.text);
    return el;
  }
  const el = createElement("span", {
    class: "mi-activity",
    "data-testid": `member-activity-${id}`,
    id: `bi-line-${id}`,
  });
  const icon = createIcon(line.kind === "game" ? "gamepad-2" : "music", 12);
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("mi-activity-icon");
  const text = createElement("span", { class: "mi-activity-text" });
  setText(text, line.text);
  appendChildren(el, icon, text);
  return el;
}

/** The line text, then the room, then the status dot. */
function describedBy(id: number, hasLine: boolean, hasRoom: boolean): string {
  return [hasLine ? `bi-line-${id}` : null, hasRoom ? `bi-room-${id}` : null, `mi-status-${id}`]
    .filter((part) => part !== null)
    .join(" ");
}

/** Shows or hides the voice icon, and adds, updates or removes the room's
 *  screen-reader text, always the last child of line 1. */
function applyRoom(row: HTMLElement, id: number, room: string | null): void {
  const line1 = row.querySelector<HTMLElement>(".buddy-line1");
  const icon = row.querySelector<HTMLElement>(".buddy-voice");
  if (line1 === null || icon === null) return;
  let label = line1.querySelector<HTMLElement>(`#bi-room-${id}`);
  if (room === null) {
    icon.hidden = true;
    icon.removeAttribute("title");
    label?.remove();
  } else {
    const text = buddiesText("inRoom", { room });
    icon.hidden = false;
    icon.title = text;
    if (label === null) {
      label = createElement("span", { class: "sr-only", id: `bi-room-${id}` });
      line1.appendChild(label);
    }
    if (label.textContent !== text) setText(label, text);
  }
  const hasLine = row.querySelector(`#bi-line-${id}`) !== null;
  row.setAttribute("aria-describedby", describedBy(id, hasLine, room !== null));
}

function drawRow(model: BuddyRowModel): HTMLElement {
  const row = createElement("div", {
    class: model.dimmed ? "member-item buddy-row offline" : "member-item buddy-row",
    "data-testid": `member-${model.id}`,
    role: "button",
    tabindex: "0",
    "aria-haspopup": "dialog",
    "aria-label": model.name,
    title: model.name,
  });
  const icon = createElement("span", {
    class: "buddy-voice",
    "data-testid": `buddy-voice-${model.id}`,
    "aria-hidden": "true",
  });
  icon.appendChild(createIcon("volume-2", 14));
  const line1 = createElement("div", { class: "buddy-line1" });
  appendChildren(line1, drawMemberName(model.name, model.colorVar), icon);
  const line2 = createElement("div", { class: "buddy-line2" });
  if (model.line !== null) line2.appendChild(drawLine(model.id, model.line));
  const lines = createElement("div", { class: "buddy-lines" });
  appendChildren(lines, line1, line2);
  appendChildren(row, drawAvatarWithDot(model, createAvatarElement), lines);
  applyRoom(row, model.id, model.room);
  return row;
}

/** A foldable header's state: `aria-expanded` and the chevron's turn. */
function applyFold(header: Element, collapsed: boolean): void {
  header.setAttribute("aria-expanded", String(!collapsed));
  header.querySelector(".buddies-group-chevron")?.classList.toggle("collapsed", collapsed);
}

/** A foldable header is a button with a chevron; the list binds its keys.
 *  During a search it is plain text. */
function drawHeader(model: BuddyHeaderModel): HTMLElement {
  const header = createElement("div", {
    class: "buddies-group",
    "data-testid": `buddies-group-${model.group.replace(/^a:/, "")}`,
  });
  if (model.collapsible) {
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    const chevron = createIcon("chevron-down", 12);
    chevron.setAttribute("aria-hidden", "true");
    chevron.classList.add("buddies-group-chevron");
    header.appendChild(chevron);
    applyFold(header, model.collapsed);
  }
  header.appendChild(createElement("span", { class: "buddies-group-text" }, model.text));
  return header;
}

function draw(model: BuddyItemModel): HTMLElement {
  if (model.kind === "row") return drawRow(model);
  if (model.kind === "header") return drawHeader(model);
  return drawEmptyState(model.text);
}

/** Brings a drawn child to `next` in place; only the patch fields differ. */
function patch(el: Element, next: BuddyItemModel): void {
  if (next.kind !== "row") {
    const selector = next.kind === "header" ? ".buddies-group-text" : ".member-list-empty-text";
    const text = el.querySelector(selector);
    if (text !== null && text.textContent !== next.text) setText(text, next.text);
    if (next.kind === "header" && next.collapsible) applyFold(el, next.collapsed);
    return;
  }
  if (!(el instanceof HTMLElement)) return;
  el.classList.toggle("offline", next.dimmed);
  const dot = el.querySelector<HTMLElement>(".mi-status");
  if (dot !== null) {
    dot.setAttribute("aria-label", applyStatusIndicator(dot, next.status, next.mobile));
  }
  applyRoom(el, next.id, next.room);
}

export const buddiesRows: MemberRowRenderer<BuddyItemModel, BuddyContext> = {
  model: itemModel,
  draw,
  patch: { fields: PATCH_FIELDS, apply: patch },
  itemKind: kindOf,
  modelKind: kindOf,
  estimatedHeights: [28, 42, 42, 80],
};
