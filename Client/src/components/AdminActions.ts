/**
 * AdminActions — context menu helpers for admin operations on members and channels.
 * Provides confirmation steps for destructive actions (force logout, ban, delete).
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createMenuItem as buildMenuItem, enableMenuKeyboard } from "@lib/context-menu";
import { appendPurgeSection } from "./purge-prompt";
import { shellText } from "../i18n/shell";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberContextMenuOptions {
  userId: number;
  username: string;
  currentRole: string;
  availableRoles: readonly string[];
  /** When false, only the non-admin actions (block/unblock) are rendered. */
  showAdminActions: boolean;
  /**
   * Per-action gates, each defaulting to `showAdminActions`. They mirror the
   * server's KICK_MEMBERS / BAN_MEMBERS / MANAGE_ROLES bits so a moderator
   * sees only the actions its role actually holds. canKick gates "Force
   * Logout" — the KICK_MEMBERS bit buys session revocation, not removal.
   */
  canKick?: boolean;
  canBan?: boolean;
  canManageRoles?: boolean;
  /** Whether the local user currently blocks this member (labels the toggle). */
  isBlocked: boolean;
  onToggleBlock(): Promise<void>;
  /** Revokes every session the target holds (the "Force Logout" item). */
  onKick(): Promise<void>;
  /**
   * The reason is stored and displayed by the server; empty means "no reason
   * given". durationHours 0 = permanent, otherwise the ban auto-expires.
   */
  onBan(reason: string, durationHours: number): Promise<void>;
  onChangeRole(newRole: string): Promise<void>;
}

/** Ban duration choices offered in the ban flow (label key → hours; 0 = permanent). */
const noop = (): void => {};

const BAN_DURATIONS = [
  { key: "ban.forever", hours: 0 },
  { key: "ban.oneHour", hours: 1 },
  { key: "ban.oneDay", hours: 24 },
  { key: "ban.sevenDays", hours: 24 * 7 },
  { key: "ban.thirtyDays", hours: 24 * 30 },
] as const;

