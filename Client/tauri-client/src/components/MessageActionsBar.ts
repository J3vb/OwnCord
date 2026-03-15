/**
 * Step 5.45 — MessageActionsBar factory.
 * Creates a horizontal bar of action buttons for a message.
 * Returns an HTMLDivElement (not a MountableComponent).
 */

import { createElement, appendChildren } from "@lib/dom";

export interface MessageActionsBarOptions {
  readonly messageId: number;
  readonly isOwn: boolean;
  readonly canManageMessages: boolean;
  readonly onReply: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onReact: () => void;
  readonly onPin: () => void;
  readonly onMore: () => void;
}

interface ActionDef {
  readonly label: string;
  readonly icon: string;
  readonly handler: () => void;
}

function buildActions(options: MessageActionsBarOptions): readonly ActionDef[] {
  const actions: ActionDef[] = [
    { label: "React", icon: "\uD83D\uDE04", handler: options.onReact },
    { label: "Reply", icon: "\u21A9", handler: options.onReply },
  ];

  if (options.isOwn) {
    actions.push({
      label: "Edit",
      icon: "\u270F",
      handler: options.onEdit,
    });
  }

  if (options.isOwn || options.canManageMessages) {
    actions.push({
      label: "Delete",
      icon: "\uD83D\uDDD1",
      handler: options.onDelete,
    });
  }

  if (options.canManageMessages) {
    actions.push({
      label: "Pin",
      icon: "\uD83D\uDCCC",
      handler: options.onPin,
    });
  }

  actions.push({ label: "More", icon: "\u22EF", handler: options.onMore });

  return actions;
}

export function createMessageActionsBar(
  options: MessageActionsBarOptions,
): HTMLDivElement {
  const ac = new AbortController();
  const bar = createElement("div", { class: "msg-actions-bar" });

  const actions = buildActions(options);
  const buttons: HTMLButtonElement[] = [];

  for (const action of actions) {
    const btn = createElement(
      "button",
      { title: action.label, "aria-label": action.label },
      action.icon,
    );

    btn.addEventListener("click", action.handler, { signal: ac.signal });
    buttons.push(btn);
  }

  appendChildren(bar, ...buttons);

  return bar;
}
