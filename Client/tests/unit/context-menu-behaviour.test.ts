/**
 * The shared context-menu primitives, driven through their public API and the
 * DOM they produce: keyboard model, submenu flyouts, row classes, viewport
 * placement, dismissal and teardown ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The module is loaded inside the tests so its load-time constants are
 *  exercised by them. */
function lib(): Promise<typeof import("../../src/lib/ui/contextMenu")> {
  return import("../../src/lib/ui/contextMenu");
}

function press(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function define(el: Element, prop: string, value: number): void {
  Object.defineProperty(el, prop, { value, configurable: true });
}

function rect(init: Partial<DOMRect>): DOMRect {
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...init } as DOMRect;
}

const noop = (): void => {};

const byId = (id: string, root: ParentNode = document): HTMLElement =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

const lastNumber = (id: string): number => Number(id.split("-").at(-1));

let ac: AbortController;

async function openWithTrigger(activates = true) {
  const { showContextMenu } = await lib();
  const onClick = vi.fn();
  showContextMenu({
    x: 0,
    y: 0,
    signal: ac.signal,
    items: [
      {
        label: "Mute",
        testId: "trigger",
        onClick,
        submenu: [
          { label: "One", testId: "one", onClick: noop },
          { label: "Two", testId: "two", onClick: noop },
        ],
      },
      { label: "Other", testId: "other", onClick: noop },
    ],
  });
  await settle();
  const trigger = document.querySelector<HTMLElement>('[data-testid="trigger"]')!;
  if (!activates) trigger.removeAttribute("data-activates");
  const menu = document.querySelector<HTMLElement>(".context-menu")!;
  return { trigger, flyout: trigger.nextElementSibling as HTMLElement, onClick, menu };
}

async function handBuilt(withSibling: boolean) {
  const { createMenuItem, enableMenuKeyboard } = await lib();
  const menu = document.createElement("div");
  document.body.append(menu);
  const before = createMenuItem("Before", "context-menu-item");
  const owner = createMenuItem("Owner", "context-menu-item", { submenu: true });
  const flyout = document.createElement("div");
  flyout.className = "context-menu__submenu";
  flyout.style.display = "none";
  const first = createMenuItem("First", "context-menu-item");
  const second = createMenuItem("Second", "context-menu-item");
  flyout.append(first, second);
  owner.append(flyout);
  menu.append(before, owner);
  if (withSibling) {
    const sibling = document.createElement("div");
    sibling.className = "context-menu__submenu";
    menu.append(sibling);
  }
  enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
  await settle();
  return { menu, before, owner, flyout, first, second };
}

async function openKeyboardRow(canOpen?: () => boolean) {
  const { openMenuOnKeyboard } = await lib();
  const parent = document.createElement("div");
  const row = document.createElement("div");
  parent.append(row);
  document.body.append(parent);
  row.getBoundingClientRect = () => rect({ right: 240, top: 36 });
  const openAt = vi.fn();
  const parentSaw = vi.fn();
  parent.addEventListener("keydown", parentSaw);
  openMenuOnKeyboard(row, openAt, ac.signal, canOpen);
  return { row, openAt, parentSaw };
}

async function buildRawMenu(connected: boolean) {
  const { createMenuItem, enableMenuKeyboard } = await lib();
  const menu = document.createElement("div");
  const one = createMenuItem("One", "context-menu-item");
  const two = createMenuItem("Two", "context-menu-item");
  menu.append(one, two);
  if (connected) document.body.append(menu);
  return { menu, one, two, enableMenuKeyboard };
}

async function mountTrigger(onActivate?: (e: MouseEvent) => void, testId?: string) {
  const { createSubmenuTrigger } = await lib();
  const parts = createSubmenuTrigger(
    "Mute",
    "context-menu-item",
    {
      ...(testId !== undefined ? { testId } : {}),
      ...(onActivate !== undefined ? { onActivate } : {}),
    },
    ac.signal,
  );
  const inner = document.createElement("button");
  parts.flyout.append(inner);
  document.body.append(parts.trigger, parts.flyout);
  return { ...parts, inner };
}

async function placeFlyout(flyoutRect: Partial<DOMRect>) {
  const { trigger, flyout } = await mountTrigger();
  define(trigger, "offsetTop", 40);
  define(trigger, "offsetLeft", 10);
  define(trigger, "offsetWidth", 100);
  flyout.getBoundingClientRect = () => rect(flyoutRect);
  trigger.dispatchEvent(new MouseEvent("mouseenter"));
  return { trigger, flyout };
}