export interface ChannelContextMenuOptions {
  channelId: number;
  channelName: string;
  onEdit(): void;
  onDelete(): Promise<void>;
  onCreate(): void;
  /**
   * Bulk-delete the newest `count` messages. Omitted when the local user's
   * role lacks MANAGE_MESSAGES — the section is then not rendered at all,
   * mirroring the server's gate.
   */
  onPurge?(count: number): Promise<void>;
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
): HTMLElement {
  const item = buildMenuItem(label, className);
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
 * request is running — a slow force logout used to look like nothing happened.
 */
function withConfirmation(
  item: HTMLElement,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  signal: AbortSignal,
  pendingLabel = shellText("common.working"),
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

/** Wrap a finished menu: enable the shared keyboard model and return the
 *  result. `destroy` tears the menu and its listeners down, whether called by
 *  Escape/close or by the owner, and always restores focus to the opener. */
function finishMenu(menu: HTMLDivElement, disposable: Disposable): ContextMenuResult {
  let restoreFocus: () => void = noop;
  function destroy(): void {
    disposable.destroy();
    menu.remove();
    restoreFocus();
  }
  restoreFocus = enableMenuKeyboard(menu, { signal: disposable.signal, onClose: destroy });
  return { element: menu, destroy };
}

export function createMemberContextMenu(options: MemberContextMenuOptions): ContextMenuResult {
  const disposable = new Disposable();
  const menu = createElement("div", { class: "context-menu" });

  // Block / Unblock — available to every member, not just admins. Blocking is
  // disruptive (kills DMs both ways) so it confirms; unblocking is one click.
  const blockItem = buildMenuItem(
    shellText(options.isBlocked ? "member.unblock" : "member.block"),
    options.isBlocked ? "context-menu__item" : "context-menu__item context-menu__item--danger",
    { testId: "block-toggle" },
  );
  if (options.isBlocked) {
    let unblockRunning = false;
    blockItem.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        if (unblockRunning) return;
        unblockRunning = true;
        setText(blockItem, shellText("member.unblocking"));
        blockItem.classList.add("context-menu__item--pending");
        const done = (): void => {
          unblockRunning = false;
          blockItem.classList.remove("context-menu__item--pending");
          setText(blockItem, shellText("member.unblock"));
        };
        void options.onToggleBlock().then(done, done);
      },
      { signal: disposable.signal },
    );
  } else {
    withConfirmation(
      blockItem,
      shellText("common.areYouSure"),
      () => options.onToggleBlock(),
      disposable.signal,
      shellText("member.blocking"),
    );
  }

  const canManageRoles = options.canManageRoles ?? options.showAdminActions;
  const canKick = options.canKick ?? options.showAdminActions;
  const canBan = options.canBan ?? options.showAdminActions;

  if (!options.showAdminActions || (!canManageRoles && !canKick && !canBan)) {
    menu.appendChild(blockItem);
    return finishMenu(menu, disposable);
  }

  // Role submenu trigger
  if (canManageRoles) {
    const roleItem = buildMenuItem(shellText("member.changeRole"), "context-menu__item", {
      submenu: true,
    });

    const roleSub = createElement("div", { class: "context-menu__submenu" });
    // One guard across every option: `currentRole` only updates when the
    // member_update echoes, so without it a double-click (or a second option
    // clicked while the first PATCH is in flight) fires twice.
    let roleChangeRunning = false;
    for (const role of options.availableRoles) {
      const cls =
        role === options.currentRole
          ? "context-menu__item context-menu__item--active"
          : "context-menu__item";
      const roleOption = createMenuItem(
        role,
        cls,
        () => {
          if (roleChangeRunning || role === options.currentRole) return;
          roleChangeRunning = true;
          roleOption.classList.add("context-menu__item--pending");
          const done = (): void => {
            roleChangeRunning = false;
            roleOption.classList.remove("context-menu__item--pending");
          };
          options.onChangeRole(role).then(done, done);
        },
        disposable.signal,
      );
      roleSub.appendChild(roleOption);
    }

    // Hover reveals the flyout without moving focus; the keyboard path
    // (ArrowRight/Enter) is the same reveal plus focus, in context-menu.ts.
    roleItem.addEventListener(
      "mouseenter",
      () => {
        roleSub.style.display = "";
      },
      { signal: disposable.signal },
    );
    roleItem.addEventListener(
      "mouseleave",
      () => {
        roleSub.style.display = "none";
      },
      { signal: disposable.signal },
    );

    roleSub.style.display = "none";
    appendChildren(roleItem, roleSub);
    menu.appendChild(roleItem);

    menu.appendChild(createSeparator());
  }

  // Force Logout with confirmation. Named for what it does: the server revokes
  // the target's sessions (KICK_MEMBERS), it does not remove a membership —
  // there is no membership model — so the user can sign straight back in.
  if (canKick) {
    const kickItem = buildMenuItem(
      shellText("member.forceLogout"),
      "context-menu__item context-menu__item--danger",
      { testId: "force-logout" },
    );
    withConfirmation(
      kickItem,
      shellText("member.forceLogoutConfirm"),
      () => options.onKick(),
      disposable.signal,
      shellText("member.loggingOut"),
    );
    menu.appendChild(kickItem);
  }

  if (canBan) appendBanFlow(menu, options, disposable.signal);

  menu.appendChild(createSeparator());
  menu.appendChild(blockItem);

  return finishMenu(menu, disposable);
}

/** Ban entry plus its reason/duration form. Split out so the member menu can
 *  omit it wholesale for an actor without BAN_MEMBERS. */
