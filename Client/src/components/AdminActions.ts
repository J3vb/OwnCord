/**
 * AdminActions — context menu helpers for admin operations on members and channels.
 * Provides confirmation steps for destructive actions (force logout, ban, delete).
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createMenuItem as buildMenuItem, enableMenuKeyboard } from "@lib/context-menu";
import { appendPurgeSection } from "./purge-prompt";
import { shellText } from "../i18n/shell";
import { voiceText } from "../i18n/voice";
import { copyWithToast, isDeveloperMode } from "../features/developer-mode/developerTools";
import { TIMEOUT_PRESETS } from "../features/moderation/timeoutPresets";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";

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
  /** MODERATE_MEMBERS plus outrank; defaults to `showAdminActions`. The items
   *  also need their callbacks, so a caller that wires none shows none. */
  canTimeout?: boolean;
  /** The menu's target is the signed-in user: no Block and no moderation. */
  isSelf?: boolean;
  /** Whether the target is timed out, from the server's timeout view: `unknown`
   *  (an older server, no view) offers both Timeout and Remove Timeout. */
  timeoutState?: "active" | "none" | "unknown";
  /** Optional items: each is absent when its option is left out. */
  onProfile?(): void;
  onMention?(): void;
  /** Why Mention is greyed (no composer to write into); absent means usable. */
  mentionDisabledReason?: string;
  onMessage?(): void;
  onCall?(): void;
  /** Voice moderation rows for a target in a server voice channel; a string is
   *  why they are unavailable and renders them greyed with that reason. */
  voiceMod?: VoiceModMenuOptions | string;
  /** Time the member out for `seconds` (one of the six presets). */
  onTimeout?(seconds: number): Promise<void>;
  onRemoveTimeout?(): Promise<void>;
  /** Runs once when the menu goes away, by any path. */
  onClosed?(): void;
  /** Where focus goes on close when the opener row is gone. */
  restoreFocusTo?(): HTMLElement | null;
  /** Whether the local user currently blocks this member (labels the toggle). */
  isBlocked: boolean;
  onToggleBlock(): Promise<void>;
  /** Revokes every session the target holds (the "Force Logout" item). */
  onKick(): Promise<void>;
  /** Opens the Ban dialog (reason, length, message history). The menu closes
   *  first, so the dialog returns focus to the member row. */
  onBan(): void;
  onChangeRole(newRole: string): Promise<void>;
}

const noop = (): void => {};

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
function finishMenu(
  menu: HTMLDivElement,
  disposable: Disposable,
  onClosed: () => void = noop,
  restoreFocusTo?: () => HTMLElement | null,
): ContextMenuResult {
  let restoreFocus: () => void = noop;
  let closed = false;
  function destroy(): void {
    disposable.destroy();
    menu.remove();
    restoreFocus();
    if (closed) return;
    closed = true;
    onClosed();
  }
  restoreFocus = enableMenuKeyboard(menu, {
    signal: disposable.signal,
    onClose: destroy,
    ...(restoreFocusTo === undefined ? {} : { restoreFocusTo }),
  });
  return { element: menu, destroy };
}

/** One flat menu row. `disabledReason` greys it and keeps it inert; the reason
 *  shows as its tooltip. */
function appendRow(
  parent: Node,
  label: string,
  onClick: () => void,
  signal: AbortSignal,
  opts: { testId?: string; disabledReason?: string } = {},
): HTMLElement {
  const item = buildMenuItem(
    label,
    "context-menu__item",
    opts.testId === undefined ? {} : { testId: opts.testId },
  );
  if (opts.disabledReason !== undefined) {
    item.setAttribute("aria-disabled", "true");
    item.title = opts.disabledReason;
  } else {
    item.addEventListener("click", onClick, { signal });
  }
  parent.appendChild(item);
  return item;
}

/** A submenu trigger whose flyout opens on hover (the keyboard path is the
 *  same reveal plus focus, in context-menu.ts). */
function buildFlyout(
  label: string,
  fill: (flyout: HTMLElement) => void,
  signal: AbortSignal,
): HTMLElement {
  const trigger = buildMenuItem(label, "context-menu__item", { submenu: true });
  const flyout = createElement("div", { class: "context-menu__submenu" });
  fill(flyout);
  trigger.addEventListener(
    "mouseenter",
    () => {
      flyout.style.display = "";
    },
    { signal },
  );
  trigger.addEventListener(
    "mouseleave",
    () => {
      flyout.style.display = "none";
    },
    { signal },
  );
  flyout.style.display = "none";
  appendChildren(trigger, flyout);
  return trigger;
}

