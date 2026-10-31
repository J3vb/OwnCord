/**
 * One right-click menu at a time (MX-6). Before the shared shell, the sidebar
 * menus closed only on a left click, so right-clicking a voice user, a member
 * or a video tile opened a second menu beside them; and a menu opened from the
 * keyboard (no mousedown at all) left any open menu in place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    getUserVolume: vi.fn(() => 100),
  }),
);

const { showContextMenu, openMenuShell } = await import("@lib/ui/contextMenu");
const { attachThreadContextMenu } = await import("@components/channel-sidebar/threadMenu");
const { showUserVolumeMenu } = await import("@components/channel-sidebar/volumeMenu");
const { showSelfTileMenu } = await import("@components/video-grid/tileMenu");
const { createMemberContextMenu } = await import("@components/AdminActions");

const menus = (): Element[] => [...document.querySelectorAll(".context-menu")];

let owner: AbortController;

beforeEach(() => {
  owner = new AbortController();
});

afterEach(() => {
  owner.abort();
  document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  document.body.replaceChildren();
});

/** A followed-thread row with its menu attached, as the sidebar wires it. */
function threadRow(): HTMLElement {
  const row = document.createElement("div");
  row.tabIndex = 0;
  document.body.appendChild(row);
  attachThreadContextMenu(
    row,
    { hasUnread: () => true, onMarkRead: vi.fn(), onUnfollow: vi.fn() },
    owner.signal,
    owner.signal,
  );
  return row;
}

const rightClick = (el: HTMLElement): void => {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
};

const shiftF10 = (el: HTMLElement): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
};

const member = (): ReturnType<typeof createMemberContextMenu> =>
  createMemberContextMenu({
    x: 40,
    y: 40,
    userId: 2,
    username: "Bob",
    currentRole: "member",
    availableRoles: ["member"],
    showAdminActions: false,
    isBlocked: false,
    onToggleBlock: vi.fn(async () => {}),
    onKick: vi.fn(async () => {}),
    onBan: vi.fn(),
    onChangeRole: vi.fn(async () => {}),
  });

describe("one open menu", () => {
  it("a sidebar menu closes when a voice user's menu opens", () => {
    rightClick(threadRow());
    expect(document.querySelector('[data-testid="thread-context-menu"]')).not.toBeNull();

    showUserVolumeMenu(7, "Alice", 30, 30, owner.signal);

    expect(menus()).toHaveLength(1);
    expect(menus()[0]!.classList.contains("user-vol-menu")).toBe(true);
  });

  it("every kind of menu replaces the one before it", () => {
    const row = threadRow();
    const opens: [string, () => void][] = [
      ["thread", () => rightClick(row)],
      ["volume", () => showUserVolumeMenu(7, "Alice", 30, 30, owner.signal)],
      ["tile", () => showSelfTileMenu({ x: 50, y: 50, signal: owner.signal, onHide: vi.fn() })],
      ["member", () => void member()],
      [
        "message",
        () =>
          showContextMenu({
            x: 60,
            y: 60,
            className: "message-context-menu",
            items: [{ label: "Reply", onClick: vi.fn() }],
            signal: owner.signal,
          }),
      ],
      ["thread again", () => shiftF10(row)],
    ];
    for (const [name, open] of opens) {
      open();
      expect(menus(), `after opening the ${name} menu`).toHaveLength(1);
    }
  });

  it("a menu opened by keyboard closes the open one", () => {
    showUserVolumeMenu(7, "Alice", 30, 30, owner.signal);
    shiftF10(threadRow());

    expect(menus()).toHaveLength(1);
    expect(document.querySelector('[data-testid="thread-context-menu"]')).not.toBeNull();
  });
});

describe("focus across a replaced menu", () => {
  it("returns to the first menu's row, not to the page, when a second menu replaces it", async () => {
    const first = threadRow();
    first.focus();
    shiftF10(first);
    await Promise.resolve();
    const firstMenu = document.querySelector('[data-testid="thread-context-menu"]')!;
    expect(firstMenu.contains(document.activeElement)).toBe(true);

    rightClick(threadRow());
    const second = document.querySelector<HTMLElement>('[data-testid="thread-context-menu"]')!;
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(menus()).toEqual([]);
    expect(document.activeElement).toBe(first);
  });
});

describe("openMenuShell", () => {
  const open = (onClosed = vi.fn(), signal: AbortSignal = owner.signal) =>
    openMenuShell({
      x: 10,
      y: 10,
      signal,
      onClosed,
      build: (menu) => {
        const row = document.createElement("button");
        row.setAttribute("role", "menuitem");
        menu.appendChild(row);
      },
    });

  it("a superseded menu's late close leaves its successor open and registered", () => {
    const first = open();
    const second = open();
    expect(first.element.isConnected).toBe(false);

    first.destroy();
    expect(second.element.isConnected).toBe(true);

    // The successor still holds the slot: the next open closes it.
    const third = open();
    expect(second.element.isConnected).toBe(false);
    expect(menus()).toEqual([third.element]);
  });

  it("closes once, and frees the slot, when its owner goes away", () => {
    const onClosed = vi.fn();
    const lifetime = new AbortController();
    const menu = open(onClosed, lifetime.signal);

    lifetime.abort();
    menu.destroy();

    expect(menu.element.isConnected).toBe(false);
    expect(onClosed).toHaveBeenCalledOnce();
    const next = open();
    expect(menus()).toEqual([next.element]);
  });

  it("mounts nothing for an owner already gone, but still closes the open menu", () => {
    const before = open();
    const onClosed = vi.fn();
    const gone = AbortSignal.abort();

    const menu = open(onClosed, gone);

    expect(before.element.isConnected).toBe(false);
    expect(menu.element.isConnected).toBe(false);
    expect(menus()).toEqual([]);
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("a superseded menu tells its owner it closed", () => {
    const onClosed = vi.fn();
    open(onClosed);
    open();
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
