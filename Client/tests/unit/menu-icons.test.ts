import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  showContextMenu,
  openMenuShell,
  createMenuItem,
  setMenuItemLabel,
  type ContextMenuOptions,
} from "../../src/lib/ui/contextMenu";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { openMenuSheet } from "../../src/features/menus/menuSheet";
import { openMessageSheet } from "../../src/features/messaging/message-list/messageSheet";
import { cascadedDeclaration, hasRule, varToken, type CssDeclaration } from "../helpers/app-css";

let ac: AbortController;

/** A CSS-wide keyword such as `inherit`, which Lightning CSS keeps as one raw ident. */
function cssWideKeyword(d: CssDeclaration | undefined): string | undefined {
  const v = d?.value;
  if (v?.property !== "unparsed" || v.value.value.length !== 1) return undefined;
  const t = v.value.value[0]!;
  return t.type === "token" && t.value.type === "ident" ? t.value.value : undefined;
}

function openMenu(items: ContextMenuOptions["items"]): HTMLElement {
  showContextMenu({ x: 0, y: 0, items, signal: ac.signal });
  return document.querySelector<HTMLElement>(".context-menu")!;
}

const slotOf = (row: Element): HTMLElement | null =>
  row.querySelector<HTMLElement>(":scope > .menu-item-icon");
const iconOf = (row: Element): string | null =>
  slotOf(row)?.querySelector("svg")?.getAttribute("data-icon") ?? null;

beforeEach(() => {
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  closeBottomSheet();
  document.querySelectorAll(".context-menu").forEach((el) => el.remove());
});

describe("menu row icons", () => {
  it("leads a row with its icon, hidden from assistive tech, keeping the label as its name", () => {
    const menu = openMenu([{ label: "Reply", icon: "reply", onClick: vi.fn() }]);
    const row = menu.querySelector<HTMLElement>(".context-menu-item")!;
    expect(row.firstElementChild).toBe(slotOf(row));
    expect(iconOf(row)).toBe("reply");
    expect(slotOf(row)!.getAttribute("aria-hidden")).toBe("true");
    expect(row.textContent).toBe("Reply");
    expect(row.getAttribute("role")).toBe("menuitem");
  });

  it("gives a row with no icon an empty slot, so its label lines up with the rest", () => {
    const onClick = vi.fn();
    const menu = openMenu([
      { label: "Reply", icon: "reply", onClick: vi.fn() },
      { label: "Copy Message ID", testId: "plain", onClick },
    ]);
    const plain = menu.querySelector<HTMLElement>('[data-testid="plain"]')!;
    const slot = slotOf(plain);
    expect(slot).not.toBeNull();
    expect(slot!.childElementCount).toBe(0);
    expect(slot!.getAttribute("aria-hidden")).toBe("true");
    expect(plain.textContent).toBe("Copy Message ID");
    plain.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("adds no slot to a menu where no row has an icon", () => {
    const menu = openMenu([
      { label: "One", onClick: vi.fn() },
      { label: "Two", onClick: vi.fn() },
    ]);
    expect(menu.querySelector(".menu-item-icon")).toBeNull();
  });

  it("keeps a destructive row's danger styling and draws its icon in that colour", () => {
    const menu = openMenu([
      { label: "Reply", icon: "reply", onClick: vi.fn() },
      { separator: true },
      { label: "Delete Message", icon: "trash-2", danger: true, testId: "del", onClick: vi.fn() },
    ]);
    const del = menu.querySelector<HTMLElement>('[data-testid="del"]')!;
    expect(del.classList.contains("danger")).toBe(true);
    expect(iconOf(del)).toBe("trash-2");
    // A normal row's icon is muted; a danger row's takes the row's own red.
    expect(varToken(cascadedDeclaration(".menu-item-icon", "color"))).toBe("--text-muted");
    expect(hasRule(".context-menu-item.danger > .menu-item-icon")).toBe(true);
    expect(
      cssWideKeyword(cascadedDeclaration(".context-menu-item.danger > .menu-item-icon", "color")),
    ).toBe("inherit");
    expect(varToken(cascadedDeclaration(".context-menu-item.danger", "color"))).toBe(
      "--text-danger",
    );
  });

  it("leaves the emoji row of a group without a slot", () => {
    const emoji = document.createElement("span");
    emoji.textContent = "👍";
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      group: { start: 0, count: 1 },
      items: [
        { label: "React", content: emoji, icon: "smile", onClick: vi.fn() },
        { label: "Reply", icon: "reply", onClick: vi.fn() },
      ],
    });
    const quick = document.querySelector<HTMLElement>(".context-menu-group > *")!;
    expect(slotOf(quick)).toBeNull();
    expect(quick.textContent).toBe("👍");
  });

  it("keeps the arrow keys, the check state and the submenu arrow working on iconed rows", async () => {
    const menu = openMenu([
      { label: "Invite People", icon: "user-plus", testId: "a", onClick: vi.fn() },
      {
        label: "Hide Muted Channels",
        icon: "eye-off",
        checked: true,
        testId: "b",
        onClick: vi.fn(),
      },
      {
        label: "Mute Channel",
        icon: "bell-off",
        testId: "c",
        onClick: vi.fn(),
        submenu: [{ label: "For 15 Minutes", onClick: vi.fn() }],
      },
    ]);
    const row = (id: string): HTMLElement =>
      menu.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(row("a"));
    row("a").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(row("b"));
    expect(row("b").getAttribute("aria-checked")).toBe("true");
    expect(iconOf(row("c"))).toBe("bell-off");
    expect(row("c").classList.contains("context-menu-item--flyout")).toBe(true);
    // The flyout's rows have no icons, so they get no slots.
    expect(menu.querySelector(".context-menu__submenu .menu-item-icon")).toBeNull();
  });

  it("aligns a hand-built menu and keeps the icon when a row's label changes", () => {
    let iconed: HTMLElement | null = null;
    let plain: HTMLElement | null = null;
    const open = openMenuShell({
      x: 0,
      y: 0,
      signal: ac.signal,
      build: (menu) => {
        iconed = createMenuItem("Block", "context-menu__item", { icon: "user-x" });
        plain = createMenuItem("Copy User ID", "context-menu__item");
        menu.append(iconed, plain);
      },
    });
    expect(slotOf(plain!)).not.toBeNull();
    setMenuItemLabel(iconed!, "Are you sure?");
    expect(iconOf(iconed!)).toBe("user-x");
    expect(iconed!.textContent).toBe("Are you sure?");
    setMenuItemLabel(plain!, "Working…");
    expect(slotOf(plain!)).not.toBeNull();
    expect(plain!.textContent).toBe("Working…");
    open.destroy();
  });
});