function menuOf(width: number, height: number): HTMLElement {
  const menu = document.createElement("div");
  define(menu, "offsetWidth", width);
  define(menu, "offsetHeight", height);
  return menu;
}

function heightOf(px: number): void {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(px);
}

beforeEach(() => {
  ac = new AbortController();
  document.body.replaceChildren();
});

afterEach(() => {
  ac.abort();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("menu rows and navigation", () => {
  it("walks plain, checkbox and radio rows alike, and skips a flyout's own rows", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        { label: "Plain", testId: "plain", onClick: noop },
        { label: "Check", testId: "check", checked: true, onClick: noop },
        { label: "Radio", testId: "radio", checked: false, radio: true, onClick: noop },
        {
          label: "More",
          testId: "more",
          onClick: noop,
          submenu: [{ label: "Inner", testId: "inner", onClick: noop }],
        },
        { label: "Last", testId: "last", onClick: noop },
      ],
    });
    await settle();
    const row = byId;

    expect(document.activeElement).toBe(row("plain"));
    press(row("plain"), "ArrowDown");
    expect(document.activeElement).toBe(row("check"));
    expect(row("check").getAttribute("role")).toBe("menuitemcheckbox");
    press(row("check"), "ArrowDown");
    expect(document.activeElement).toBe(row("radio"));
    expect(row("radio").getAttribute("role")).toBe("menuitemradio");
    press(row("radio"), "ArrowDown");
    expect(document.activeElement).toBe(row("more"));
    press(row("more"), "ArrowDown");
    expect(document.activeElement).toBe(row("last"));
    press(row("last"), "ArrowUp");
    expect(document.activeElement).toBe(row("more"));
  });

  it("leaves a hidden confirm row of an inline form out of the arrow-key walk", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        { label: "One", testId: "one", onClick: noop },
        { label: "Two", testId: "two", onClick: noop },
      ],
    });
    await settle();
    const menu = document.querySelector<HTMLElement>(".context-menu")!;
    const form = document.createElement("div");
    form.className = "context-menu__reason";
    const confirm = document.createElement("button");
    confirm.setAttribute("role", "menuitem");
    confirm.textContent = "Confirm";
    form.append(confirm);
    menu.append(form);
    const one = menu.querySelector<HTMLElement>('[data-testid="one"]')!;
    const two = menu.querySelector<HTMLElement>('[data-testid="two"]')!;

    press(one, "End");
    expect(document.activeElement).toBe(two);
    press(two, "ArrowDown");
    expect(document.activeElement).toBe(two);
    // A key on the confirm row itself is not a menu move.
    confirm.focus();
    const event = press(confirm, "ArrowDown");
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(confirm);
  });

  it("stays on the last row at the bottom and on the first at the top", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        { label: "A", testId: "a", onClick: noop },
        { label: "B", testId: "b", onClick: noop },
        { label: "C", testId: "c", onClick: noop },
      ],
    });
    await settle();
    const row = byId;

    press(row("a"), "End");
    expect(document.activeElement).toBe(row("c"));
    const down = press(row("c"), "ArrowDown");
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(row("c"));
    expect(row("c").getAttribute("tabindex")).toBe("0");

    press(row("c"), "ArrowUp");
    expect(document.activeElement).toBe(row("b"));
    expect(row("b").getAttribute("tabindex")).toBe("0");
    expect(row("c").getAttribute("tabindex")).toBe("-1");
    press(row("b"), "ArrowUp");
    const up = press(row("a"), "ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(row("a"));
  });

  it("ignores keys that are not navigation keys", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        { label: "A", testId: "a", onClick: noop },
        { label: "B", testId: "b", onClick: noop },
      ],
    });
    await settle();
    const a = document.querySelector<HTMLElement>('[data-testid="a"]')!;
    for (const key of ["a", "Tab", "PageDown", "Shift"]) {
      const event = press(a, key);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(a);
    }
  });

  it("Left and Right do nothing on a row outside a side-by-side group", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        { label: "A", testId: "a", onClick: noop },
        { label: "B", testId: "b", onClick: noop },
        { label: "C", testId: "c", onClick: noop },
      ],
    });
    await settle();
    const b = document.querySelector<HTMLElement>('[data-testid="b"]')!;
    b.focus();
    for (const key of ["ArrowRight", "ArrowLeft"]) {
      const event = press(b, key);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(b);
    }
  });

  it("moves along a side-by-side group with Left and Right and never out of it", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      group: { start: 1, count: 3 },
      groupLabel: "Quick reactions",
      items: [
        { label: "Before", testId: "before", onClick: noop },
        { label: "R1", testId: "r1", onClick: noop },
        { label: "R2", testId: "r2", onClick: noop },
        { label: "R3", testId: "r3", onClick: noop },
        { label: "After", testId: "after", onClick: noop },
      ],
    });
    await settle();
    const menu = document.querySelector<HTMLElement>(".context-menu")!;
    const row = (id: string): HTMLElement => byId(id, menu);
    const group = menu.querySelector<HTMLElement>('[role="group"]')!;

    expect(group.getAttribute("aria-label")).toBe("Quick reactions");
    expect(group.className).toBe("context-menu-group");
    expect([...group.children]).toEqual([row("r1"), row("r2"), row("r3")]);
    expect(row("before").parentElement).toBe(menu);
    expect(row("after").parentElement).toBe(menu);

    row("r1").focus();
    press(row("r1"), "ArrowLeft");
    expect(document.activeElement).toBe(row("r1"));
    press(row("r1"), "ArrowRight");
    expect(document.activeElement).toBe(row("r2"));
    press(row("r2"), "ArrowRight");
    expect(document.activeElement).toBe(row("r3"));
    press(row("r3"), "ArrowRight");
    expect(document.activeElement).toBe(row("r3"));
    press(row("r3"), "ArrowLeft");
    expect(document.activeElement).toBe(row("r2"));

    // Up, Down, Home and End still walk the whole menu.
    press(row("r2"), "Home");
    expect(document.activeElement).toBe(row("before"));
    press(row("before"), "End");
    expect(document.activeElement).toBe(row("after"));
    press(row("after"), "ArrowUp");
    expect(document.activeElement).toBe(row("r3"));
  });

  it("puts only the chosen rows in the group and leaves the rest in the menu", async () => {
    const { showContextMenu } = await lib();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      group: { start: 2, count: 2 },
      items: [
        { label: "A", testId: "a", onClick: noop },
        { label: "B", testId: "b", onClick: noop },
        { label: "C", testId: "c", onClick: noop },
        { label: "D", testId: "d", onClick: noop },
        { label: "E", testId: "e", onClick: noop },
      ],
    });
    const menu = document.querySelector<HTMLElement>(".context-menu")!;
    const group = menu.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBeNull();
    expect([...group.children].map((c) => c.textContent)).toEqual(["C", "D"]);
    expect(
      [...menu.children].map((c) => (c.matches('[role="group"]') ? "group" : c.textContent)),
    ).toEqual(["A", "B", "group", "E"]);
  });

  it("builds rows with the right classes", async () => {
    const { showContextMenu } = await lib();
    const content = document.createElement("span");
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        { label: "Plain", testId: "plain", onClick: noop },
        { label: "Danger", testId: "danger", danger: true, onClick: noop },
        { label: "Off", testId: "off", disabled: true, onClick: noop },
        { label: "Emoji", testId: "emoji", content, onClick: noop },
        {
          label: "All",
          testId: "all",
          danger: true,
          disabled: true,
          content: document.createElement("i"),
          onClick: noop,
        },
      ],
    });
    expect(byId("plain").className).toBe("context-menu-item");
    expect(byId("danger").className).toBe("context-menu-item danger");
    expect(byId("off").className).toBe("context-menu-item disabled");
    expect(byId("emoji").className).toBe("context-menu-item context-menu-item--content");
    expect(byId("all").className).toBe(
      "context-menu-item danger disabled context-menu-item--content",
    );
  });

  it("shows a disabled row that owns a submenu as a plain disabled row", async () => {
    const { showContextMenu } = await lib();
    const onClick = vi.fn();
    const inner = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        {
          label: "Mute",
          testId: "mute",
          disabled: true,
          title: "Not now",
          onClick,
          submenu: [{ label: "Inner", onClick: inner }],
        },
      ],
    });
    const row = document.querySelector<HTMLElement>('[data-testid="mute"]')!;
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.title).toBe("Not now");
    expect(row.nextElementSibling).toBeNull();
    row.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(document.querySelector(".context-menu")).not.toBeNull();
  });

  it("ignores a click on a row once the menu's owner is gone", async () => {
    const { showContextMenu } = await lib();
    const onClick = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [{ label: "Act", testId: "act", onClick }],
    });
    const row = document.querySelector<HTMLElement>('[data-testid="act"]')!;
    ac.abort();
    row.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("runs a submenu row's own action when it is clicked and closes the menu", async () => {
    const { showContextMenu } = await lib();
    const onClick = vi.fn();
    showContextMenu({
      x: 0,
      y: 0,
      signal: ac.signal,
      items: [
        {
          label: "Mute",
          testId: "mute",
          onClick,
          submenu: [{ label: "One", onClick: noop }],
          detail: "Until 15:30",
        },
      ],
    });
    const trigger = document.querySelector<HTMLElement>('[data-testid="mute"]')!;
    expect(trigger.querySelector(".context-menu-item__detail")?.textContent).toBe("Until 15:30");
    trigger.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".context-menu")).toBeNull();
  });
});

