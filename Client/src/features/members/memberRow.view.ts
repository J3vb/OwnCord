/**
 * What a member-list child draws, from a plain-data model and nothing else.
 *
 * The model is the drawn values after formatting (the resolved name, the status
 * line, the role colour), so a field the DOM does not show is not in it and a
 * value the DOM shows cannot be missing from it: `reconcileModels` derives the
 * row's signature from the model. This module imports no store; the builder in
 * `MemberList.ts` resolves the store values into the model.
 */

import { createElement, appendChildren, setText } from "../../lib/dom";
import { readableRoleColor } from "../../lib/prefs/themes";
import type { UserStatus } from "../../lib/types";
import { applyStatusIndicator } from "../../lib/ui/statusIndicator";
import { createIcon, type IconName } from "../../lib/icons";
import type { createAvatarElement } from "../profiles/avatar";

/** The avatar drawer, injected: a feature reaches the UI layer only lazily. */
export type CreateAvatar = typeof createAvatarElement;

export type MemberRowModel = {
  readonly kind: "row";
  readonly id: number;
  /** The name shown: the display name, else the username. */
  readonly name: string;
  /** The name the avatar shows: its initial and alt text. */
  readonly avatarName: string;
  /** The letter avatar's background, from the username. */
  readonly avatarColor: string;
  readonly avatarUrl: string | null;
  /** The line under the name; null when there is none. */
  readonly customStatus: string | null;
  /** "Playing <game>" or "Listening to <player>" for the second line; null when
   *  there is none. Always null while a custom status is set, which wins the
   *  line; a game beats music. */
  readonly activity: string | null;
  /** The icon that goes with `activity`: the controller or the music note. */
  readonly activityIcon: IconName;
  readonly colorVar: string;
  /** Patch field with `away`: the dot and the dimmed row change in place. */
  readonly status: UserStatus;
  /** Patch field: the dot is a phone while the member is on the Android app. */
  readonly mobile: boolean;
  readonly away: boolean;
};

export type MemberHeaderModel = {
  readonly kind: "header";
  /** Patch field: the count in a group header changes without a rebuild. */
  readonly text: string;
  readonly offline: boolean;
};

export type MemberEmptyModel = { readonly kind: "empty"; readonly text: string };

export type MemberItemModel = MemberRowModel | MemberHeaderModel | MemberEmptyModel;

/** The fields `patchMemberItem` changes in place. */
export const MEMBER_PATCH_FIELDS = ["status", "mobile", "away", "text"] as const;

/** The avatar with its status dot, `#mi-status-<id>`, inside it. */
export function drawAvatarWithDot(
  model: Pick<
    MemberRowModel,
    "id" | "avatarName" | "avatarColor" | "avatarUrl" | "status" | "mobile"
  >,
  createAvatar: CreateAvatar,
): HTMLElement {
  const avatar = createAvatar(
    { username: model.avatarName, avatar: model.avatarUrl },
    {
      className: "mi-avatar",
      background: model.avatarColor,
      deferUntilVisible: true,
    },
  );

  // Set through the style object, as the patch does, so both serialise alike.
  const dot = createElement("div", { class: "mi-status", id: `mi-status-${model.id}` });
  dot.setAttribute("aria-label", applyStatusIndicator(dot, model.status, model.mobile));
  avatar.appendChild(dot);
  return avatar;
}

/** The name in its role colour, kept so a theme change can re-clamp it. */
export function drawMemberName(name: string, colorVar: string): HTMLElement {
  const el = createElement("span", {
    class: "mi-name",
    style: `color: ${readableRoleColor(colorVar)}`,
    "data-role-color": colorVar,
  });
  setText(el, name);
  return el;
}

/** The list's empty state: no members, or no search match. */
export function drawEmptyState(text: string): HTMLElement {
  const emptyState = createElement("div", { class: "member-list-empty" });
  emptyState.appendChild(createElement("p", { class: "member-list-empty-text" }, text));
  return emptyState;
}

function drawRow(model: MemberRowModel, createAvatar: CreateAvatar): HTMLDivElement {
  const item = createElement("div", {
    class: model.away ? "member-item offline" : "member-item",
    "data-testid": `member-${model.id}`,
    role: "button",
    tabindex: "0",
    "aria-haspopup": "dialog",
    "aria-label": model.name,
  });
  const statusId = `mi-status-${model.id}`;
  const customId = `mi-custom-status-${model.id}`;
  const avatar = drawAvatarWithDot(model, createAvatar);

  // Name + custom status stack. The custom status is only rendered when there
  // is one, so a member without it keeps the single-line row it always had.
  const nameWrap = createElement("div", { class: "mi-text" });
  nameWrap.appendChild(drawMemberName(model.name, model.colorVar));
  if (model.customStatus !== null) {
    const customEl = createElement("span", {
      class: "mi-custom-status",
      "data-testid": `member-custom-status-${model.id}`,
      id: customId,
    });
    setText(customEl, model.customStatus);
    nameWrap.appendChild(customEl);
    item.setAttribute("aria-describedby", `${customId} ${statusId}`);
  } else if (model.activity !== null) {
    const activityId = `mi-activity-${model.id}`;
    const activityEl = createElement("span", {
      class: "mi-activity",
      "data-testid": `member-activity-${model.id}`,
      id: activityId,
    });
    const icon = createIcon(model.activityIcon, 12);
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("mi-activity-icon");
    const text = createElement("span", { class: "mi-activity-text" });
    setText(text, model.activity);
    appendChildren(activityEl, icon, text);
    nameWrap.appendChild(activityEl);
    item.setAttribute("aria-describedby", `${activityId} ${statusId}`);
  } else {
    item.setAttribute("aria-describedby", statusId);
  }

  appendChildren(item, avatar, nameWrap);
  return item;
}

/** Draw a member-list child from its model. A row comes back without handlers. */
export function drawMemberItem(model: MemberItemModel, createAvatar: CreateAvatar): HTMLElement {
  switch (model.kind) {
    case "row":
      return drawRow(model, createAvatar);
    case "header":
      return createElement(
        "div",
        {
          class: "member-role-group",
          ...(model.offline ? { "data-testid": "member-group-offline" } : {}),
        },
        model.text,
      );
    default:
      return drawEmptyState(model.text);
  }
}

/** Bring a drawn child to `next` in place; only the `MEMBER_PATCH_FIELDS` differ. */
export function patchMemberItem(el: Element, next: MemberItemModel): void {
  if (next.kind === "header") {
    if (el.textContent !== next.text) setText(el, next.text);
    return;
  }
  if (next.kind === "empty") {
    const text = el.querySelector(".member-list-empty-text");
    if (text !== null && text.textContent !== next.text) setText(text, next.text);
    return;
  }
  el.classList.toggle("offline", next.away);
  const dot = el.querySelector<HTMLDivElement>(".mi-status");
  if (dot !== null) {
    dot.setAttribute("aria-label", applyStatusIndicator(dot, next.status, next.mobile));
  }
}
