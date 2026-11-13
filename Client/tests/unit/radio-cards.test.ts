import { describe, it, expect, vi, afterEach } from "vitest";
import { createRadioCards, type RadioCardOption } from "@lib/ui/radioCards";

type Size = "s" | "m" | "l";

const OPTIONS: readonly RadioCardOption<Size>[] = [
  { value: "s", label: "Small", description: "A little", icon: "hash" },
  { value: "m", label: "Medium", description: "Some", icon: "volume-2" },
  { value: "l", label: "Large", description: "A lot", icon: "megaphone" },
];

describe("createRadioCards", () => {
  let controller: AbortController;
  afterEach(() => {
    controller.abort();
    document.body.replaceChildren();
  });

  function make(value: Size, onChange?: (v: Size) => void) {
    controller = new AbortController();
    const cards = createRadioCards<Size>({
      signal: controller.signal,
      labelledBy: "size-label",
      testId: "size",
      options: OPTIONS,
      value,
      ...(onChange === undefined ? {} : { onChange }),
    });
    document.body.appendChild(cards.el);
    const radios = Array.from(cards.el.querySelectorAll<HTMLButtonElement>("[role='radio']"));
    return { cards, radios };
  }

  const press = (target: HTMLElement, init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };

  it("is a named radio group with one tab stop on the checked card", () => {
    const { cards, radios } = make("m");
    expect(cards.group.getAttribute("role")).toBe("radiogroup");
    expect(cards.group.getAttribute("aria-labelledby")).toBe("size-label");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios.map((r) => r.dataset["testid"])).toEqual(["size-s", "size-m", "size-l"]);
    expect(cards.group.dataset["value"]).toBe("m");
  });

  it("Home and End jump to the ends; a modified arrow is left alone", () => {
    const onChange = vi.fn();
    const { cards, radios } = make("m", onChange);
    radios[1]!.focus();
    press(radios[1]!, { key: "End" });
    expect(cards.value()).toBe("l");
    expect(document.activeElement).toBe(radios[2]);
    press(radios[2]!, { key: "Home" });
    expect(cards.value()).toBe("s");
    expect(press(radios[0]!, { key: "ArrowRight", altKey: true }).defaultPrevented).toBe(false);
    expect(cards.value()).toBe("s");
    expect(onChange.mock.calls).toEqual([["l"], ["s"]]);
  });

  it("a click focuses the card, so arrow keys start from it", () => {
    const { cards, radios } = make("s");
    radios[2]!.click();
    expect(document.activeElement).toBe(radios[2]);
    press(radios[2]!, { key: "ArrowLeft" });
    expect(cards.value()).toBe("m");
  });

  it("shows the checked card's description in the line under the group", () => {
    const { cards, radios } = make("s");
    const hint = cards.el.querySelector(".radio-cards-hint")!;
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    expect(hint.textContent).toBe("A little");
    radios[1]!.click();
    expect(hint.textContent).toBe("Some");
    expect(cards.group.contains(hint)).toBe(false);
  });

  it("a click on the checked card does not report a change", () => {
    const onChange = vi.fn();
    const { radios } = make("s", onChange);
    radios[0]!.click();
    expect(onChange).not.toHaveBeenCalled();
    radios[2]!.click();
    expect(onChange).toHaveBeenCalledWith("l");
  });

  it("falls back to the first card when the value is not offered", () => {
    controller = new AbortController();
    const cards = createRadioCards<string>({
      signal: controller.signal,
      labelledBy: "x",
      testId: "x",
      options: OPTIONS,
      value: "xl",
    });
    expect(cards.value()).toBe("s");
  });

  it("stops listening once its signal aborts", () => {
    const onChange = vi.fn();
    const { radios } = make("s", onChange);
    controller.abort();
    radios[1]!.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
