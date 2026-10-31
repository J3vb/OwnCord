import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  showContextMenu,
  createSubmenuTrigger,
  type ContextMenuOptions,
} from "../../src/lib/ui/contextMenu";

let ac: AbortController;

function openMenu(
  items: ContextMenuOptions["items"],
  extra: Partial<ContextMenuOptions> = {},
): void {
  showContextMenu({ x: 0, y: 0, items, signal: ac.signal, ...extra });
}

describe("showContextMenu", () => {
  beforeEach(() => {
    ac = new AbortController();
    // Clean up any leftover menus
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  afterEach(() => {
    ac.abort();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  it("renders menu at correct position", () => {
    openMenu([{ label: "Test", onClick: vi.fn() }], { x: 100, y: 200 });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("200px");
  });

  it("renders all items", () => {
    openMenu([
      { label: "Edit", onClick: vi.fn() },
      { label: "Delete", onClick: vi.fn(), danger: true },
    ]);

    const items = document.querySelectorAll(".context-menu-item");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toBe("Edit");
    expect(items[1]!.textContent).toBe("Delete");
  });

  it("fires onClick when item clicked", () => {
    const onClick = vi.fn();
    openMenu([{ label: "Action", onClick }]);

    const item = document.querySelector(".context-menu-item") as HTMLElement;
    item.click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("removes menu after item click", () => {
    openMenu([{ label: "Action", onClick: vi.fn() }]);

    const item = document.querySelector(".context-menu-item") as HTMLElement;
    item.click();

    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("applies danger class to danger items", () => {
    openMenu([{ label: "Delete", onClick: vi.fn(), danger: true }]);

    const item = document.querySelector(".context-menu-item") as HTMLElement;
    expect(item.classList.contains("danger")).toBe(true);
  });

  it("applies testId to items", () => {
    openMenu([{ label: "Edit", onClick: vi.fn(), testId: "ctx-edit" }]);

    const item = document.querySelector('[data-testid="ctx-edit"]');
    expect(item).not.toBeNull();
  });

  it("removes menu on AbortSignal abort", () => {
    openMenu([{ label: "Test", onClick: vi.fn() }]);

    expect(document.querySelector(".context-menu")).not.toBeNull();

    ac.abort();

    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("removes existing menu with same className before showing new one", () => {
    openMenu([{ label: "First", onClick: vi.fn() }], { className: "my-menu" });

    openMenu([{ label: "Second", onClick: vi.fn() }], { x: 50, y: 50, className: "my-menu" });

    const menus = document.querySelectorAll(".my-menu");
    expect(menus.length).toBe(1);
    expect(menus[0]!.querySelector(".context-menu-item")!.textContent).toBe("Second");
  });

  it('uses default className "context-menu" when none specified', () => {
    openMenu([{ label: "Default", onClick: vi.fn() }], { x: 10, y: 20 });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("context-menu")).toBe(true);
  });

  it("adds separator before danger item when preceded by non-danger item", () => {
    openMenu([
      { label: "Edit", onClick: vi.fn() },
      { label: "Delete", onClick: vi.fn(), danger: true },
    ]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const sep = menu.querySelector(".context-menu-sep");
    expect(sep).not.toBeNull();
  });

  it("does not add separator when danger item is first", () => {
    openMenu([{ label: "Delete", onClick: vi.fn(), danger: true }]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const sep = menu.querySelector(".context-menu-sep");
    expect(sep).toBeNull();
  });

  it("does not add separator between consecutive danger items", () => {
    openMenu([
      { label: "Delete", onClick: vi.fn(), danger: true },
      { label: "Ban", onClick: vi.fn(), danger: true },
    ]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const seps = menu.querySelectorAll(".context-menu-sep");
    expect(seps.length).toBe(0);
  });

  it("handles multiple non-danger items without separator", () => {
    openMenu([
      { label: "Copy", onClick: vi.fn() },
      { label: "Edit", onClick: vi.fn() },
      { label: "Reply", onClick: vi.fn() },
    ]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const seps = menu.querySelectorAll(".context-menu-sep");
    expect(seps.length).toBe(0);
  });

  it("closes menu on click outside (mousedown)", async () => {
    openMenu([{ label: "Test", onClick: vi.fn() }]);

    expect(document.querySelector(".context-menu")).not.toBeNull();

    // Trigger the deferred mousedown listener (needs setTimeout to fire first)
    await vi.waitFor(() => {
      // Simulate a click outside the menu
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(document.querySelector(".context-menu")).toBeNull();
    });
  });

  it("does not close menu on mousedown inside the menu", async () => {
    openMenu([{ label: "Test", onClick: vi.fn() }]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();

    // Wait for the deferred listener to register
    await new Promise((r) => setTimeout(r, 10));

    // Mousedown inside the menu should NOT close it
    const item = menu.querySelector(".context-menu-item") as HTMLElement;
    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: item });
    document.dispatchEvent(event);

    expect(document.querySelector(".context-menu")).not.toBeNull();
  });

  it("keeps the menu inside the viewport when the anchor is near an edge (F9)", () => {
    // A short window puts a menu opened near the bottom/right edge partly
    // off-screen, leaving its last actions unclickable. jsdom has no layout,
    // so stub the measured size.
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 300,
    });
    try {
      openMenu([{ label: "Purge", onClick: vi.fn(), danger: true }], {
        x: innerWidth - 10,
        y: innerHeight - 10,
      });

      const menu = document.querySelector(".context-menu") as HTMLElement;
      expect(parseInt(menu.style.left, 10)).toBeLessThanOrEqual(innerWidth - 200);
      expect(menu.style.bottom).not.toBe("");
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetWidth"];
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetHeight"];
    }
  });

  it("never pushes a tall menu past the top of a short window", () => {
    vi.stubGlobal("innerWidth", 940);
    vi.stubGlobal("innerHeight", 500);
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 300,
    });
    try {
      openMenu([{ label: "Mark read", onClick: vi.fn() }], { x: 100, y: 250 });

      const menu = document.querySelector(".context-menu") as HTMLElement;
      // Spans y 8..308: its first item stays reachable.
      expect(menu.style.top).toBe("");
      expect(menu.style.bottom).toBe("192px");
    } finally {
      vi.unstubAllGlobals();
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetWidth"];
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetHeight"];
    }
  });

  it("handles empty items list", () => {
    openMenu([]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.querySelectorAll(".context-menu-item").length).toBe(0);
  });

  it("clicking one item does not affect other items", () => {
    const onClick1 = vi.fn();
    const onClick2 = vi.fn();
    openMenu([
      { label: "Action1", onClick: onClick1 },
      { label: "Action2", onClick: onClick2 },
    ]);

    const items = document.querySelectorAll(".context-menu-item");
    (items[0] as HTMLElement).click();

    expect(onClick1).toHaveBeenCalledTimes(1);
    expect(onClick2).not.toHaveBeenCalled();
  });

  it("handles non-danger item followed by danger item with separator", () => {
    openMenu([
      { label: "Copy", onClick: vi.fn() },
      { label: "Edit", onClick: vi.fn() },
      { label: "Delete", onClick: vi.fn(), danger: true },
    ]);

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const children = Array.from(menu.children);
    // Should have: Copy, Edit, separator, Delete
    expect(children.length).toBe(4);
    expect(children[2]!.classList.contains("context-menu-sep")).toBe(true);
  });

  it("menu is appended to document.body", () => {
    openMenu([{ label: "Appended", onClick: vi.fn() }], { x: 100, y: 200 });

    const menu = document.body.querySelector(".context-menu");
    expect(menu).not.toBeNull();
  });

  describe("abort-listener teardown on the caller signal", () => {
    it("does not re-invoke menu cleanup off the caller signal after the menu was already dismissed", () => {
      openMenu([{ label: "Action", onClick: vi.fn() }], { className: "oc0057-menu-a" });

      const menu = document.querySelector(".oc0057-menu-a") as HTMLElement;
      expect(menu).not.toBeNull();

      // Dismiss the menu through the normal item-click path (NOT via ac.abort()).
      const item = menu.querySelector(".context-menu-item") as HTMLElement;
      const removeSpy = vi.spyOn(menu, "remove");
      item.click();
      expect(removeSpy).toHaveBeenCalledTimes(1);

      // The component that owns `ac` is destroyed sometime later. A correctly
      // torn-down showContextMenu invocation must have released its "abort"
      // listener on `ac.signal` when the menu was dismissed above, so this
      // must NOT invoke the stale closure's menu.remove() a second time.
      ac.abort();

      expect(removeSpy).toHaveBeenCalledTimes(1);
    });

    it("does not accumulate a live abort listener on the caller signal per invocation", () => {
      // Open and dismiss (via item click) several menus on the same
      // long-lived caller signal, as DmSidebar does across repeated
      // right-clicks without the sidebar being rebuilt.
      const menus: HTMLElement[] = [];
      for (let i = 0; i < 3; i++) {
        openMenu([{ label: "Action", onClick: vi.fn() }], { className: "oc0057-menu-b" });
        const menu = document.querySelector(".oc0057-menu-b") as HTMLElement;
        menus.push(menu);
        const item = menu.querySelector(".context-menu-item") as HTMLElement;
        item.click();
      }

      const removeSpies = menus.map((m) => vi.spyOn(m, "remove"));

      // Simulate the parent component finally being destroyed.
      ac.abort();

      // None of the already-dismissed menus' remove() should fire again —
      // each invocation's abort listener should have been released when that
      // specific menu was dismissed, not held until component teardown.
      for (const spy of removeSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it("cleans up immediately when the signal is already aborted before the menu is shown", () => {
      ac.abort();

      openMenu([{ label: "Action", onClick: vi.fn() }], { className: "oc0057-menu-c" });

      // An already-aborted parent signal means the menu must never be left
      // dangling in the DOM — "abort" already fired before we could listen
      // for it, so the code must check signal.aborted explicitly.
      expect(document.querySelector(".oc0057-menu-c")).toBeNull();
    });

    it("releases the old menu's abort listener when it is swept away by a same-class reopen", () => {
      openMenu([{ label: "First", onClick: vi.fn() }], { className: "oc0057-menu-d" });

      const firstMenu = document.querySelector(".oc0057-menu-d") as HTMLElement;
      expect(firstMenu).not.toBeNull();
      const removeSpy = vi.spyOn(firstMenu, "remove");

      // Reopening with the same className sweeps the first menu out via the
      // querySelectorAll(...).remove() path at the top of the function, not
      // via item click or outside click.
      openMenu([{ label: "Second", onClick: vi.fn() }], {
        x: 10,
        y: 10,
        className: "oc0057-menu-d",
      });

      expect(removeSpy).toHaveBeenCalledTimes(1);

      // The parent component is destroyed later. The swept-away first menu's
      // abort listener must have been released at sweep time, not left
      // pinned on `ac.signal` until now.
      ac.abort();

      expect(removeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("keyboard model (A11Y-01)", () => {
    async function open(items: Parameters<typeof showContextMenu>[0]["items"]) {
      showContextMenu({ x: 0, y: 0, items, signal: ac.signal, className: "kbd-menu" });
      await new Promise((r) => setTimeout(r, 0));
      return document.querySelector(".kbd-menu") as HTMLElement;
    }

    it("renders role=menu items and focuses the first one on open", async () => {
      const menu = await open([
        { label: "One", onClick: vi.fn() },
        { label: "Two", onClick: vi.fn() },
      ]);
      expect(menu.getAttribute("role")).toBe("menu");
      const items = menu.querySelectorAll('[role="menuitem"]');
      expect(items.length).toBe(2);
      expect(items[0]!.tagName).toBe("BUTTON");
      expect(document.activeElement).toBe(items[0]);
      expect(items[0]!.getAttribute("tabindex")).toBe("0");
      expect(items[1]!.getAttribute("tabindex")).toBe("-1");
    });

    it("moves with ArrowDown/ArrowUp and Home/End, moving the roving tabindex", async () => {
      const menu = await open([
        { label: "One", onClick: vi.fn() },
        { label: "Two", onClick: vi.fn() },
        { label: "Three", onClick: vi.fn() },
      ]);
      const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
      items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(document.activeElement).toBe(items[1]);
      expect(items[1]!.getAttribute("tabindex")).toBe("0");
      expect(items[0]!.getAttribute("tabindex")).toBe("-1");
      items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      expect(document.activeElement).toBe(items[2]);
      items[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect(document.activeElement).toBe(items[0]);
      items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect(document.activeElement).toBe(items[0]);
    });

    it("activates a row with Enter through its native button click", async () => {
      const onClick = vi.fn();
      await open([{ label: "Go", onClick }]);
      const item = document.querySelector<HTMLElement>('.kbd-menu [role="menuitem"]')!;
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      item.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("Escape closes the menu and restores focus to the element focused at open", async () => {
      const invoker = document.createElement("button");
      document.body.appendChild(invoker);
      invoker.focus();
      await open([{ label: "One", onClick: vi.fn() }]);
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(document.querySelector(".kbd-menu")).toBeNull();
      expect(document.activeElement).toBe(invoker);
      invoker.remove();
    });

    it("an outside click that moved focus to a control keeps it there", async () => {
      const invoker = document.createElement("button");
      const input = document.createElement("input");
      document.body.append(invoker, input);
      invoker.focus();
      await open([{ label: "One", onClick: vi.fn() }]);
      input.focus();
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(document.querySelector(".kbd-menu")).toBeNull();
      expect(document.activeElement).toBe(input);
      invoker.remove();
      input.remove();
    });

    it("separator entry renders a divider and no menu item", async () => {
      const menu = await open([
        { label: "One", onClick: vi.fn() },
        { separator: true },
        { label: "Two", onClick: vi.fn(), danger: true },
      ]);
      expect(menu.querySelectorAll('[role="menuitem"]').length).toBe(2);
      // The explicit divider stands in for the automatic one before a danger row.
      expect(menu.querySelectorAll(".context-menu-sep").length).toBe(1);
    });

    it("disabled item is skipped by the arrows and ignores clicks", async () => {
      const blocked = vi.fn();
      const menu = await open([
        { label: "One", onClick: vi.fn() },
        { label: "Two", onClick: blocked, disabled: true, title: "Offline" },
        { label: "Three", onClick: vi.fn() },
      ]);
      const rows = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
      expect(rows[1]!.getAttribute("aria-disabled")).toBe("true");
      expect(rows[1]!.title).toBe("Offline");
      rows[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(document.activeElement).toBe(rows[2]);
      rows[1]!.click();
      expect(blocked).not.toHaveBeenCalled();
      // A refused click leaves the menu open so the reason stays readable.
      expect(document.querySelector(".kbd-menu")).not.toBeNull();
    });

    it("onClick receives the click event", async () => {
      const onClick = vi.fn();
      const menu = await open([{ label: "One", onClick }]);
      menu
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect((onClick.mock.calls[0]![0] as MouseEvent).shiftKey).toBe(true);
    });

    it("content node keeps label as aria-label", async () => {
      const menu = await open([
        { label: "React with X", content: document.createTextNode("X"), onClick: vi.fn() },
      ]);
      const row = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
      expect(row.getAttribute("aria-label")).toBe("React with X");
      expect(row.textContent).toBe("X");
    });

    it("group puts the chosen items in one role=group row", async () => {
      openMenu(
        [
          { label: "A", onClick: vi.fn() },
          { label: "B", onClick: vi.fn() },
          { label: "C", onClick: vi.fn() },
        ],
        { group: { start: 0, count: 2 }, ariaLabel: "Things", className: "kbd-menu" },
      );
      const menu = document.querySelector<HTMLElement>(".kbd-menu")!;
      expect(menu.getAttribute("aria-label")).toBe("Things");
      expect(menu.querySelectorAll('[role="group"] [role="menuitem"]').length).toBe(2);
      expect(menu.querySelectorAll(':scope > [role="menuitem"]').length).toBe(1);
    });

    it("onClosed runs once when the menu closes", async () => {
      const onClosed = vi.fn();
      openMenu([{ label: "One", onClick: vi.fn() }], { className: "kbd-menu", onClosed });
      document.querySelector<HTMLElement>(".kbd-menu button")!.click();
      expect(onClosed).toHaveBeenCalledTimes(1);
    });

    it("restoreFocusTo used when the invoker is disconnected", async () => {
      const invoker = document.createElement("button");
      const fallback = document.createElement("button");
      document.body.append(invoker, fallback);
      invoker.focus();
      openMenu([{ label: "One", onClick: vi.fn() }], {
        className: "kbd-menu",
        restoreFocusTo: () => fallback,
      });
      await new Promise((r) => setTimeout(r, 0));
      // The row was rebuilt while the menu was open.
      invoker.remove();
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(document.activeElement).toBe(fallback);
      fallback.remove();
    });

    it("restoreFocusTo is not used while the invoker is still on the page", async () => {
      const invoker = document.createElement("button");
      const fallback = document.createElement("button");
      document.body.append(invoker, fallback);
      invoker.focus();
      openMenu([{ label: "One", onClick: vi.fn() }], {
        className: "kbd-menu",
        restoreFocusTo: () => fallback,
      });
      await new Promise((r) => setTimeout(r, 0));
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(document.activeElement).toBe(invoker);
      invoker.remove();
      fallback.remove();
    });
  });

  describe("checkbox rows", () => {
    it("a row with `checked` is a menuitemcheckbox carrying aria-checked", () => {
      openMenu([
        { label: "On", onClick: vi.fn(), checked: true },
        { label: "Off", onClick: vi.fn(), checked: false },
        { label: "Plain", onClick: vi.fn() },
      ]);

      const rows = Array.from(document.querySelectorAll<HTMLElement>(".context-menu-item"));
      expect(rows.map((r) => r.getAttribute("role"))).toEqual([
        "menuitemcheckbox",
        "menuitemcheckbox",
        "menuitem",
      ]);
      expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", null]);
    });

    it("a click runs onClick and closes the menu; arrow keys reach the row", async () => {
      const onClick = vi.fn();
      openMenu([
        { label: "First", onClick: vi.fn() },
        { label: "Check", onClick, checked: false },
      ]);
      await new Promise((r) => setTimeout(r, 0));
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      const row = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!;
      expect(document.activeElement).toBe(row);

      row.click();

      expect(onClick).toHaveBeenCalledOnce();
      expect(document.querySelector(".context-menu")).toBeNull();
    });
  });
});

describe("submenus and radio rows (3D-3a)", () => {
  beforeEach(() => {
    ac = new AbortController();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });
  afterEach(() => {
    ac.abort();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  function open(onClick = vi.fn(), onPick = vi.fn()) {
    openMenu([
      {
        label: "Mute",
        testId: "trigger",
        onClick,
        submenu: [
          { label: "One", testId: "sub-one", onClick: onPick },
          { label: "Two", testId: "sub-two", onClick: vi.fn() },
        ],
      },
      { label: "Other", onClick: vi.fn() },
    ]);
    const trigger = document.querySelector('[data-testid="trigger"]') as HTMLElement;
    return { trigger, flyout: trigger.nextElementSibling as HTMLElement };
  }

  const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  };

  it("submenu item opens on hover and ArrowRight", () => {
    const { trigger, flyout } = open();
    expect(trigger.textContent).toBe("Mute");
    expect(flyout.style.display).toBe("none");
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.display).toBe("");
    trigger.dispatchEvent(new MouseEvent("mouseleave"));
    expect(flyout.style.display).toBe("none");

    trigger.focus();
    key(trigger, "ArrowRight");
    expect(flyout.style.display).toBe("");
    expect(document.activeElement).toBe(flyout.querySelector('[data-testid="sub-one"]'));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(flyout.querySelector('[data-testid="sub-two"]'));
    key(document.activeElement!, "ArrowLeft");
    expect(flyout.style.display).toBe("none");
    expect(document.activeElement).toBe(trigger);
  });

  it("Enter on an activating trigger clicks it", () => {
    const onClick = vi.fn();
    const { trigger, flyout } = open(onClick);
    trigger.focus();
    key(trigger, "Enter");
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(flyout.isConnected).toBe(false); // the menu closed
  });

  it("Enter on a plain trigger still opens it", () => {
    const onActivate = vi.fn();
    const menu = document.createElement("div");
    menu.className = "context-menu plain";
    const { trigger, flyout } = createSubmenuTrigger(
      "Plain",
      "context-menu-item",
      { onActivate },
      ac.signal,
    );
    const row = document.createElement("button");
    row.setAttribute("role", "menuitem");
    flyout.appendChild(row);
    menu.append(trigger, flyout);
    document.body.appendChild(menu);
    // Same keyboard model every menu gets.
    return import("../../src/lib/ui/contextMenu").then(({ enableMenuKeyboard }) => {
      enableMenuKeyboard(menu, { signal: ac.signal, onClose: () => menu.remove() });
      trigger.focus();
      key(trigger, "Enter");
      expect(onActivate).not.toHaveBeenCalled();
      expect(flyout.style.display).toBe("");
      expect(document.activeElement).toBe(row);
    });
  });

  it("Space on a plain trigger opens it, as Enter does", () => {
    const onActivate = vi.fn();
    const menu = document.createElement("div");
    menu.className = "context-menu plain";
    const { trigger, flyout } = createSubmenuTrigger(
      "Plain",
      "context-menu-item",
      { onActivate },
      ac.signal,
    );
    const row = document.createElement("button");
    row.setAttribute("role", "menuitem");
    flyout.appendChild(row);
    menu.append(trigger, flyout);
    document.body.appendChild(menu);
    // Same keyboard model every menu gets.
    return import("../../src/lib/ui/contextMenu").then(({ enableMenuKeyboard }) => {
      enableMenuKeyboard(menu, { signal: ac.signal, onClose: () => menu.remove() });
      trigger.focus();
      key(trigger, " ");
      expect(onActivate).not.toHaveBeenCalled();
      expect(flyout.style.display).toBe("");
      expect(document.activeElement).toBe(row);
    });
  });

  it("a flyout row click does not fire the trigger", () => {
    const onClick = vi.fn();
    const onPick = vi.fn();
    const { flyout } = open(onClick, onPick);
    (flyout.querySelector('[data-testid="sub-one"]') as HTMLElement).click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a click on the trigger runs its own action", () => {
    const onClick = vi.fn();
    const { trigger } = open(onClick);
    trigger.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("onActivate ignores a click that comes from inside the flyout", () => {
    const onActivate = vi.fn();
    const { trigger, flyout } = createSubmenuTrigger(
      "Nested",
      "context-menu-item",
      { onActivate },
      ac.signal,
    );
    const inside = document.createElement("button");
    flyout.appendChild(inside);
    // Nested the other way round (flyout inside the trigger), the click bubbles.
    trigger.appendChild(flyout);
    inside.click();
    expect(onActivate).not.toHaveBeenCalled();
    trigger.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("the flyout flips to the left when it would run off the right edge", () => {
    const { trigger, flyout } = open();
    Object.defineProperty(trigger, "offsetLeft", { value: 100 });
    Object.defineProperty(trigger, "offsetWidth", { value: 180 });
    flyout.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 40, right: window.innerWidth + 50 }) as DOMRect;
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.left).toBe("-100px");

    flyout.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 40, right: 300 }) as DOMRect;
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.left).toBe("280px");
  });

  it("menuitemradio rows are keyboard navigable and report aria-checked", async () => {
    openMenu([
      { label: "A", checked: false, radio: true, onClick: vi.fn() },
      { label: "B", checked: true, radio: true, onClick: vi.fn() },
      { label: "C", onClick: vi.fn() },
    ]);
    const rows = [...document.querySelectorAll(".context-menu-item")] as HTMLElement[];
    expect(rows[0]!.getAttribute("role")).toBe("menuitemradio");
    expect(rows[0]!.getAttribute("aria-checked")).toBe("false");
    expect(rows[1]!.getAttribute("aria-checked")).toBe("true");
    expect(rows[2]!.getAttribute("role")).toBe("menuitem");
    expect(rows[2]!.hasAttribute("aria-checked")).toBe(false);

    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1]!, "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
  });

  it("shows a detail line under the label", () => {
    openMenu([{ label: "Unmute", detail: "Muted until 15:30", onClick: vi.fn() }]);
    expect(document.querySelector(".context-menu-item__detail")!.textContent).toBe(
      "Muted until 15:30",
    );
  });
});

describe("submenu a11y and placement (3D-3a review)", () => {
  beforeEach(() => {
    ac = new AbortController();
  });
  afterEach(() => ac.abort());

  it("links the trigger and flyout by id", () => {
    const { trigger, flyout } = createSubmenuTrigger("T", "context-menu-item", {}, ac.signal);
    expect(trigger.id).not.toBe("");
    expect(trigger.getAttribute("aria-controls")).toBe(flyout.id);
    expect(flyout.getAttribute("aria-labelledby")).toBe(trigger.id);
    const other = createSubmenuTrigger("U", "context-menu-item", {}, ac.signal);
    expect(other.trigger.id).not.toBe(trigger.id);
  });

  it("slides the flyout up when it would run off the bottom edge", () => {
    openMenu([
      { label: "M", testId: "t", onClick: vi.fn(), submenu: [{ label: "A", onClick: vi.fn() }] },
    ]);
    const trigger = document.querySelector('[data-testid="t"]') as HTMLElement;
    const flyout = trigger.nextElementSibling as HTMLElement;
    Object.defineProperty(trigger, "offsetTop", { value: 300 });
    flyout.getBoundingClientRect = () =>
      ({ left: 0, width: 100, right: 100, top: 300, bottom: window.innerHeight + 60 }) as DOMRect;
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.top).toBe("232px");
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });
});