describe("submenu keys on a row", () => {
  it("leaves a plain row's Enter and Space to the browser", async () => {
    const { menu } = await openWithTrigger();
    const other = menu.querySelector<HTMLElement>('[data-testid="other"]')!;
    const stray = vi.fn();
    menu.addEventListener("keydown", stray);
    for (const key of ["Enter", " "]) {
      const event = press(other, key);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(stray).toHaveBeenCalledTimes(2);
  });

  it("opens the flyout only on ArrowRight, Enter or Space, not on other keys", async () => {
    const { trigger, flyout } = await openWithTrigger(false);
    for (const key of ["ArrowDown", "a", "Home"]) {
      press(trigger, key);
      expect(flyout.style.display).toBe("none");
    }
    press(trigger, "ArrowRight");
    expect(flyout.style.display).toBe("");
  });

  it("Enter on an activating row runs its own action and nothing else sees the key", async () => {
    const { trigger, flyout, onClick, menu } = await openWithTrigger();
    const stray = vi.fn();
    menu.addEventListener("keydown", stray);
    document.addEventListener("keydown", stray, { signal: ac.signal });
    const event = press(trigger, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(stray).not.toHaveBeenCalled();
    expect(flyout.style.display).toBe("none");
  });

  it("ArrowRight on an activating row opens its flyout instead of running it", async () => {
    const { trigger, flyout, onClick } = await openWithTrigger();
    const event = press(trigger, "ArrowRight");
    expect(event.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(flyout.style.display).toBe("");
    expect(document.activeElement).toBe(flyout.querySelector('[data-testid="one"]'));
  });

  it("Enter on a plain flyout row opens it and stops the key reaching other listeners", async () => {
    const { trigger, flyout, menu } = await openWithTrigger(false);
    const stray = vi.fn();
    menu.addEventListener("keydown", stray);
    const event = press(trigger, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(stray).not.toHaveBeenCalled();
    expect(flyout.style.display).toBe("");
    expect(flyout.getAttribute("role")).toBe("menu");
  });

  it("ArrowLeft inside the flyout closes it, returns to the trigger and is consumed", async () => {
    const { trigger, flyout } = await openWithTrigger();
    press(trigger, "ArrowRight");
    const one = flyout.querySelector<HTMLElement>('[data-testid="one"]')!;
    const event = press(one, "ArrowLeft");
    expect(event.defaultPrevented).toBe(true);
    expect(flyout.style.display).toBe("none");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});

describe("hand-built nested menus", () => {
  /** A menu whose row owns a child flyout, the way hand-built menus do. */
  it("reveals the child flyout, gives it a menu role and a roving first row", async () => {
    const { owner, flyout, first, second } = await handBuilt(false);
    owner.focus();
    const event = press(owner, "ArrowRight");
    expect(event.defaultPrevented).toBe(true);
    expect(flyout.style.display).toBe("");
    expect(flyout.getAttribute("role")).toBe("menu");
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("tabindex")).toBe("0");
    expect(second.getAttribute("tabindex")).toBe("-1");
    // A child flyout is placed by CSS, never by script.
    expect(flyout.style.top).toBe("");
    expect(flyout.style.left).toBe("");
    expect(owner.getAttribute("aria-expanded")).toBeNull();
  });

  it("does not place a flyout whose neighbour is not a trigger", async () => {
    const { createMenuItem, enableMenuKeyboard } = await lib();
    const menu = document.createElement("div");
    document.body.append(menu);
    const plain = createMenuItem("Plain", "context-menu-item");
    const flyout = document.createElement("div");
    flyout.className = "context-menu__submenu";
    flyout.style.display = "none";
    flyout.append(createMenuItem("Inner", "context-menu-item"));
    menu.append(plain, flyout);
    enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
    await settle();

    plain.focus();
    press(plain, "ArrowRight");

    expect(flyout.style.display).toBe("");
    expect(flyout.style.top).toBe("");
    expect(flyout.style.left).toBe("");
    expect(plain.getAttribute("aria-expanded")).toBeNull();
  });

  it("leaves Enter alone on a row marked as an action that owns no flyout", async () => {
    const { createMenuItem, enableMenuKeyboard } = await lib();
    const menu = document.createElement("div");
    document.body.append(menu);
    const row = createMenuItem("Odd", "context-menu-item");
    row.dataset["activates"] = "true";
    const clicked = vi.fn();
    row.addEventListener("click", clicked);
    menu.append(row);
    enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
    await settle();

    const event = press(row, "Enter");

    expect(event.defaultPrevented).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });

  it("ArrowLeft inside a flyout with no trigger beside it leaves it open and raises no error", async () => {
    const { owner, flyout, first } = await handBuilt(false);
    press(owner, "ArrowRight");
    first.focus();
    const errors: unknown[] = [];
    window.addEventListener("error", (e) => errors.push(e.error), { signal: ac.signal });
    const event = press(first, "ArrowLeft");
    expect(errors).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(flyout.style.display).toBe("");
    expect(document.activeElement).toBe(first);
  });
});

describe("createMenuItem", () => {
  it("builds a focusable button row", async () => {
    const { createMenuItem } = await lib();
    const row = createMenuItem("Copy", "context-menu-item", { testId: "copy" });
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    expect(row.getAttribute("role")).toBe("menuitem");
    expect(row.getAttribute("tabindex")).toBe("-1");
    expect(row.getAttribute("data-testid")).toBe("copy");
    expect(row.className).toBe("context-menu-item");
    expect(row.textContent).toBe("Copy");
  });

  it("builds a div for a row that owns a flyout, with no button type", async () => {
    const { createMenuItem } = await lib();
    const row = createMenuItem("More", "context-menu-item", { submenu: true });
    expect(row.tagName).toBe("DIV");
    expect(row.hasAttribute("type")).toBe(false);
    expect(row.hasAttribute("data-testid")).toBe(false);
    expect(row.getAttribute("role")).toBe("menuitem");
  });
});

describe("openMenuOnKeyboard", () => {
  it("opens at the row's right edge on Shift+F10, and keeps the key from its parent row", async () => {
    const { row, openAt, parentSaw } = await openKeyboardRow();
    const event = press(row, "F10", { shiftKey: true });
    expect(openAt).toHaveBeenCalledWith(240, 36);
    expect(event.defaultPrevented).toBe(true);
    expect(parentSaw).not.toHaveBeenCalled();
  });

  it("opens on the dedicated Menu key", async () => {
    const { row, openAt } = await openKeyboardRow();
    press(row, "ContextMenu");
    expect(openAt).toHaveBeenCalledWith(240, 36);
  });

  it("ignores F10 without Shift, Shift with another key, and ordinary keys", async () => {
    const { row, openAt, parentSaw } = await openKeyboardRow();
    for (const [key, init] of [
      ["F10", {}],
      ["F9", { shiftKey: true }],
      ["a", { shiftKey: true }],
      ["Enter", {}],
    ] as const) {
      const event = press(row, key, init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(openAt).not.toHaveBeenCalled();
    expect(parentSaw).toHaveBeenCalledTimes(4);
  });

  it("leaves the key alone while the row has no menu", async () => {
    const { row, openAt, parentSaw } = await openKeyboardRow(() => false);
    const event = press(row, "ContextMenu");
    expect(event.defaultPrevented).toBe(false);
    expect(openAt).not.toHaveBeenCalled();
    expect(parentSaw).toHaveBeenCalledTimes(1);
  });

  it("stops listening when its owner goes away", async () => {
    const { row, openAt } = await openKeyboardRow();
    ac.abort();
    press(row, "ContextMenu");
    expect(openAt).not.toHaveBeenCalled();
  });
});

describe("enableMenuKeyboard on its own", () => {
  it("focuses the first row of a menu its caller mounts a moment later", async () => {
    const { menu, one, enableMenuKeyboard } = await buildRawMenu(false);
    enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
    document.body.append(menu);
    await settle();
    expect(document.activeElement).toBe(one);
  });

  it("leaves focus alone when the owner went away before the menu was mounted", async () => {
    const { menu, one, enableMenuKeyboard } = await buildRawMenu(false);
    enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
    ac.abort();
    document.body.append(menu);
    await settle();
    expect(document.activeElement).not.toBe(one);
  });

  it("does not focus a menu that never got mounted", async () => {
    const { menu, one, enableMenuKeyboard } = await buildRawMenu(false);
    enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
    await settle();
    expect(document.activeElement).not.toBe(one);
  });

  it("Escape closes through the caller, is consumed, and puts focus back on the opener", async () => {
    const { menu, one, enableMenuKeyboard } = await buildRawMenu(true);
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn(() => menu.remove());
    enableMenuKeyboard(menu, { signal: ac.signal, onClose });
    await settle();
    expect(document.activeElement).toBe(one);
    const outer = vi.fn();
    document.addEventListener("keydown", outer, { signal: ac.signal });

    const event = press(one, "Escape");

    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus through restoreFocusTo when the opener has left the page", async () => {
    const { menu, one, enableMenuKeyboard } = await buildRawMenu(true);
    const fallback = document.createElement("button");
    const opener = document.createElement("button");
    document.body.append(fallback, opener);
    opener.focus();
    enableMenuKeyboard(menu, {
      signal: ac.signal,
      onClose: () => menu.remove(),
      restoreFocusTo: () => fallback,
    });
    await settle();
    opener.remove();
    press(one, "Escape");
    expect(document.activeElement).toBe(fallback);
  });

  it("stops handling keys once its owner goes away", async () => {
    const { menu, one, enableMenuKeyboard } = await buildRawMenu(true);
    const onClose = vi.fn();
    enableMenuKeyboard(menu, { signal: ac.signal, onClose });
    ac.abort();
    press(one, "Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves focus where the user put it when the restorer runs after they moved on", async () => {
    const { menu, enableMenuKeyboard } = await buildRawMenu(true);
    const opener = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(opener, elsewhere);
    opener.focus();
    const restore = enableMenuKeyboard(menu, { signal: ac.signal, onClose: noop });
    elsewhere.focus();
    restore();
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("submenu triggers", () => {
  it("is a div row carrying the flyout classes and the expected state", async () => {
    const { trigger, flyout } = await mountTrigger(undefined, "mute");
    expect(trigger.tagName).toBe("DIV");
    expect(trigger.className).toBe(
      "context-menu-item context-menu-item--submenu context-menu-item--flyout",
    );
    expect(trigger.getAttribute("data-testid")).toBe("mute");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("data-activates")).toBe(false);
    expect(trigger.id).toMatch(/^ctx-submenu-trigger-\d+$/);
    expect(flyout.id).toMatch(/^ctx-submenu-\d+$/);
    expect(flyout.getAttribute("role")).toBe("menu");
    expect(flyout.className).toBe("context-menu__submenu");
    expect(flyout.style.display).toBe("none");
  });

  it("marks a row whose own click is an action", async () => {
    const { createSubmenuTrigger } = await lib();
    const { trigger } = createSubmenuTrigger("Mute", "x", { activates: true }, ac.signal);
    expect(trigger.getAttribute("data-activates")).toBe("true");
    const plain = createSubmenuTrigger("Mute", "x", { activates: false }, ac.signal);
    expect(plain.trigger.hasAttribute("data-activates")).toBe(false);
  });

  it("shows the flyout when the pointer enters either part and keeps it while moving between them", async () => {
    const { trigger, flyout, inner } = await mountTrigger();
    flyout.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.display).toBe("");

    trigger.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: inner }));
    expect(flyout.style.display).toBe("");
    flyout.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: trigger }));
    expect(flyout.style.display).toBe("");
    flyout.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: inner }));
    expect(flyout.style.display).toBe("");
    trigger.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: trigger }));
    expect(flyout.style.display).toBe("");
  });

  it("hides the flyout when the pointer leaves for somewhere else", async () => {
    const { trigger, flyout } = await mountTrigger();
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);

    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    trigger.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: elsewhere }));
    expect(flyout.style.display).toBe("none");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    flyout.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: elsewhere }));
    expect(flyout.style.display).toBe("none");

    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    flyout.dispatchEvent(new MouseEvent("mouseleave"));
    expect(flyout.style.display).toBe("none");
  });

  it("stops reacting to the pointer and to clicks once its owner goes away", async () => {
    const onActivate = vi.fn();
    const { trigger, flyout } = await mountTrigger(onActivate);
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.display).toBe("");
    ac.abort();

    trigger.dispatchEvent(new MouseEvent("mouseleave"));
    flyout.dispatchEvent(new MouseEvent("mouseleave"));
    expect(flyout.style.display).toBe("");
    flyout.style.display = "none";
    trigger.dispatchEvent(new MouseEvent("mouseenter"));
    flyout.dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.display).toBe("none");
    trigger.click();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("gives every trigger its own positive numbered ids", async () => {
    const { createSubmenuTrigger } = await lib();
    const first = createSubmenuTrigger("A", "x", {}, ac.signal);
    const second = createSubmenuTrigger("B", "x", {}, ac.signal);
    expect(lastNumber(first.trigger.id)).toBeGreaterThan(0);
    expect(lastNumber(second.trigger.id)).toBe(lastNumber(first.trigger.id) + 1);
    expect(lastNumber(first.flyout.id)).toBe(lastNumber(first.trigger.id));
  });

  describe("placement", () => {
    it("sits beside the trigger when it fits", async () => {
      const { trigger, flyout } = await placeFlyout({
        right: 300,
        width: 190,
        top: 40,
        bottom: 100,
      });
      expect(flyout.style.top).toBe("40px");
      expect(flyout.style.left).toBe("110px");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    it("flips to the left only when it would pass the margin at the right edge", async () => {
      const edge = window.innerWidth - 8;
      const fits = await placeFlyout({ right: edge, width: 200 });
      expect(fits.flyout.style.left).toBe("110px");
      document.body.replaceChildren();
      const crowded = await placeFlyout({ right: window.innerWidth - 4, width: 200 });
      expect(crowded.flyout.style.left).toBe("-190px");
    });

    it("stays level when the bottom edge fits, even exactly at the margin", async () => {
      const roomy = await placeFlyout({ top: 40, bottom: window.innerHeight - 60 });
      expect(roomy.flyout.style.top).toBe("40px");
      document.body.replaceChildren();
      const exact = await placeFlyout({ top: 40, bottom: window.innerHeight - 8 });
      expect(exact.flyout.style.top).toBe("40px");
    });

    it("slides up by the overflow, but never past the top margin", async () => {
      const slid = await placeFlyout({ top: 300, bottom: window.innerHeight + 20 });
      expect(slid.flyout.style.top).toBe("12px");
      document.body.replaceChildren();
      const capped = await placeFlyout({ top: 10, bottom: window.innerHeight + 40 });
      expect(capped.flyout.style.top).toBe("38px");
    });
  });
});