const sheetRow = (sheet: string, id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${sheet}"] [data-testid="${id}"]`)!;

describe("sheet row icons", () => {
  it("draws each menu sheet row's icon and reserves the column for a row without one", () => {
    openMenuSheet({
      items: [
        { label: "Invite People", icon: "user-plus", testId: "invite", onClick: vi.fn() },
        { label: "No Icon", testId: "bare", onClick: vi.fn() },
        { separator: true },
        { label: "Delete Channel", icon: "trash-2", danger: true, testId: "del", onClick: vi.fn() },
      ],
      label: "Menu",
      testId: "icon-sheet",
      signal: ac.signal,
      fallbackFocus: () => null,
    });
    expect(iconOf(sheetRow("icon-sheet", "invite"))).toBe("user-plus");
    expect(slotOf(sheetRow("icon-sheet", "bare"))!.childElementCount).toBe(0);
    expect(sheetRow("icon-sheet", "bare").textContent).toBe("No Icon");
    expect(sheetRow("icon-sheet", "del").classList.contains("danger")).toBe(true);
    expect(iconOf(sheetRow("icon-sheet", "del"))).toBe("trash-2");
    expect(sheetRow("icon-sheet", "del").querySelector("svg")!.getAttribute("width")).toBe("20");
  });

  it("puts icons on the message sheet's action rows but not on its quick reactions", () => {
    const emoji = document.createElement("span");
    emoji.textContent = "👍";
    openMessageSheet({
      items: [
        { label: "React", content: emoji, testId: "q", onClick: vi.fn() },
        { label: "Add Reaction", icon: "smile", testId: "msg-menu-add-reaction", onClick: vi.fn() },
        { separator: true },
        { label: "Reply", icon: "reply", testId: "reply", onClick: vi.fn() },
        { label: "Plain", testId: "plain", onClick: vi.fn() },
        { separator: true },
        { label: "Delete Message", icon: "trash-2", danger: true, testId: "del", onClick: vi.fn() },
      ],
      group: { start: 0, count: 1 },
      label: "Message actions",
      groupLabel: "Quick reactions",
      signal: ac.signal,
      fallbackFocus: () => null,
      onClosed: () => undefined,
    });
    expect(slotOf(sheetRow("message-sheet", "q"))).toBeNull();
    expect(slotOf(sheetRow("message-sheet", "msg-menu-add-reaction"))).toBeNull();
    expect(iconOf(sheetRow("message-sheet", "reply"))).toBe("reply");
    expect(sheetRow("message-sheet", "reply").textContent).toBe("Reply");
    expect(slotOf(sheetRow("message-sheet", "plain"))!.childElementCount).toBe(0);
    expect(sheetRow("message-sheet", "del").classList.contains("danger")).toBe(true);
    expect(iconOf(sheetRow("message-sheet", "del"))).toBe("trash-2");
  });
});
