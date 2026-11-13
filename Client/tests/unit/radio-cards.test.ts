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

  describe("tile layout", () => {
    const tile = (value: Size, label: string): RadioCardOption<Size> => {
      const preview = document.createElement("span");
      preview.className = `pic-${value}`;
      return { value, label, preview };
    };
    const TILES = [tile("s", "Small"), tile("m", "Medium"), tile("l", "Large")];

    function makeTiles(value: Size | null, onChange?: (v: Size) => void) {
      controller = new AbortController();
      const cards = createRadioCards<Size>({
        signal: controller.signal,
        labelledBy: "size-label",
        testId: "size",
        layout: "tiles",
        options: TILES,
        value,
        ...(onChange === undefined ? {} : { onChange }),
      });
      document.body.appendChild(cards.el);
      const radios = Array.from(cards.el.querySelectorAll<HTMLButtonElement>("[role='radio']"));
      return { cards, radios };
    }

    it("puts the hidden preview over the name, with a check mark and no dot or hint", () => {
      const { cards, radios } = makeTiles("m");
      expect(cards.el.classList.contains("radio-cards-tiles")).toBe(true);
      const card = radios[1]!;
      const preview = card.querySelector(".radio-card-preview")!;
      expect(preview.getAttribute("aria-hidden")).toBe("true");
      expect(preview.querySelector(".pic-m")).not.toBeNull();
      expect(card.firstElementChild).toBe(preview);
      expect(card.querySelector(".radio-card-check")?.getAttribute("aria-hidden")).toBe("true");
      expect(card.querySelector(".radio-card-dot, .radio-card-icon, .radio-card-desc")).toBeNull();
      expect(card.textContent).toBe("Medium");
      expect(cards.el.querySelector(".radio-cards-hint")).toBeNull();
    });

    it("with a null value checks nothing and makes the first tile the tab stop", () => {
      const { cards, radios } = makeTiles(null);
      expect(cards.value()).toBeNull();
      expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
        "false",
        "false",
        "false",
      ]);
      expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
      expect(cards.group.hasAttribute("data-value")).toBe(false);
    });

    it("Enter or Space checks the focused tile when nothing is checked yet", () => {
      const onChange = vi.fn();
      const { cards, radios } = makeTiles(null, onChange);
      radios[0]!.focus();
      expect(press(radios[0]!, { key: " " }).defaultPrevented).toBe(true);
      expect(cards.value()).toBe("s");
      expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
      press(radios[0]!, { key: "ArrowRight" });
      press(radios[1]!, { key: "Enter" });
      expect(onChange.mock.calls).toEqual([["s"], ["m"]]);
      expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    });
  });

  it("stops listening once its signal aborts", () => {
    const onChange = vi.fn();
    const { radios } = make("s", onChange);
    controller.abort();
    radios[1]!.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
