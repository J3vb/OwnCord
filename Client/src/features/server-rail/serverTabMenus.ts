/**
 * The server tabs' menus: each item's own menu, a folder tab's dropdown, the
 * "+N" and Servers lists and the "+" menu. They are built here and opened
 * through the renderer's `open`, which owns the one open menu, the opener and
 * focus; this module never imports the renderer.
 */
import { createElement } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { isPhoneLayout } from "@lib/ui/phoneLayout";
import {
  createMenuItem,
  openMenuOnKeyboard,
  openMenuShell,
  showContextMenu,
  type ContextMenuItem,
  type OpenMenu,
} from "@lib/ui/contextMenu";
import {
  moveItem,
  moveServer,
  type FolderItem,
  type ItemRef,
  type RailItem,
} from "@lib/prefs/serverRailLayout";
import { serverRailText } from "../../i18n/serverRail";
import type { RailController } from "./railController";
import { folderMenu, serverMenu, type MenuOptions } from "./serverRailMenus";
import { railIcon, serverAvatar } from "./serverRailParts";

/** Where an item is drawn; it picks the item's menu. */
export type MenuPlace = "row" | "member" | "more" | "servers";

export interface TabMenuContext {
  readonly ctl: RailController;
  /** Opens a menu through the renderer's slot. `fromRow` is true when a row of the
   *  open menu asks, so the new menu inherits the slot's opener; with no menu open it counts as false. `show` receives the `onClosed` to pass. */
  readonly open: (req: {
    readonly openerKey: string;
    readonly opener: HTMLElement;
    readonly fromRow: boolean;
    readonly show: (onClosed: () => void) => OpenMenu;
  }) => void;
  /** A switch from a menu row: records nothing (the slot's key stays), then `ctl.activate(host)`. */
  readonly activate: (host: string) => void;
  /** Closes the slot's open menu; the Servers sheet calls it before it opens. */
  readonly closeMenu?: () => void;
}

