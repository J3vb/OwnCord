import { describe, it, expect, afterEach } from "vitest";
import { holdTypeAhead } from "../../src/lib/ui/typeAhead";

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function field(type = "text"): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("holdTypeAhead", () => {
  it("hands the seed and the keys typed while held to the first text field that takes focus", () => {
    const composer = document.createElement("textarea");
    composer.readOnly = true;
    document.body.appendChild(composer);
    const release = holdTypeAhead("h");
    for (const key of ["e", "l", "l", "o"]) {
      expect(press(document.body, { key }).defaultPrevented).toBe(true);
    }
    const input = field();
    let inputs = 0;
    input.addEventListener("input", () => inputs++);
    input.focus();
    expect(input.value).toBe("hello");
    expect(inputs).toBe(1);
    expect(input.selectionStart).toBe(5);
    release();
  });

  it("keeps the keys from listeners that would route them to the message box", () => {
    let seen = 0;
    const onKey = (): void => {
      seen++;
    };
    document.addEventListener("keydown", onKey);
    const release = holdTypeAhead();
    press(document.body, { key: "a" });
    expect(seen).toBe(0);
    release();
    press(document.body, { key: "a" });
    expect(seen).toBe(1);
    document.removeEventListener("keydown", onKey);
  });

  it("leaves shortcuts, Escape and composing keys alone", () => {
    const release = holdTypeAhead();
    expect(press(document.body, { key: "k", ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: "Escape" }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: "a", isComposing: true }).defaultPrevented).toBe(false);
    const input = field();
    input.focus();
    expect(input.value).toBe("");
    release();
  });

  it("skips a focus that is not an editable text field, and ends at the first that is", () => {
    const release = holdTypeAhead("ab");
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const ro = field();
    ro.readOnly = true;
    ro.focus();
    const checkbox = field("checkbox");
    checkbox.focus();
    const first = field("search");
    first.focus();
    expect(first.value).toBe("ab");
    expect(ro.value).toBe("");
    const second = field();
    press(document.body, { key: "c" });
    second.focus();
    expect(second.value).toBe("");
    release();
  });

  it("drops what it held once released", () => {
    const release = holdTypeAhead("x");
    press(document.body, { key: "y" });
    release();
    const input = field();
    input.focus();
    expect(input.value).toBe("");
    expect(press(document.body, { key: "z" }).defaultPrevented).toBe(false);
  });
});
