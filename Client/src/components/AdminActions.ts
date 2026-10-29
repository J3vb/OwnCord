/**
 * AdminActions — the member context menu and its admin operations.
 * Provides confirmation steps for destructive actions (force logout, block).
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createMenuItem as buildMenuItem, openMenuShell, type OpenMenu } from "@lib/context-menu";
import { shellText } from "../i18n/shell";
import { voiceText } from "../i18n/voice";
import { copyWithToast, isDeveloperMode } from "../features/developer-mode/developerTools";
import { TIMEOUT_PRESETS } from "../features/moderation/timeoutPresets";
import type { VoiceModMenuOptions } from "./channel-sidebar/volume-menu";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberContextMenuOptions {
  /** Where the menu opens, in viewport pixels. */
  x: number;
  y: number;
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
  /** MANAGE_NICKNAMES plus outrank plus the server capability; defaults to
   *  `showAdminActions`. The item also needs `onChangeNickname`. */
  canManageNicknames?: boolean;
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
  /** Opens the Change Nickname dialog. The menu closes first. */
  onChangeNickname?(): void;
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
  const muted = typeof mod !== "string" && mod.serverMuted === true;
  const deafened = typeof mod !== "string" && mod.serverDeafened === true;
  // A Move Members-only verdict carries no mute, deafen or
  // disconnect handler, and the member menu offers no Move: show only the
  // rows the options can run. A string (the reason) still shows all three.
  const has = (pick: (m: VoiceModMenuOptions) => unknown): boolean =>
    typeof mod === "string" || pick(mod) !== undefined;
  const run = (action: (m: VoiceModMenuOptions) => void) => (): void => {
    if (typeof mod === "string") return;
    action(mod);
    close();
  };
  const opts = (testId: string): { testId: string; disabledReason?: string } =>
    reason === undefined ? { testId } : { testId, disabledReason: reason };
  if (has((m) => m.onServerMute)) {
    appendRow(
      parent,
      voiceText(muted ? "volume.serverUnmute" : "volume.serverMute"),
      run((m) => m.onServerMute?.(!muted)),
      signal,
      opts("member-menu-server-mute"),
    );
  }
  if (has((m) => m.onServerDeafen)) {
    appendRow(
      parent,
      voiceText(deafened ? "volume.serverUndeafen" : "volume.serverDeafen"),
      run((m) => m.onServerDeafen?.(!deafened)),
      signal,
      opts("member-menu-server-deafen"),
    );
  }
  if (has((m) => m.onDisconnect)) {
    appendRow(
      parent,
      voiceText("volume.disconnect"),
      run((m) => m.onDisconnect?.()),
      signal,
      opts("member-menu-disconnect"),
    );
  }
}

/** Open the member menu at `x`, `y`; any other open menu closes. */
export function createMemberContextMenu(options: MemberContextMenuOptions): OpenMenu {
  return openMenuShell({
    x: options.x,
    y: options.y,
    // Above the member list's own popouts.
    attrs: { style: "z-index:1000" },
    ...(options.onClosed === undefined ? {} : { onClosed: options.onClosed }),
    ...(options.restoreFocusTo === undefined ? {} : { restoreFocusTo: options.restoreFocusTo }),
    build: (menu, closeMenu, signal) => buildMemberMenu(menu, options, closeMenu, signal),
  });
}

function buildMemberMenu(
  menu: HTMLElement,
  options: MemberContextMenuOptions,
  closeMenu: () => void,
  signal: AbortSignal,
): void {
  const isSelf = options.isSelf === true;

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
  const canManageNicknames = adminGate && (options.canManageNicknames ?? options.showAdminActions);

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

  if (canManageNicknames && options.onChangeNickname !== undefined) {
    const onChangeNickname = options.onChangeNickname;
    appendRow(
      manage,
      shellText("member.changeNickname"),
      () => {
        closeMenu();
        onChangeNickname();
      },
      signal,
      { testId: "member-menu-change-nickname" },
    );
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