interface Opener {
  readonly key: string;
  readonly el: HTMLElement;
  readonly fromRow: boolean;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const log = createLogger("server-rail");

const MENU_CLASS = "server-tabs-menu";
const ROW_CLASS = "context-menu-item";

/** A folder's name as drawn: an unnamed folder reads "Folder". */
export function folderName(folder: FolderItem): string {
  return folder.name !== "" ? folder.name : serverRailText("folder");
}

/** A folder tab's or heading row's name, saying when it holds the current server. */
export function folderLabel(folder: FolderItem, currentHost: string): string {
  const label = serverRailText("folderTab", {
    name: folderName(folder),
    count: folder.hosts.length,
  });
  return folder.hosts.includes(currentHost) ? serverRailText("holdsCurrent", { label }) : label;
}

/** A server's name as a tab or row says it: the current one is marked. */
export function serverLabel(ctl: RailController, host: string): string {
  const { name } = ctl.look(host);
  return host === ctl.currentHost ? serverRailText("currentSuffix", { name }) : name;
}

/** The bottom-left corner of `el`, where a menu it opens is placed. */
export function belowStart(el: HTMLElement): Point {
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

function axisOf(place: MenuPlace): MenuOptions["axis"] {
  return place === "row" || place === "more" ? "x" : "y";
}

function moveToStart(ref: ItemRef, ctx: TabMenuContext): ContextMenuItem {
  return {
    label: serverRailText("moveToStart"),
    testId: "rail-move-to-start",
    icon: "arrow-left",
    onClick: () => {
      const { reconciled, commit } = ctx.ctl.mutations;
      const layout = reconciled();
      const first = layout[0];
      if (first === undefined) return;
      const firstRef: ItemRef =
        first.kind === "server"
          ? { kind: "server", host: first.host }
          : { kind: "folder", id: first.id };
      const next = moveItem(layout, ref, firstRef, false);
      if (next !== layout) commit(next);
    },
  };
}

function moveToFolders(host: string, ctx: TabMenuContext): ContextMenuItem[] {
  const folders = ctx.ctl.mutations
    .reconciled()
    .filter((item): item is FolderItem => item.kind === "folder");
  return folders.map((folder, i) => ({
    label: serverRailText("moveToFolder", { name: folderName(folder) }),
    testId: `rail-move-to-folder-${i}`,
    icon: "folder-plus",
    onClick: () => {
      const { reconciled, commit } = ctx.ctl.mutations;
      commit(moveServer(reconciled(), host, { type: "into", folderId: folder.id }));
    },
  }));
}

/** A server's menu items for where it is drawn: `serverMenu` with the place's axis, plus Move to start ("more") and Move to {folder} (loose servers). */
export function serverItems(
  host: string,
  place: MenuPlace,
  ctx: TabMenuContext,
): ContextMenuItem[] {
  const items = serverMenu(host, ctx.ctl.mutations, { axis: axisOf(place) });
  if (place === "member") return items;
  if (place === "more") items.push(moveToStart({ kind: "server", host }, ctx));
  return [...items, ...moveToFolders(host, ctx)];
}

/** A folder's menu items: `folderMenu` with the place's axis and `collapsible: false`, plus Move to start ("more"). */
export function folderItems(
  folder: FolderItem,
  place: Exclude<MenuPlace, "member">,
  ctx: TabMenuContext,
): ContextMenuItem[] {
  const items = folderMenu(folder, ctx.ctl.mutations, {
    axis: axisOf(place),
    collapsible: false,
  });
  if (place === "more") items.push(moveToStart({ kind: "folder", id: folder.id }, ctx));
  return items;
}

/** The folder `id` as the menus act on it: the full layout, else what is drawn. */
function findFolder(ctl: RailController, id: string): FolderItem | null {
  for (const layout of [ctl.mutations.reconciled(), ctl.layout()]) {
    const found = layout.find((i): i is FolderItem => i.kind === "folder" && i.id === id);
    if (found !== undefined) return found;
  }
  return null;
}

/** Opens an item's own menu at (x, y) through `ctx.open`, with `fit: "scroll"` for a server and the default for a folder. */
export function openItemMenu(
  ref: ItemRef,
  place: MenuPlace,
  at: Point,
  opener: Opener,
  ctx: TabMenuContext,
): void {
  const { ctl } = ctx;
  let items: ContextMenuItem[];
  let ariaLabel: string;
  if (ref.kind === "server") {
    items = serverItems(ref.host, place, ctx);
    ariaLabel = ctl.look(ref.host).name;
  } else {
    const folder = findFolder(ctl, ref.id);
    if (folder === null) return;
    items = folderItems(folder, place === "member" ? "row" : place, ctx);
    ariaLabel = folderName(folder);
  }
  ctx.open({
    openerKey: opener.key,
    opener: opener.el,
    fromRow: opener.fromRow,
    show: (onClosed) =>
      showContextMenu({
        x: at.x,
        y: at.y,
        items,
        signal: ctl.signal,
        className: MENU_CLASS,
        ariaLabel,
        onClosed,
        ...(ref.kind === "server" ? { fit: "scroll" as const } : {}),
      }),
  });
}

/** One server row of a dropdown or list: its icon and name, a switch on click, its menu on right-click. */
function serverRow(
  host: string,
  place: MenuPlace,
  menuOpener: Opener,
  close: () => void,
  signal: AbortSignal,
  ctx: TabMenuContext,
): HTMLElement {
  const { ctl } = ctx;
  const { name, color } = ctl.look(host);
  const label = serverLabel(ctl, host);
  const row = createElement("button", {
    type: "button",
    class: `${ROW_CLASS} server-tabs-menu-server`,
    role: "menuitemradio",
    "aria-checked": String(host === ctl.currentHost),
    tabindex: "-1",
    "aria-label": label,
    title: label,
    "data-testid": place === "member" ? "server-tab-folder-item" : "server-tab-menu-server",
    "data-host": host,
  });
  row.append(
    serverAvatar(name, color, false, ctl.icon(host)),
    createElement("span", { class: "server-tabs-menu-name" }, name),
  );
  const ref: ItemRef = { kind: "server", host };
  const rowOpener: Opener = { ...menuOpener, fromRow: true };
  row.addEventListener(
    "click",
    () => {
      close();
      ctx.activate(host);
    },
    { signal },
  );
  row.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      openItemMenu(ref, place, { x: e.clientX, y: e.clientY }, rowOpener, ctx);
    },
    { signal },
  );
  openMenuOnKeyboard(row, (x, y) => openItemMenu(ref, place, { x, y }, rowOpener, ctx), signal);
  return row;
}

