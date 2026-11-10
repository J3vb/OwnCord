/**
 * AdminActions — the member context menu and its admin operations.
 * Provides confirmation steps for destructive actions (force logout, block).
 */

import { openMenuShell, createMenuItem as buildMenuItem, type OpenMenu } from "@lib/ui/contextMenu";
import { shellText } from "../../i18n/shell";
import { copyWithToast, isDeveloperMode } from "../developer-mode/developerTools";
import { TIMEOUT_PRESETS } from "./timeoutPresets";
import {
  appendRow,
  appendVoiceRows,
  buildBlockItem,
  buildFlyout,
  createMenuItem,
  createSeparator,
  withConfirmation,
} from "./memberMenuRows";
import type { MemberContextMenuOptions } from "./memberMenuTypes";

export type { MemberContextMenuOptions } from "./memberMenuTypes";

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

/** What the signed-in user's role lets them do to this member. */
interface AdminGates {
  readonly roles: boolean;
  readonly kick: boolean;
  readonly ban: boolean;
  readonly timeout: boolean;
  readonly nicknames: boolean;
}

function resolveGates(options: MemberContextMenuOptions, isSelf: boolean): AdminGates {
  const adminGate = !isSelf && options.showAdminActions;
  const gate = (own: boolean | undefined): boolean =>
    adminGate && (own ?? options.showAdminActions);
  return {
    roles: gate(options.canManageRoles),
    kick: gate(options.canKick),
    ban: gate(options.canBan),
    timeout: gate(options.canTimeout),
    nicknames: gate(options.canManageNicknames),
  };
}

/** A row that runs its handler and then closes the menu. */
function appendClosingRow(
  parent: Node,
  label: string,
  run: () => void,
  closeMenu: () => void,
  signal: AbortSignal,
  testId: string,
  disabledReason?: string,
): void {
  appendRow(
    parent,
    label,
    () => {
      run();
      closeMenu();
    },
    signal,
    disabledReason === undefined ? { testId } : { testId, disabledReason },
  );
}

/** Profile / Mention / Message / Call: each appears only when wired. */
function appendTopRows(
  top: Node,
  options: MemberContextMenuOptions,
  isSelf: boolean,
  closeMenu: () => void,
  signal: AbortSignal,
): void {
  if (options.onProfile !== undefined) {
    const onProfile = options.onProfile;
    appendRow(top, shellText("member.profile"), () => onProfile(), signal, {
      testId: "member-menu-profile",
    });
  }
  if (options.onMention !== undefined) {
    appendClosingRow(
      top,
      shellText("member.mention"),
      options.onMention,
      closeMenu,
      signal,
      "member-menu-mention",
      options.mentionDisabledReason,
    );
  }
  if (!isSelf && options.onMessage !== undefined) {
    appendClosingRow(
      top,
      shellText("member.message"),
      options.onMessage,
      closeMenu,
      signal,
      "member-menu-message",
    );
  }
  if (!isSelf && options.onCall !== undefined) {
    appendClosingRow(
      top,
      shellText("member.call"),
      options.onCall,
      closeMenu,
      signal,
      "member-menu-call",
    );
  }
}

/** The Change Role flyout, one option per available role. */
function buildRoleFlyout(options: MemberContextMenuOptions, signal: AbortSignal): HTMLElement {
  return buildFlyout(
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
}

/** Timeout presets, or Remove Timeout when the server says one is active. An
 *  unknown state (an older server) offers both. */
function appendTimeoutRows(
  manage: Node,
  options: MemberContextMenuOptions,
  signal: AbortSignal,
): void {
  let timeoutRunning = false;
  const timeoutState = options.timeoutState ?? "unknown";
  if (options.onTimeout !== undefined && timeoutState !== "active") {
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
  if (options.onRemoveTimeout !== undefined && timeoutState !== "none") {
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
}

/** Role, nickname and timeout rows. */
function appendManageRows(
  manage: Node,
  options: MemberContextMenuOptions,
  gates: AdminGates,
  closeMenu: () => void,
  signal: AbortSignal,
): void {
  if (gates.roles) manage.appendChild(buildRoleFlyout(options, signal));

  if (gates.nicknames && options.onChangeNickname !== undefined) {
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

  if (gates.timeout) appendTimeoutRows(manage, options, signal);
}

/** Force Logout (with confirmation) and Ban. */
function appendDangerRows(
  danger: Node,
  options: MemberContextMenuOptions,
  gates: AdminGates,
  closeMenu: () => void,
  signal: AbortSignal,
): void {
  // Named for what it does: the server revokes the target's sessions
  // (KICK_MEMBERS), it does not remove a membership — there is no membership
  // model — so the user can sign straight back in.
  if (gates.kick) {
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

  if (gates.ban) {
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
}

function appendBottomRows(
  bottom: Node,
  options: MemberContextMenuOptions,
  isSelf: boolean,
  signal: AbortSignal,
): void {
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

  appendTopRows(top, options, isSelf, closeMenu, signal);

  if (!isSelf && options.voiceMod !== undefined) {
    appendVoiceRows(voice, options.voiceMod, closeMenu, signal);
  }

  const gates = resolveGates(options, isSelf);
  appendManageRows(manage, options, gates, closeMenu, signal);
  appendDangerRows(danger, options, gates, closeMenu, signal);
  appendBottomRows(bottom, options, isSelf, signal);

  let first = true;
  for (const group of [top, voice, manage, danger, bottom]) {
    if (group.childNodes.length === 0) continue;
    if (!first) menu.appendChild(createSeparator());
    first = false;
    menu.appendChild(group);
  }
}