function appendBanFlow(
  menu: HTMLDivElement,
  options: MemberContextMenuOptions,
  signal: AbortSignal,
): void {
  // Ban — collects the reason the server stores and displays alongside the ban.
  const banItem = buildMenuItem(
    shellText("member.ban"),
    "context-menu__item context-menu__item--danger",
  );
  const banReasonRow = createElement("div", {
    class: "context-menu__reason",
    style: "display:none;padding:6px 8px",
  });
  const banReasonInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: shellText("member.banReason"),
    maxlength: "200",
    "data-testid": "ban-reason-input",
    style: "width:100%;font-size:12px",
  });
  const banDurationSelect = createElement("select", {
    class: "form-input",
    "data-testid": "ban-duration-select",
    "aria-label": shellText("member.banDuration"),
    style: "width:100%;font-size:12px;margin-top:4px",
  });
  for (const d of BAN_DURATIONS) {
    const opt = createElement("option", { value: String(d.hours) }, shellText(d.key));
    banDurationSelect.appendChild(opt);
  }
  const banConfirm = buildMenuItem(
    shellText("member.banConfirm"),
    "context-menu__item context-menu__item--danger",
    { testId: "ban-confirm" },
  );
  appendChildren(banReasonRow, banReasonInput, banDurationSelect, banConfirm);

  banItem.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      banItem.style.display = "none";
      banReasonRow.style.display = "";
      // The confirm button is a menuitem with tabindex -1 (roving navigation
      // owns the Tab stop); now that its form is shown it must be Tab-reachable.
      banConfirm.setAttribute("tabindex", "0");
      banReasonInput.focus();
    },
    { signal },
  );

  // Typing a reason must not close the menu or trigger the outside-click guard.
  banReasonInput.addEventListener("click", (e) => e.stopPropagation(), { signal });
  banReasonInput.addEventListener("mousedown", (e) => e.stopPropagation(), { signal });
  banDurationSelect.addEventListener("click", (e) => e.stopPropagation(), { signal });
  banDurationSelect.addEventListener("mousedown", (e) => e.stopPropagation(), {
    signal,
  });

  let banRunning = false;
  function submitBan(): void {
    if (banRunning) return;
    banRunning = true;
    setText(banConfirm, shellText("member.banning"));
    banConfirm.classList.add("context-menu__item--pending");
    const done = (): void => {
      banRunning = false;
      banConfirm.classList.remove("context-menu__item--pending");
      setText(banConfirm, shellText("member.banConfirm"));
    };
    const durationHours = Number.parseInt(banDurationSelect.value, 10) || 0;
    void options.onBan(banReasonInput.value.trim(), durationHours).then(done, done);
  }

  banConfirm.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      submitBan();
    },
    { signal },
  );
  banReasonInput.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitBan();
      }
    },
    { signal },
  );

  appendChildren(menu, banItem, banReasonRow);
}

// ---------------------------------------------------------------------------
// Channel Context Menu
// ---------------------------------------------------------------------------

export function createChannelContextMenu(options: ChannelContextMenuOptions): ContextMenuResult {
  const disposable = new Disposable();
  const menu = createElement("div", { class: "context-menu" });

  // Edit Channel
  const editItem = createMenuItem(
    shellText("channel.edit"),
    "context-menu__item",
    () => options.onEdit(),
    disposable.signal,
  );
  menu.appendChild(editItem);

  // Create Channel
  const createItem = createMenuItem(
    shellText("channel.create"),
    "context-menu__item",
    () => options.onCreate(),
    disposable.signal,
  );
  menu.appendChild(createItem);

  menu.appendChild(createSeparator());

  // Delete Channel with confirmation
  const deleteItem = buildMenuItem(
    shellText("channel.delete"),
    "context-menu__item context-menu__item--danger",
  );
  withConfirmation(
    deleteItem,
    shellText("common.areYouSure"),
    () => options.onDelete(),
    disposable.signal,
    shellText("common.deleting"),
  );
  menu.appendChild(deleteItem);

  const onPurge = options.onPurge;
  if (onPurge !== undefined) {
    appendPurgeSection(menu, {
      itemClass: "context-menu__item",
      dangerItemClass: "context-menu__item context-menu__item--danger",
      separatorClass: "context-menu__separator",
      onPurge: (count) => onPurge(count),
      signal: disposable.signal,
    });
  }

  return finishMenu(menu, disposable);
}