/** Server Mute / Deafen / Disconnect for a target in a server voice channel. */
function appendVoiceRows(
  parent: Node,
  mod: VoiceModMenuOptions | string,
  close: () => void,
  signal: AbortSignal,
): void {
  const reason = typeof mod === "string" ? mod : mod.disabledReason;
  const muted = typeof mod !== "string" && mod.serverMuted;
  const deafened = typeof mod !== "string" && mod.serverDeafened;
  const run = (action: (m: VoiceModMenuOptions) => void) => (): void => {
    if (typeof mod === "string") return;
    action(mod);
    close();
  };
  const opts = (testId: string): { testId: string; disabledReason?: string } =>
    reason === undefined ? { testId } : { testId, disabledReason: reason };
  appendRow(
    parent,
    voiceText(muted ? "volume.serverUnmute" : "volume.serverMute"),
    run((m) => m.onServerMute(!m.serverMuted)),
    signal,
    opts("member-menu-server-mute"),
  );
  appendRow(
    parent,
    voiceText(deafened ? "volume.serverUndeafen" : "volume.serverDeafen"),
    run((m) => m.onServerDeafen(!m.serverDeafened)),
    signal,
    opts("member-menu-server-deafen"),
  );
  appendRow(
    parent,
    voiceText("volume.disconnect"),
    run((m) => m.onDisconnect()),
    signal,
    opts("member-menu-disconnect"),
  );
}

