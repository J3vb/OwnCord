/**
 * The Servers list as a bottom sheet, for a phone: the same servers and
 * folders as the Servers popover, in the same order, then Add and Join. A
 * folder opens its servers on a second page. The sheet closes before a row
 * acts, so a switch goes through the controller with its guard and the
 * switch question, as from the popover.
 *
 * It does not use the tabs' menu slot: the slot closes on every window
 * resize, which the keyboard closing after a tap on the button would fire.
 */
import { createLogger } from "@lib/logger";
import type { FolderItem, RailItem } from "@lib/prefs/serverRailLayout";
import type { ContextMenuItem, ContextMenuSeparator } from "@lib/ui/contextMenu";
import { serverRailText } from "../../i18n/serverRail";
import { addJoinItems, folderLabel, serverLabel, type TabMenuContext } from "./serverTabMenus";

const log = createLogger("server-rail");

function serverRow(host: string, ctx: TabMenuContext): ContextMenuItem {
  return {
    label: serverLabel(ctx.ctl, host),
    testId: "deck-servers-sheet-server",
    checked: host === ctx.ctl.currentHost,
    radio: true,
    onClick: () => ctx.activate(host),
  };
}

function folderRow(folder: FolderItem, ctx: TabMenuContext): ContextMenuItem {
  return {
    label: folderLabel(folder, ctx.ctl.currentHost),
    testId: "deck-servers-sheet-folder",
    submenu: folder.hosts.map((host) => serverRow(host, ctx)),
    // The sheet opens the second page itself.
    onClick: () => undefined,
  };
}

/** Each server and folder in order, a separator, then Add and Join. */
export function serverSheetRows(
  items: readonly RailItem[],
  ctx: TabMenuContext,
): Array<ContextMenuItem | ContextMenuSeparator> {
  const rows = items.map((item) =>
    item.kind === "server" ? serverRow(item.host, ctx) : folderRow(item, ctx),
  );
  return [...rows, { separator: true }, ...addJoinItems(ctx.ctl)];
}

/** Closes the tabs' open menu, then opens the sheet once its module loads. The button's `aria-expanded` follows the sheet. */
export function openServerSheet(
  ctx: TabMenuContext,
  items: readonly RailItem[],
  button: HTMLElement,
): void {
  ctx.closeMenu?.();
  // WebKit does not focus a button on a tap; the sheet returns focus to it.
  button.focus();
  const { signal } = ctx.ctl;
  void import("../menus/menuSheet").then(
    ({ openMenuSheet }) => {
      if (signal.aborted) return;
      const sheet = openMenuSheet({
        items: serverSheetRows(items, ctx),
        label: serverRailText("label"),
        testId: "deck-servers-sheet",
        signal,
        fallbackFocus: () => button,
        onClosed: () => button.setAttribute("aria-expanded", "false"),
      });
      if (!sheet.signal.aborted) button.setAttribute("aria-expanded", "true");
    },
    (err: unknown) => log.warn("Servers sheet failed to open", { error: String(err) }),
  );
}