let headingSeq = 0;

/** A folder inside a scrolling list: a heading row that opens the folder's menu, then a group of its members. */
function folderRows(
  folder: FolderItem,
  place: "more" | "servers",
  menuOpener: Opener,
  close: () => void,
  signal: AbortSignal,
  ctx: TabMenuContext,
): HTMLElement[] {
  const id = `server-tabs-heading-${++headingSeq}`;
  const label = folderLabel(folder, ctx.ctl.currentHost);
  const heading = createElement("button", {
    type: "button",
    id,
    class: `${ROW_CLASS} server-tabs-menu-folder`,
    role: "menuitem",
    tabindex: "-1",
    "aria-haspopup": "menu",
    "aria-label": label,
    title: label,
    "data-testid": "server-tab-menu-folder",
    "data-folder-id": folder.id,
  });
  heading.style.setProperty("--folder-color", folder.color);
  const glyph = createElement("span", { class: "server-tab-glyph", "aria-hidden": "true" });
  glyph.appendChild(railIcon("folder"));
  heading.append(
    glyph,
    createElement("span", { class: "server-tabs-menu-name" }, folderName(folder)),
    createElement("span", { class: "server-tab-count" }, String(folder.hosts.length)),
  );
  const ref: ItemRef = { kind: "folder", id: folder.id };
  const rowOpener: Opener = { ...menuOpener, fromRow: true };
  const openAt = (at: Point): void => openItemMenu(ref, place, at, rowOpener, ctx);
  heading.addEventListener("click", () => openAt(belowStart(heading)), { signal });
  heading.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      openAt({ x: e.clientX, y: e.clientY });
    },
    { signal },
  );
  openMenuOnKeyboard(heading, (x, y) => openAt({ x, y }), signal);
  const group = createElement("div", { role: "group", "aria-labelledby": id });
  for (const host of folder.hosts) {
    group.appendChild(serverRow(host, "member", menuOpener, close, signal, ctx));
  }
  return [heading, group];
}

/** A folder tab's dropdown: its members, each with its own menu, then Folder options. */
export function openFolderDropdown(
  folder: FolderItem,
  tab: HTMLElement,
  ctx: TabMenuContext,
): void {
  const name = folderName(folder);
  const key = `folder:${folder.id}`;
  const at = belowStart(tab);
  ctx.open({
    openerKey: key,
    opener: tab,
    fromRow: false,
    show: (onClosed) =>
      openMenuShell({
        x: at.x,
        y: at.y,
        className: MENU_CLASS,
        attrs: { "aria-label": name, "data-testid": "server-tab-folder-menu" },
        signal: ctx.ctl.signal,
        onClosed,
        build: (menu, close, signal) => {
          const opener: Opener = { key, el: tab, fromRow: false };
          menu.appendChild(
            createElement(
              "div",
              { class: "server-tabs-menu-heading", "aria-hidden": "true" },
              name,
            ),
          );
          for (const host of folder.hosts) {
            menu.appendChild(serverRow(host, "member", opener, close, signal, ctx));
          }
          menu.appendChild(createElement("div", { class: "context-menu-sep", role: "separator" }));
          const options = createMenuItem(serverRailText("folderMenu"), ROW_CLASS, {
            testId: "server-tab-folder-options",
          });
          options.addEventListener(
            "click",
            () =>
              openItemMenu(
                { kind: "folder", id: folder.id },
                "row",
                belowStart(tab),
                {
                  ...opener,
                  fromRow: true,
                },
                ctx,
              ),
            { signal },
          );
          menu.appendChild(options);
        },
      }),
  });
}

