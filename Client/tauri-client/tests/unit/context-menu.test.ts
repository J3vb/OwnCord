import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { showContextMenu } from "../../src/lib/context-menu";

describe("showContextMenu", () => {
  let ac: AbortController;

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
    showContextMenu({
      x: 100,
      y: 200,
      items: [{ label: "Test", onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("200px");
  });

  it("renders all items", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: "Edit", onClick: vi.fn() },
        { label: "Delete", onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const items = document.querySelectorAll(".context-menu-item");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toBe("Edit");
    expect(items[1]!.textContent).toBe("Delete");
  });

  it("fires onClick when item clicked", () => {
    const onClick = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Action", onClick }],
      signal: ac.signal,
    });

    const item = document.querySelector(".context-menu-item") as HTMLElement;
    item.click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("removes menu after item click", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Action", onClick: vi.fn() }],
      signal: ac.signal,
    });

    const item = document.querySelector(".context-menu-item") as HTMLElement;
    item.click();

    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("applies danger class to danger items", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Delete", onClick: vi.fn(), danger: true }],
      signal: ac.signal,
    });

    const item = document.querySelector(".context-menu-item") as HTMLElement;
    expect(item.classList.contains("danger")).toBe(true);
  });

  it("applies testId to items", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Edit", onClick: vi.fn(), testId: "ctx-edit" }],
      signal: ac.signal,
    });

    const item = document.querySelector('[data-testid="ctx-edit"]');
    expect(item).not.toBeNull();
  });

  it("removes menu on AbortSignal abort", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Test", onClick: vi.fn() }],
      signal: ac.signal,
    });

    expect(document.querySelector(".context-menu")).not.toBeNull();

    ac.abort();

    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("removes existing menu with same className before showing new one", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "First", onClick: vi.fn() }],
      signal: ac.signal,
      className: "my-menu",
    });

    showContextMenu({
      x: 50,
      y: 50,
      items: [{ label: "Second", onClick: vi.fn() }],
      signal: ac.signal,
      className: "my-menu",
    });

    const menus = document.querySelectorAll(".my-menu");
    expect(menus.length).toBe(1);
    expect(menus[0]!.querySelector(".context-menu-item")!.textContent).toBe("Second");
  });

  it('uses default className "context-menu" when none specified', () => {
    showContextMenu({
      x: 10,
      y: 20,
      items: [{ label: "Default", onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.classList.contains("context-menu")).toBe(true);
  });

  it("adds separator before danger item when preceded by non-danger item", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: "Edit", onClick: vi.fn() },
        { label: "Delete", onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const sep = menu.querySelector(".context-menu-sep");
    expect(sep).not.toBeNull();
  });

  it("does not add separator when danger item is first", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Delete", onClick: vi.fn(), danger: true }],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const sep = menu.querySelector(".context-menu-sep");
    expect(sep).toBeNull();
  });

  it("does not add separator between consecutive danger items", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: "Delete", onClick: vi.fn(), danger: true },
        { label: "Ban", onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const seps = menu.querySelectorAll(".context-menu-sep");
    expect(seps.length).toBe(0);
  });

  it("handles multiple non-danger items without separator", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: "Copy", onClick: vi.fn() },
        { label: "Edit", onClick: vi.fn() },
        { label: "Reply", onClick: vi.fn() },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const seps = menu.querySelectorAll(".context-menu-sep");
    expect(seps.length).toBe(0);
  });

  it("closes menu on click outside (mousedown)", async () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Test", onClick: vi.fn() }],
      signal: ac.signal,
    });

    expect(document.querySelector(".context-menu")).not.toBeNull();

    // Trigger the deferred mousedown listener (needs setTimeout to fire first)
    await vi.waitFor(() => {
      // Simulate a click outside the menu
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(document.querySelector(".context-menu")).toBeNull();
    });
  });

  it("does not close menu on mousedown inside the menu", async () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [{ label: "Test", onClick: vi.fn() }],
      signal: ac.signal,
    });

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

  it("handles empty items list", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.querySelectorAll(".context-menu-item").length).toBe(0);
  });

  it("clicking one item does not affect other items", () => {
    const onClick1 = vi.fn();
    const onClick2 = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: "Action1", onClick: onClick1 },
        { label: "Action2", onClick: onClick2 },
      ],
      signal: ac.signal,
    });

    const items = document.querySelectorAll(".context-menu-item");
    (items[0] as HTMLElement).click();

    expect(onClick1).toHaveBeenCalledTimes(1);
    expect(onClick2).not.toHaveBeenCalled();
  });

  it("handles non-danger item followed by danger item with separator", () => {
    showContextMenu({
      x: 0,
      y: 0,
      items: [
        { label: "Copy", onClick: vi.fn() },
        { label: "Edit", onClick: vi.fn() },
        { label: "Delete", onClick: vi.fn(), danger: true },
      ],
      signal: ac.signal,
    });

    const menu = document.querySelector(".context-menu") as HTMLElement;
    const children = Array.from(menu.children);
    // Should have: Copy, Edit, separator, Delete
    expect(children.length).toBe(4);
    expect(children[2]!.classList.contains("context-menu-sep")).toBe(true);
  });

  it("menu is appended to document.body", () => {
    showContextMenu({
      x: 100,
      y: 200,
      items: [{ label: "Appended", onClick: vi.fn() }],
      signal: ac.signal,
    });

    const menu = document.body.querySelector(".context-menu");
    expect(menu).not.toBeNull();
  });

  describe("OC-0057: abort-listener teardown on the caller signal", () => {
    it("does not re-invoke menu cleanup off the caller signal after the menu was already dismissed", () => {
      showContextMenu({
        x: 0,
        y: 0,
        items: [{ label: "Action", onClick: vi.fn() }],
        signal: ac.signal,
        className: "oc0057-menu-a",
      });

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
        showContextMenu({
          x: 0,
          y: 0,
          items: [{ label: "Action", onClick: vi.fn() }],
          signal: ac.signal,
          className: "oc0057-menu-b",
        });
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

      showContextMenu({
        x: 0,
        y: 0,
        items: [{ label: "Action", onClick: vi.fn() }],
        signal: ac.signal,
        className: "oc0057-menu-c",
      });

      // An already-aborted parent signal means the menu must never be left
      // dangling in the DOM — "abort" already fired before we could listen
      // for it, so the code must check signal.aborted explicitly.
      expect(document.querySelector(".oc0057-menu-c")).toBeNull();
    });

    it("releases the old menu's abort listener when it is swept away by a same-class reopen", () => {
      showContextMenu({
        x: 0,
        y: 0,
        items: [{ label: "First", onClick: vi.fn() }],
        signal: ac.signal,
        className: "oc0057-menu-d",
      });

      const firstMenu = document.querySelector(".oc0057-menu-d") as HTMLElement;
      expect(firstMenu).not.toBeNull();
      const removeSpy = vi.spyOn(firstMenu, "remove");

      // Reopening with the same className sweeps the first menu out via the
      // querySelectorAll(...).remove() path at the top of the function, not
      // via item click or outside click.
      showContextMenu({
        x: 10,
        y: 10,
        items: [{ label: "Second", onClick: vi.fn() }],
        signal: ac.signal,
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
});
