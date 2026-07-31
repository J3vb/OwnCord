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
  /** The reason is stored and displayed by the server; empty means "no reason given". */
  onBan(reason: string): Promise<void>;
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

/** How long a "Are you sure?" state stays armed before reverting. */
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * Two-click confirm with an in-flight state.
 *
 * The armed state auto-disarms after a few seconds so a menu left open doesn't
 * turn a stray second click into a ban, and the item shows progress while the
 * request is running — a slow kick used to look like nothing happened.
 */
function withConfirmation(
  item: HTMLDivElement,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  signal: AbortSignal,
  pendingLabel = "Working...",
): void {
  let confirming = false;
  let running = false;
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;
  const originalLabel = item.textContent ?? "";

  function disarm(): void {
    confirming = false;
    if (disarmTimer !== null) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    setText(item, originalLabel);
  }

  signal.addEventListener("abort", () => {
    if (disarmTimer !== null) clearTimeout(disarmTimer);
  });

  item.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      if (running) return;
      if (!confirming) {
        confirming = true;
        setText(item, confirmLabel);
        disarmTimer = setTimeout(disarm, CONFIRM_TIMEOUT_MS);
        return;
      }
      if (disarmTimer !== null) {
        clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      confirming = false;
      running = true;
      setText(item, pendingLabel);
      item.classList.add("context-menu__item--pending");
      const done = (): void => {
        running = false;
        item.classList.remove("context-menu__item--pending");
        setText(item, originalLabel);
      };
      const result = onConfirm();
      if (result instanceof Promise) {
        void result.then(done, done);
      } else {
        done();
      }
    },
    { signal },
  );
}

// ---------------------------------------------------------------------------
// Member Context Menu
// ---------------------------------------------------------------------------

export function createMemberContextMenu(options: MemberContextMenuOptions): ContextMenuResult {
  const ac = new AbortController();
  const menu = createElement("div", { class: "context-menu" });

  // Role submenu trigger
  const roleItem = createElement(
    "div",
    {
      class: "context-menu__item",
    },
    "Change Role",
  );

  const roleSub = createElement("div", { class: "context-menu__submenu" });
  for (const role of options.availableRoles) {
    const cls =
      role === options.currentRole
        ? "context-menu__item context-menu__item--active"
        : "context-menu__item";
    const roleOption = createMenuItem(
      role,
      cls,
      () => {
        if (role !== options.currentRole) {
          void options.onChangeRole(role);
        }
      },
      ac.signal,
    );
    roleSub.appendChild(roleOption);
  }

  roleItem.addEventListener(
    "mouseenter",
    () => {
      roleSub.style.display = "";
    },
    { signal: ac.signal },
  );
  roleItem.addEventListener(
    "mouseleave",
    () => {
      roleSub.style.display = "none";
    },
    { signal: ac.signal },
  );

  roleSub.style.display = "none";
  appendChildren(roleItem, roleSub);
  menu.appendChild(roleItem);

  menu.appendChild(createSeparator());

  // Kick with confirmation
  const kickItem = createElement(
    "div",
    {
      class: "context-menu__item context-menu__item--danger",
    },
    "Kick",
  );
  withConfirmation(kickItem, "Are you sure?", () => options.onKick(), ac.signal, "Kicking...");
  menu.appendChild(kickItem);

  // Ban — collects the reason the server stores and displays alongside the ban.
  const banItem = createElement(
    "div",
    {
      class: "context-menu__item context-menu__item--danger",
    },
    "Ban",
  );
  const banReasonRow = createElement("div", {
    class: "context-menu__reason",
    style: "display:none;padding:6px 8px",
  });
  const banReasonInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: "Reason (optional)",
    maxlength: "200",
    "data-testid": "ban-reason-input",
    style: "width:100%;font-size:12px",
  });
  const banConfirm = createElement(
    "div",
    { class: "context-menu__item context-menu__item--danger", "data-testid": "ban-confirm" },
    "Confirm Ban",
  );
  appendChildren(banReasonRow, banReasonInput, banConfirm);

  banItem.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      banItem.style.display = "none";
      banReasonRow.style.display = "";
      banReasonInput.focus();
    },
    { signal: ac.signal },
  );

  // Typing a reason must not close the menu or trigger the outside-click guard.
  banReasonInput.addEventListener("click", (e) => e.stopPropagation(), { signal: ac.signal });
  banReasonInput.addEventListener("mousedown", (e) => e.stopPropagation(), { signal: ac.signal });

  let banRunning = false;
  function submitBan(): void {
    if (banRunning) return;
    banRunning = true;
    setText(banConfirm, "Banning...");
    banConfirm.classList.add("context-menu__item--pending");
    const done = (): void => {
      banRunning = false;
      banConfirm.classList.remove("context-menu__item--pending");
      setText(banConfirm, "Confirm Ban");
    };
    void options.onBan(banReasonInput.value.trim()).then(done, done);
  }

  banConfirm.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      submitBan();
    },
    { signal: ac.signal },
  );
  banReasonInput.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitBan();
      }
    },
    { signal: ac.signal },
  );

  appendChildren(menu, banItem, banReasonRow);

  function destroy(): void {
    ac.abort();
    menu.remove();
  }

  return { element: menu, destroy };
}

// ---------------------------------------------------------------------------
// Channel Context Menu
// ---------------------------------------------------------------------------

export function createChannelContextMenu(options: ChannelContextMenuOptions): ContextMenuResult {
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
  const deleteItem = createElement(
    "div",
    {
      class: "context-menu__item context-menu__item--danger",
    },
    "Delete Channel",
  );
  withConfirmation(deleteItem, "Are you sure?", () => options.onDelete(), ac.signal, "Deleting...");
  menu.appendChild(deleteItem);

  function destroy(): void {
    ac.abort();
    menu.remove();
  }

  return { element: menu, destroy };
}