describe("clampMenuToViewport", () => {
  const view = { innerWidth: 500, innerHeight: 400 } as Window;

  it("anchors by the top left when the menu fits", async () => {
    const { clampMenuToViewport } = await lib();
    const menu = menuOf(100, 100);
    menu.style.bottom = "9px";
    clampMenuToViewport(menu, 50, 60, view);
    expect(menu.style.left).toBe("50px");
    expect(menu.style.top).toBe("60px");
    expect(menu.style.bottom).toBe("");
  });

  it("keeps a menu that ends exactly at the bottom margin anchored by its top", async () => {
    const { clampMenuToViewport } = await lib();
    const menu = menuOf(100, 100);
    clampMenuToViewport(menu, 50, 292, view);
    expect(menu.style.top).toBe("292px");
    expect(menu.style.bottom).toBe("");
  });

  it("anchors by the bottom edge when the menu would run off the bottom", async () => {
    const { clampMenuToViewport } = await lib();
    const menu = menuOf(100, 100);
    menu.style.top = "5px";
    clampMenuToViewport(menu, 50, 293, view);
    expect(menu.style.top).toBe("");
    expect(menu.style.bottom).toBe("107px");
  });

  it("pulls a menu back from the right edge and never past the left margin", async () => {
    const { clampMenuToViewport } = await lib();
    const right = menuOf(100, 50);
    clampMenuToViewport(right, 480, 10, view);
    expect(right.style.left).toBe("392px");
    const wide = menuOf(900, 50);
    clampMenuToViewport(wide, 0, 10, view);
    expect(wide.style.left).toBe("8px");
  });
});

