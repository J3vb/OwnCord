/**
 * The Servers list as a bottom sheet, for a phone: the same servers and
 * folders as the Servers popover, in the same order, then Add and Join. A
 * folder opens its servers on a second page. The sheet closes before a row
 * acts, so a switch goes through the controller with its guard and the
 * switch question, as from the popover.
 *
 * The popover's right-click menus have no tap here, so the sheet offers them
 * as rows: Folder options on a folder's page, and Server options, a page of
 * every server. Either opens the item's menu as a sheet of its own from the
 * Servers button.
 *
 * It does not use the tabs' menu slot: the slot closes on every window
 * resize, which the keyboard closing after a tap on the button would fire.
 */
import { createLogger } from "@lib/logger";
import type { FolderItem, RailItem } from "@lib/prefs/serverRailLayout";
import type { BottomSheet } from "@lib/ui/bottomSheet";
import type { ContextMenuItem, ContextMenuSeparator } from "@lib/ui/contextMenu";
import { serverRailText } from "../../i18n/serverRail";
import type { MenuSheetRequest } from "../menus/menuSheet";
import {
  addJoinItems,
  folderItems,
  folderLabel,
  folderName,
  serverItems,
  serverLabel,
  type MenuPlace,
  type TabMenuContext,
} from "./serverTabMenus";

const log = createLogger("server-rail");

/** What the rows need to open a sheet from the Servers button. */
export interface SheetHost {
  readonly ctx: TabMenuContext;
  readonly button: HTMLElement;
  readonly open: (req: MenuSheetRequest) => BottomSheet;
}

/** Opens a sheet from the Servers button, whose `aria-expanded` follows it. */
function openFromButton(
  host: SheetHost,
  req: Pick<MenuSheetRequest, "items" | "label" | "testId">,
): void {
  const { button } = host;
  const sheet = host.open({
    ...req,
    signal: host.ctx.ctl.signal,
    fallbackFocus: () => button,
    onClosed: () => button.setAttribute("aria-expanded", "false"),
  });
  if (!sheet.signal.aborted) button.setAttribute("aria-expanded", "true");
}

function serverRow(host: string, ctx: TabMenuContext): ContextMenuItem {
  return {
    label: serverLabel(ctx.ctl, host),
    testId: "deck-servers-sheet-server",
    checked: host === ctx.ctl.currentHost,
    radio: true,
    onClick: () => ctx.activate(host),
  };
}

function folderRow(folder: FolderItem, sh: SheetHost): ContextMenuItem {
  const options: ContextMenuItem = {
    label: serverRailText("folderMenu"),
    testId: "deck-servers-sheet-folder-options",
    onClick: () =>
      openFromButton(sh, {
        items: folderItems(folder, "servers", sh.ctx),
        label: folderName(folder),
        testId: "deck-servers-options-sheet",
      }),
  };
  return {
    label: folderLabel(folder, sh.ctx.ctl.currentHost),
    testId: "deck-servers-sheet-folder",
    submenu: [...folder.hosts.map((host) => serverRow(host, sh.ctx)), options],
    // The sheet opens the second page itself.
    onClick: () => undefined,
  };
}

/** Server options: a page of every server in order, each opening its own menu. */
function serverOptionsRow(items: readonly RailItem[], sh: SheetHost): ContextMenuItem {
  const { ctl } = sh.ctx;
  const row = (host: string, place: MenuPlace): ContextMenuItem => ({
    label: serverLabel(ctl, host),
    testId: "deck-servers-sheet-options-server",
    onClick: () =>
      openFromButton(sh, {
        items: serverItems(host, place, sh.ctx),
        label: ctl.look(host).name,
        testId: "deck-servers-options-sheet",
      }),
  });
  return {
    label: serverRailText("menu"),
    testId: "deck-servers-sheet-server-options",
    icon: "settings",
    submenu: items.flatMap((item) =>
      item.kind === "server"
        ? [row(item.host, "servers")]
        : item.hosts.map((host) => row(host, "member")),
    ),
    onClick: () => undefined,
  };
}

/** Each server and folder in order, then Server options, then Add and Join, each after a separator. */
export function serverSheetRows(
  items: readonly RailItem[],
  sh: SheetHost,
): Array<ContextMenuItem | ContextMenuSeparator> {
  const rows = items.map((item) =>
    item.kind === "server" ? serverRow(item.host, sh.ctx) : folderRow(item, sh),
  );
  const options: Array<ContextMenuItem | ContextMenuSeparator> =
    items.length > 0 ? [serverOptionsRow(items, sh), { separator: true }] : [];
  return [...rows, { separator: true }, ...options, ...addJoinItems(sh.ctx.ctl)];
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
      const sh: SheetHost = { ctx, button, open: openMenuSheet };
      openFromButton(sh, {
        items: serverSheetRows(items, sh),
        label: serverRailText("label"),
        testId: "deck-servers-sheet",
      });
    },
    (err: unknown) => log.warn("Servers sheet failed to open", { error: String(err) }),
  );
}