export function createMemberContextMenu(options: MemberContextMenuOptions): ContextMenuResult {
  const disposable = new Disposable();
  const signal = disposable.signal;
  const menu = createElement("div", { class: "context-menu" });
  const isSelf = options.isSelf === true;
  let result: ContextMenuResult | null = null;
  const closeMenu = (): void => result?.destroy();

  // Groups, top to bottom; a separator goes between non-empty ones.
  const top = document.createDocumentFragment();
  const voice = document.createDocumentFragment();
  const manage = document.createDocumentFragment();
  const danger = document.createDocumentFragment();
  const bottom = document.createDocumentFragment();

  // Profile / Mention / Message / Call: each appears only when wired.
  if (options.onProfile !== undefined) {
    const onProfile = options.onProfile;
    appendRow(top, shellText("member.profile"), () => onProfile(), signal, {
      testId: "member-menu-profile",
    });
  }
  if (options.onMention !== undefined) {
    const onMention = options.onMention;
    appendRow(
      top,
      shellText("member.mention"),
      () => {
        onMention();
        closeMenu();
      },
      signal,
      {
        testId: "member-menu-mention",
        ...(options.mentionDisabledReason === undefined
          ? {}
          : { disabledReason: options.mentionDisabledReason }),
      },
    );
  }
  if (!isSelf && options.onMessage !== undefined) {
    const onMessage = options.onMessage;
    appendRow(
      top,
      shellText("member.message"),
      () => {
        onMessage();
        closeMenu();
      },
      signal,
      { testId: "member-menu-message" },
    );
  }
  if (!isSelf && options.onCall !== undefined) {
    const onCall = options.onCall;
    appendRow(
      top,
      shellText("member.call"),
      () => {
        onCall();
        closeMenu();
      },
      signal,
      { testId: "member-menu-call" },
    );
  }

  if (!isSelf && options.voiceMod !== undefined) {
    appendVoiceRows(voice, options.voiceMod, closeMenu, signal);
  }

  const adminGate = !isSelf && options.showAdminActions;
  const canManageRoles = adminGate && (options.canManageRoles ?? options.showAdminActions);
  const canKick = adminGate && (options.canKick ?? options.showAdminActions);
  const canBan = adminGate && (options.canBan ?? options.showAdminActions);
  const canTimeout = adminGate && (options.canTimeout ?? options.showAdminActions);

  // Role submenu trigger
  if (canManageRoles) {
    const roleItem = buildFlyout(
      shellText("member.changeRole"),
      (roleSub) => {
        // One guard across every option: `currentRole` only updates when the
        // member_update echoes, so without it a double-click (or a second option
        // clicked while the first PATCH is in flight) fires twice.
        let roleChangeRunning = false;
        for (const role of options.availableRoles) {
          const cls =
            role.toLowerCase() === options.currentRole.toLowerCase()
              ? "context-menu__item context-menu__item--active"
              : "context-menu__item";
          const roleOption = createMenuItem(
            role,
            cls,
            () => {
              if (roleChangeRunning || role.toLowerCase() === options.currentRole.toLowerCase()) {
                return;
              }
              roleChangeRunning = true;
              roleOption.classList.add("context-menu__item--pending");
              const done = (): void => {
                roleChangeRunning = false;
                roleOption.classList.remove("context-menu__item--pending");
              };
              options.onChangeRole(role).then(done, done);
            },
            signal,
          );
          roleSub.appendChild(roleOption);
        }
      },
      signal,
    );
    manage.appendChild(roleItem);
  }

  // Timeout presets, or Remove Timeout when the server says one is active. An
  // unknown state (an older server) offers both.
  let timeoutRunning = false;
  const timeoutState = options.timeoutState ?? "unknown";
  if (canTimeout && options.onTimeout !== undefined && timeoutState !== "active") {
    const onTimeout = options.onTimeout;
    // One guard across all six presets and Remove Timeout: the state only
    // changes when the server's member_timeouts frame arrives.
    manage.appendChild(
      buildFlyout(
        shellText("member.timeout"),
        (sub) => {
          for (const preset of TIMEOUT_PRESETS) {
            const row = createMenuItem(
              shellText(preset.key),
              "context-menu__item",
              () => {
                if (timeoutRunning) return;
                timeoutRunning = true;
                row.classList.add("context-menu__item--pending");
                const done = (): void => {
                  timeoutRunning = false;
                  row.classList.remove("context-menu__item--pending");
                };
                onTimeout(preset.seconds).then(done, done);
              },
              signal,
            );
            sub.appendChild(row);
          }
        },
        signal,
      ),
    );
  }
  if (canTimeout && options.onRemoveTimeout !== undefined && timeoutState !== "none") {
    const onRemove = options.onRemoveTimeout;
    const removeItem = appendRow(
      manage,
      shellText("member.removeTimeout"),
      () => {
        if (timeoutRunning) return;
        timeoutRunning = true;
        removeItem.classList.add("context-menu__item--pending");
        const done = (): void => {
          timeoutRunning = false;
          removeItem.classList.remove("context-menu__item--pending");
        };
        onRemove().then(done, done);
      },
      signal,
      { testId: "member-menu-remove-timeout" },
    );
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
      signal,
      shellText("member.loggingOut"),
    );
    danger.appendChild(kickItem);
  }

  if (canBan) {
    appendRow(
      danger,
      shellText("member.ban"),
      () => {
        closeMenu();
        options.onBan();
      },
      signal,
      { testId: "member-menu-ban" },
    ).classList.add("context-menu__item--danger");
  }

  // Developer Mode: copy the member's ID, just above Block (self included).
  if (isDeveloperMode()) {
    appendRow(
      bottom,
      shellText("member.copyId"),
      () => copyWithToast(String(options.userId), "toast.userIdCopied", "toast.userIdCopyFailed"),
      signal,
    );
  }

  // Block / Unblock — available to every other member, not just admins. Blocking
  // is disruptive (kills DMs both ways) so it confirms; unblocking is one click.
  if (!isSelf) bottom.appendChild(buildBlockItem(options, signal));

  let first = true;
  for (const group of [top, voice, manage, danger, bottom]) {
    if (group.childNodes.length === 0) continue;
    if (!first) menu.appendChild(createSeparator());
    first = false;
    menu.appendChild(group);
  }

  result = finishMenu(menu, disposable, options.onClosed, options.restoreFocusTo);
  return result;
}

function buildBlockItem(options: MemberContextMenuOptions, signal: AbortSignal): HTMLElement {
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
      { signal },
    );
  } else {
    withConfirmation(
      blockItem,
      shellText("common.areYouSure"),
      () => options.onToggleBlock(),
      signal,
      shellText("member.blocking"),
    );
  }
  return blockItem;
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
