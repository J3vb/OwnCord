import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindGroupHeader } from "../../../src/features/members/memberGroupHeader";

describe("bindGroupHeader", () => {
  let el: HTMLDivElement;
  let owner: AbortController;
  let toggle: ReturnType<typeof vi.fn<(key: string) => void>>;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    owner = new AbortController();
    toggle = vi.fn<(key: string) => void>();
    bindGroupHeader(el, "a:offline", toggle, owner.signal);
  });
  afterEach(() => {
    owner.abort();
    el.remove();
  });

  const press = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };

  it.each(["Enter", " "])("%j toggles its group and is consumed", (key) => {
    const e = press(key);
    expect(toggle).toHaveBeenCalledExactlyOnceWith("a:offline");
    expect(e.defaultPrevented).toBe(true);
  });

  it.each(["Enter", " "])("a held %j folds once, not on every auto-repeat", (key) => {
    press(key);
    const repeat = press(key, { repeat: true });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(repeat.defaultPrevented).toBe(false);
  });

  it("a click toggles its group", () => {
    el.click();
    expect(toggle).toHaveBeenCalledExactlyOnceWith("a:offline");
  });

  it.each([{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }])(
    "Enter or Space with %o is ignored",
    (mods) => {
      expect(press("Enter", mods).defaultPrevented).toBe(false);
      expect(press(" ", mods).defaultPrevented).toBe(false);
      expect(toggle).not.toHaveBeenCalled();
    },
  );

  it.each(["ArrowDown", "ArrowUp", "Home", "End", "a", "Escape"])("%s is not handled", (key) => {
    expect(press(key).defaultPrevented).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("does nothing once its owner ends", () => {
    owner.abort();
    el.click();
    press("Enter");
    expect(toggle).not.toHaveBeenCalled();
  });
});