/** Add a server and Join with an invite link, in every list that offers them. */
export const ADD_JOIN: ReadonlyArray<{
  readonly key: "add" | "join";
  readonly icon: IconName;
  readonly testId: string;
  readonly act: (ctl: RailController) => void;
}> = [
  { key: "add", icon: "plus", testId: "server-tabs-add-server", act: (ctl) => ctl.add() },
  { key: "join", icon: "link", testId: "server-tabs-join", act: (ctl) => ctl.openJoin() },
];

/** Add and Join as menu items, for the "+" menu and the Servers sheet. */
export function addJoinItems(ctl: RailController): ContextMenuItem[] {
  return ADD_JOIN.map(({ key, icon, testId, act }) => ({
    label: serverRailText(key),
    icon,
    testId,
    onClick: () => act(ctl),
  }));
}

/** The Servers list's last rows: Add a server and Join with an invite link. */
function addJoinRows(close: () => void, signal: AbortSignal, ctl: RailController): HTMLElement[] {
  return ADD_JOIN.map(({ key, testId, act }) => {
    const row = createMenuItem(serverRailText(key), ROW_CLASS, { testId });
    row.addEventListener(
      "click",
      () => {
        close();
        act(ctl);
      },
      { signal },
    );
    return row;
  });
}

/** "+N" (the hidden top-level items) or Servers (every item, then Add and Join). */
export function openItemList(
  kind: "more" | "servers",
  items: readonly RailItem[],
  button: HTMLElement,
  ctx: TabMenuContext,
): void {
  if (kind === "servers" && isPhoneLayout()) {
    // A phone gets the list as a bottom sheet; the module imports this one.
    void import("./serverSheet").then(
      ({ openServerSheet }) => openServerSheet(ctx, items, button),
      (err: unknown) => log.warn("Servers sheet failed to load", { error: String(err) }),
    );
    return;
  }
  const at = belowStart(button);
  const ariaLabel =
    kind === "more" ? serverRailText("moreTabs", { count: items.length }) : serverRailText("label");
  ctx.open({
    openerKey: kind,
    opener: button,
    fromRow: false,
    show: (onClosed) =>
      openMenuShell({
        x: at.x,
        y: at.y,
        className: MENU_CLASS,
        attrs: {
          "aria-label": ariaLabel,
          "data-testid": kind === "more" ? "server-tabs-more-menu" : "deck-servers-menu",
        },
        signal: ctx.ctl.signal,
        fit: "scroll",
        onClosed,
        build: (menu, close, signal) => {
          const opener: Opener = { key: kind, el: button, fromRow: false };
          for (const item of items) {
            if (item.kind === "server") {
              menu.appendChild(serverRow(item.host, kind, opener, close, signal, ctx));
            } else {
              menu.append(...folderRows(item, kind, opener, close, signal, ctx));
            }
          }
          if (kind === "more") return;
          menu.appendChild(createElement("div", { class: "context-menu-sep", role: "separator" }));
          menu.append(...addJoinRows(close, signal, ctx.ctl));
        },
      }),
  });
}

/** "+": Add a server and Join with an invite link. */
export function openAddMenu(button: HTMLElement, ctx: TabMenuContext): void {
  const at = belowStart(button);
  const { ctl } = ctx;
  ctx.open({
    openerKey: "add",
    opener: button,
    fromRow: false,
    show: (onClosed) =>
      showContextMenu({
        x: at.x,
        y: at.y,
        items: addJoinItems(ctl),
        signal: ctl.signal,
        className: MENU_CLASS,
        ariaLabel: serverRailText("addMenu"),
        onClosed,
      }),
  });
}

/** The 10-12 px chevron a tab or button that opens a list ends with. */
export function chevron(size: number): SVGSVGElement {
  const icon = createIcon("chevron-down", size);
  icon.classList.add("server-tab-chevron");
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
