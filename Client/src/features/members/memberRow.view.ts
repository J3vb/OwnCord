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
import { readableRoleColor } from "../../lib/themes";
import type { UserStatus } from "../../lib/types";
import { statusLabel } from "../../i18n/shell";
import { createIcon, type IconName } from "../../lib/icons";
import type { createAvatarElement } from "../../components/message-list/avatar";

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
export const MEMBER_PATCH_FIELDS = ["status", "away", "text"] as const;

export function statusColor(status: UserStatus): string {
  switch (status) {
    case "online":
      return "var(--green)";
    case "idle":
      return "var(--yellow)";
    case "dnd":
      return "var(--red)";
    case "invisible":
    case "offline":
      return "var(--text-micro)";
    default:
      return "var(--text-micro)";
  }
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

  const avatar = createAvatar(
    { username: model.avatarName, avatar: model.avatarUrl },
    {
      className: "mi-avatar",
      background: model.avatarColor,
      deferUntilVisible: true,
    },
  );

  // Set through the style object, as the patch does, so both serialise alike.
  const dot = createElement("div", {
    class: "mi-status",
    id: statusId,
    "aria-label": statusLabel(model.status),
    title: statusLabel(model.status),
  });
  dot.style.background = statusColor(model.status);
  avatar.appendChild(dot);

  // Name + custom status stack. The custom status is only rendered when there
  // is one, so a member without it keeps the single-line row it always had.
  const nameWrap = createElement("div", { class: "mi-text" });
  const name = createElement("span", {
    class: "mi-name",
    style: `color: ${readableRoleColor(model.colorVar)}`,
    "data-role-color": model.colorVar,
  });
  setText(name, model.name);
  nameWrap.appendChild(name);
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
    default: {
      const emptyState = createElement("div", { class: "member-list-empty" });
      emptyState.appendChild(createElement("p", { class: "member-list-empty-text" }, model.text));
      return emptyState;
    }
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
    dot.style.background = statusColor(next.status);
    dot.setAttribute("aria-label", statusLabel(next.status));
    dot.title = statusLabel(next.status);
  }
}
