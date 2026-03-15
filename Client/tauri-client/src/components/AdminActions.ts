/**
 * AdminActions — context menu helpers for admin operations on members and channels.
 * Provides confirmation steps for destructive actions (kick, ban, delete).
 */

import { createElement, appendChildren, setText } from "@lib/dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberContextMenuOptions {
  userId: number;
  username: string;
  currentRole: string;
  availableRoles: readonly string[];
  onKick(): Promise<void>;
  onBan(): Promise<void>;
  onChangeRole(newRole: string): Promise<void>;
}

export interface ChannelContextMenuOptions {
  channelId: number;
  channelName: string;
  onEdit(): void;
  onDelete(): Promise<void>;
  onCreate(): void;
}

interface ContextMenuResult {
  readonly element: HTMLDivElement;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMenuItem(
  label: string,
  className: string,
  onClick: () => void,
  signal: AbortSignal,
): HTMLDivElement {
  const item = createElement("div", { class: className }, label);
  item.addEventListener("click", onClick, { signal });
  return item;
}

function createSeparator(): HTMLDivElement {
  return createElement("div", { class: "context-menu__separator" });
}

function withConfirmation(
  item: HTMLDivElement,
  confirmLabel: string,
  onConfirm: () => void,
  signal: AbortSignal,
): void {
  let confirming = false;
  const originalLabel = item.textContent ?? "";

  item.addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirming) {
      confirming = false;
      setText(item, originalLabel);
      onConfirm();
    } else {
      confirming = true;
      setText(item, confirmLabel);
    }
  }, { signal });
}

// ---------------------------------------------------------------------------
// Member Context Menu
// ---------------------------------------------------------------------------

export function createMemberContextMenu(
  options: MemberContextMenuOptions,
): ContextMenuResult {
  const ac = new AbortController();
  const menu = createElement("div", { class: "context-menu" });

  // Role submenu trigger
  const roleItem = createElement("div", {
    class: "context-menu__item",
  }, "Change Role");

  const roleSub = createElement("div", { class: "context-menu__submenu" });
  for (const role of options.availableRoles) {
    const cls = role === options.currentRole
      ? "context-menu__item context-menu__item--active"
      : "context-menu__item";
    const roleOption = createMenuItem(role, cls, () => {
      if (role !== options.currentRole) {
        void options.onChangeRole(role);
      }
    }, ac.signal);
    roleSub.appendChild(roleOption);
  }

  roleItem.addEventListener("mouseenter", () => {
    roleSub.style.display = "";
  }, { signal: ac.signal });
  roleItem.addEventListener("mouseleave", () => {
    roleSub.style.display = "none";
  }, { signal: ac.signal });

  roleSub.style.display = "none";
  appendChildren(roleItem, roleSub);
  menu.appendChild(roleItem);

  menu.appendChild(createSeparator());

  // Kick with confirmation
  const kickItem = createElement("div", {
    class: "context-menu__item context-menu__item--danger",
  }, "Kick");
  withConfirmation(kickItem, "Are you sure?", () => {
    void options.onKick();
  }, ac.signal);
  menu.appendChild(kickItem);

  // Ban with confirmation
  const banItem = createElement("div", {
    class: "context-menu__item context-menu__item--danger",
  }, "Ban");
  withConfirmation(banItem, "Are you sure?", () => {
    void options.onBan();
  }, ac.signal);
  menu.appendChild(banItem);

  function destroy(): void {
    ac.abort();
    menu.remove();
  }

  return { element: menu, destroy };
}

// ---------------------------------------------------------------------------
// Channel Context Menu
// ---------------------------------------------------------------------------

export function createChannelContextMenu(
  options: ChannelContextMenuOptions,
): ContextMenuResult {
  const ac = new AbortController();
  const menu = createElement("div", { class: "context-menu" });

  // Edit Channel
  const editItem = createMenuItem(
    "Edit Channel",
    "context-menu__item",
    () => options.onEdit(),
    ac.signal,
  );
  menu.appendChild(editItem);

  // Create Channel
  const createItem = createMenuItem(
    "Create Channel",
    "context-menu__item",
    () => options.onCreate(),
    ac.signal,
  );
  menu.appendChild(createItem);

  menu.appendChild(createSeparator());

  // Delete Channel with confirmation
  const deleteItem = createElement("div", {
    class: "context-menu__item context-menu__item--danger",
  }, "Delete Channel");
  withConfirmation(deleteItem, "Are you sure?", () => {
    void options.onDelete();
  }, ac.signal);
  menu.appendChild(deleteItem);

  function destroy(): void {
    ac.abort();
    menu.remove();
  }

  return { element: menu, destroy };
}
