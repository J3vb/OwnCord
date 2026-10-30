/**
 * ServerMenu — the dropdown under the sidebar header's server name, like
 * Discord's server menu. It is a thin layer over the shared context-menu
 * primitive (roving tabindex, Escape, focus restore); this module only decides
 * which rows exist and wires the button's `aria-expanded`.
 *
 * Every row mirrors a control the header already has, so it is shown under the
 * same condition. Those conditions are read each time the menu opens, never
 * when the sidebar is built: a role change or a reconnect (a fresh `ready`)
 * changes the answer, and a menu built once would keep offering stale actions.
 */

import {
  showContextMenu,
  type ContextMenuItem,
  type ContextMenuSeparator,
} from "@lib/ui/contextMenu";
import { canManageChannels, canManageInvites, canViewAuditLog } from "@lib/permissions";
import { isHideMutedChannels, setHideMutedChannels } from "@lib/prefs/hideMutedChannels";
import { unreadChannelIds } from "@lib/readState";
import { shellText } from "../../i18n/shell";

export interface ServerMenuActions {
  /** Open the invite manager (the header's Invite). */
  readonly onInvite: () => void;
  /** Mark every server channel read (the header's Mark Server as Read). */
  readonly onMarkRead: () => void;
  /** Open Settings on the Notifications tab. */
  readonly onNotificationSettings: () => void;
  /** Create a channel outside any category. */
  readonly onCreateChannel: () => void;
  /** Create a category (MANAGE_CHANNELS). */
  readonly onCreateCategory: () => void;
  /** Open the admin panel (the header's Audit Log entry, without a section). */
  readonly onServerSettings: () => void;
}

type MenuRow = ContextMenuItem | ContextMenuSeparator;

/**
 * The rows for the signed-in user right now. Reads permissions and read state
 * on every call.
 */
export function buildServerMenuItems(actions: ServerMenuActions): MenuRow[] {
  const top: ContextMenuItem[] = [];
  if (canManageInvites()) {
    top.push({
      label: shellText("serverMenu.invite"),
      testId: "server-menu-invite",
      onClick: actions.onInvite,
    });
  }
  // Server-wide, so DMs stay out of it, exactly as the header's button.
  if (unreadChannelIds({ includeDms: false }).length > 0) {
    top.push({
      label: shellText("serverMenu.markRead"),
      testId: "server-menu-mark-read",
      onClick: actions.onMarkRead,
    });
  }
  top.push({
    label: shellText("serverMenu.notifications"),
    testId: "server-menu-notifications",
    onClick: actions.onNotificationSettings,
  });
  // A per-device list preference, so it needs no permission and no action from
  // the page. Read now, like every other row, so the check is current.
  const hideMuted = isHideMutedChannels();
  top.push({
    label: shellText("serverMenu.hideMuted"),
    testId: "server-menu-hide-muted",
    checked: hideMuted,
    onClick: () => setHideMutedChannels(!hideMuted),
  });

  const manage: ContextMenuItem[] = [];
  if (canManageChannels()) {
    manage.push({
      label: shellText("serverMenu.createChannel"),
      testId: "server-menu-create-channel",
      onClick: actions.onCreateChannel,
    });
    manage.push({
      label: shellText("serverMenu.createCategory"),
      testId: "server-menu-create-category",
      onClick: actions.onCreateCategory,
    });
  }
  if (canViewAuditLog()) {
    manage.push({
      label: shellText("serverMenu.serverSettings"),
      testId: "server-menu-server-settings",
      onClick: actions.onServerSettings,
    });
  }

  return manage.length === 0 ? top : [...top, { separator: true }, ...manage];
}

/**
 * Make `button` open the server menu. The button must already be a
 * `<button aria-haspopup="menu">`; this owns `aria-expanded`. Listeners and an
 * open menu die with `signal`.
 */
export function attachServerMenu(
  button: HTMLButtonElement,
  actions: ServerMenuActions,
  signal: AbortSignal,
): void {
  const setExpanded = (open: boolean): void => {
    button.setAttribute("aria-expanded", open ? "true" : "false");
  };
  setExpanded(false);

  // The menu closes on the press that lands outside it, which includes this
  // button; the click that follows would then reopen it. Remember what the
  // press found so that click only toggles it shut.
  let openAtPress = false;
  button.addEventListener(
    "mousedown",
    () => {
      openAtPress = button.getAttribute("aria-expanded") === "true";
    },
    { signal },
  );

  button.addEventListener(
    "click",
    (e) => {
      // A keyboard click has no press before it, so a stale flag from a press
      // dragged off the button must not swallow it.
      if (openAtPress && e.detail !== 0) {
        openAtPress = false;
        return;
      }
      const items = buildServerMenuItems(actions);
      const rect = button.getBoundingClientRect();
      // A mouse click does not focus a button in every webview; the menu
      // hands focus back to whatever held it when it opened.
      button.focus();
      openAtPress = false;
      showContextMenu({
        x: rect.left,
        y: rect.bottom + 4,
        items,
        signal,
        className: "server-menu",
        ariaLabel: shellText("serverMenu.items"),
        restoreFocusTo: () => button,
        onClosed: () => setExpanded(false),
      });
      // After the open, which closes any earlier copy and runs its onClosed.
      setExpanded(true);
    },
    { signal },
  );
}