describe("openMenuShell", () => {
  it("uses the bare menu class unless asked for another", async () => {
    const { openMenuShell } = await lib();
    const plain = openMenuShell({ x: 0, y: 0, signal: ac.signal, build: noop });
    expect(plain.element.className).toBe("context-menu");
    const styled = openMenuShell({
      x: 0,
      y: 0,
      signal: ac.signal,
      className: "member-menu",
      attrs: { "data-testid": "m" },
      build: noop,
    });
    expect(styled.element.className).toBe("context-menu member-menu");
    expect(styled.element.getAttribute("data-testid")).toBe("m");
  });

  it("closes on any click when asked, inside the menu included", async () => {
    const { openMenuShell } = await lib();
    const onClosed = vi.fn();
    const menu = openMenuShell({
      x: 0,
      y: 0,
      signal: ac.signal,
      dismiss: "any-click",
      onClosed,
      build: (root) => root.append(document.createElement("button")),
    });
    await settle();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.body.contains(menu.element)).toBe(true);

    menu.element.querySelector("button")!.click();

    expect(document.body.contains(menu.element)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("by default closes on a press outside and not on a click", async () => {
    const { openMenuShell } = await lib();
    const menu = openMenuShell({ x: 0, y: 0, signal: ac.signal, build: noop });
    await settle();
    document.body.click();
    expect(document.body.contains(menu.element)).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.body.contains(menu.element)).toBe(false);
  });

  it("opening one menu closes the one already open and runs its close callback", async () => {
    const { openMenuShell } = await lib();
    const firstClosed = vi.fn();
    const first = openMenuShell({
      x: 0,
      y: 0,
      signal: ac.signal,
      onClosed: firstClosed,
      build: noop,
    });
    const second = openMenuShell({ x: 0, y: 0, signal: ac.signal, build: noop });
    expect(document.body.contains(first.element)).toBe(false);
    expect(firstClosed).toHaveBeenCalledTimes(1);
    expect(document.body.contains(second.element)).toBe(true);
  });

  it("a menu closed while its action is still running closes once and does not pull focus back", async () => {
    const { openMenuShell } = await lib();
    const opener = document.createElement("button");
    const elsewhere = document.createElement("button");
    document.body.append(opener, elsewhere);
    opener.focus();
    const onClosed = vi.fn();
    let close: () => void = noop;
    const menu = openMenuShell({
      x: 0,
      y: 0,
      signal: ac.signal,
      onClosed,
      build: (root, closeMenu) => {
        close = closeMenu;
        const action = document.createElement("button");
        action.setAttribute("data-testid", "action");
        action.addEventListener("click", () => {
          closeMenu();
          // The action moves focus on its own, then something closes again.
          elsewhere.focus();
          closeMenu();
        });
        root.append(action);
      },
    });
    await settle();
    menu.element.querySelector<HTMLElement>('[data-testid="action"]')!.click();

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(elsewhere);
    close();
    menu.destroy();
    expect(document.activeElement).toBe(elsewhere);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("forwards the fallback focus target to the keyboard model", async () => {
    const { openMenuShell } = await lib();
    const fallback = document.createElement("button");
    const opener = document.createElement("button");
    document.body.append(fallback, opener);
    opener.focus();
    const menu = openMenuShell({
      x: 0,
      y: 0,
      signal: ac.signal,
      restoreFocusTo: () => fallback,
      build: (root) => {
        const row = document.createElement("button");
        row.setAttribute("role", "menuitem");
        root.append(row);
      },
    });
    await settle();
    opener.remove();
    press(menu.element.querySelector("button")!, "Escape");
    expect(document.activeElement).toBe(fallback);
  });

  it("does not build or mount a menu whose owner is already gone", async () => {
    const { openMenuShell } = await lib();
    ac.abort();
    const build = vi.fn();
    const onClosed = vi.fn();
    const menu = openMenuShell({ x: 0, y: 0, signal: ac.signal, onClosed, build });
    expect(build).not.toHaveBeenCalled();
    expect(document.body.contains(menu.element)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("caps a tall menu to the window and scrolls it, but not one that just fits", async () => {
    const { openMenuShell } = await lib();
    const room = window.innerHeight - 16;
    heightOf(room + 1);
    const tall = openMenuShell({ x: 5, y: 5, signal: ac.signal, fit: "scroll", build: noop });
    expect(tall.element.style.maxHeight).toBe(`${room}px`);
    expect(tall.element.style.overflowY).toBe("auto");
    tall.destroy();

    heightOf(room);
    const exact = openMenuShell({ x: 5, y: 5, signal: ac.signal, fit: "scroll", build: noop });
    expect(exact.element.style.maxHeight).toBe("");
    expect(exact.element.style.overflowY).toBe("");
    exact.destroy();

    heightOf(100);
    const small = openMenuShell({ x: 5, y: 5, signal: ac.signal, fit: "scroll", build: noop });
    expect(small.element.style.maxHeight).toBe("");
    expect(small.element.style.left).toBe("8px");
    expect(small.element.style.top).toBe("8px");
  });

  it("re-places the menu when it is resized, and stops watching when it closes", async () => {
    const { openMenuShell } = await lib();
    const observe = vi.fn();
    const disconnect = vi.fn();
    let onResize: () => void = noop;
    class FakeObserver {
      constructor(callback: () => void) {
        onResize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);

    const menu = openMenuShell({ x: 20, y: 30, signal: ac.signal, build: noop });
    expect(observe).toHaveBeenCalledWith(menu.element);
    expect(menu.element.style.top).toBe("30px");

    menu.element.style.top = "0px";
    onResize();
    expect(menu.element.style.top).toBe("30px");

    expect(disconnect).not.toHaveBeenCalled();
    menu.destroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
