import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./shortcodes", () => ({
  replaceEmojiShortcodes: (text: string) => text.replaceAll(":joy:", "\u{1F602}"),
}));

import { createInlineEdit, type InlineEditOptions, type InlineEditSession } from "./inlineEdit";
import { MAX_MESSAGE_LEN } from "./messageLimits";

const open: InlineEditSession[] = [];

function make(overrides: Partial<InlineEditOptions> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onEmpty = vi.fn();
  const session = createInlineEdit({
    messageId: 7,
    text: "hello",
    onSave,
    onCancel,
    onEmpty,
    ...overrides,
  });
  open.push(session);
  document.body.append(session.element);
  return { session, onSave, onCancel, onEmpty };
}

function key(target: HTMLElement, init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function type(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function select(textarea: HTMLTextAreaElement, start: number, end: number): void {
  textarea.setSelectionRange(start, end);
}

afterEach(() => {
  for (const session of open.splice(0)) session.destroy();
  document.body.replaceChildren();
});

describe("inline editor markup", () => {
  it("builds a labelled textarea holding the message text, a hint and a hidden error line", () => {
    const { session } = make();
    expect(session.element.className).toBe("msg-inline-edit");
    expect(session.textarea.className).toBe("msg-inline-edit-input");
    expect(session.textarea.className).not.toContain("msg-textarea");
    expect(session.textarea.getAttribute("data-testid")).toBe("msg-edit-input-7");
    expect(session.textarea.getAttribute("aria-label")).toBe("Edit message");
    expect(session.textarea.getAttribute("rows")).toBe("1");
    expect(session.textarea.value).toBe("hello");

    const hint = session.element.querySelector(".msg-inline-edit-hint");
    expect(hint?.textContent).toBe("escape to cancel • enter to save");

    const error = session.element.querySelector<HTMLElement>(".msg-inline-edit-error");
    expect(error?.id).toBe("msg-edit-error-7");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.hidden).toBe(true);
    expect(error?.textContent).toBe("");
    expect([...session.element.children].map((c) => c.className)).toEqual([
      "msg-inline-edit-input",
      "msg-inline-edit-hint",
      "msg-inline-edit-error",
    ]);
  });

  it("gives the cancel and save links button semantics and per-message test ids", () => {
    const { session } = make();
    const cancel = session.element.querySelector<HTMLButtonElement>(
      '[data-testid="msg-edit-cancel-7"]',
    );
    const save = session.element.querySelector<HTMLButtonElement>(
      '[data-testid="msg-edit-save-7"]',
    );
    expect(cancel?.textContent).toBe("cancel");
    expect(save?.textContent).toBe("save");
    for (const link of [cancel, save]) {
      expect(link?.type).toBe("button");
      expect(link?.className).toBe("msg-inline-edit-link");
    }
  });
});

describe("inline editor error line", () => {
  it("shows a message and points the field at it, then clears both", () => {
    const { session } = make();
    const error = session.element.querySelector<HTMLElement>(".msg-inline-edit-error")!;
    session.setError("Too long");
    expect(error.textContent).toBe("Too long");
    expect(error.hidden).toBe(false);
    expect(session.textarea.getAttribute("aria-invalid")).toBe("true");
    expect(session.textarea.getAttribute("aria-describedby")).toBe("msg-edit-error-7");

    session.setError(null);
    expect(error.textContent).toBe("");
    expect(error.hidden).toBe(true);
    expect(session.textarea.hasAttribute("aria-invalid")).toBe(false);
    expect(session.textarea.hasAttribute("aria-describedby")).toBe(false);
  });

  it("typing re-measures the field first from auto height and clears the error", () => {
    const { session } = make();
    const heightWhenMeasured: string[] = [];
    Object.defineProperty(session.textarea, "scrollHeight", {
      configurable: true,
      get: () => {
        heightWhenMeasured.push(session.textarea.style.height);
        return 96;
      },
    });
    session.setError("Too long");
    type(session.textarea, "hello there");
    expect(heightWhenMeasured).toEqual(["auto"]);
    expect(session.textarea.style.height).toBe("96px");
    expect(session.element.querySelector<HTMLElement>(".msg-inline-edit-error")?.hidden).toBe(true);
    expect(session.textarea.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("inline editor saving", () => {
  it("Enter saves the trimmed text with emoji shortcodes replaced", () => {
    const { session, onSave, onCancel, onEmpty } = make();
    session.textarea.value = "  fun :joy:  \n";
    const event = key(session.textarea, { key: "Enter" });
    expect(event.defaultPrevented).toBe(true);
    expect(onSave).toHaveBeenCalledExactlyOnceWith("fun \u{1F602}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it("the save link saves the same way", () => {
    const { session, onSave } = make();
    session.textarea.value = " edited ";
    session.element.querySelector<HTMLButtonElement>('[data-testid="msg-edit-save-7"]')?.click();
    expect(onSave).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("Shift+Enter is left to insert a newline", () => {
    const { session, onSave } = make();
    const event = key(session.textarea, { key: "Enter", shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("an empty or blank text asks the host to offer deleting instead of saving", () => {
    const { session, onSave, onEmpty } = make();
    session.textarea.value = " \n\t ";
    key(session.textarea, { key: "Enter" });
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses a text over the limit with an inline message", () => {
    const { session, onSave } = make();
    session.textarea.value = "x".repeat(MAX_MESSAGE_LEN + 1);
    key(session.textarea, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    const error = session.element.querySelector<HTMLElement>(".msg-inline-edit-error")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(`Messages are limited to ${MAX_MESSAGE_LEN} characters`);
    expect(session.textarea.getAttribute("aria-invalid")).toBe("true");
  });

  it("saves a text of exactly the limit and clears an earlier error", () => {
    const { session, onSave } = make();
    session.setError("old problem");
    session.textarea.value = "x".repeat(MAX_MESSAGE_LEN);
    key(session.textarea, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(session.element.querySelector<HTMLElement>(".msg-inline-edit-error")?.hidden).toBe(true);
  });

  it("counts code points, as the server does, not UTF-16 units", () => {
    const { session, onSave } = make();
    session.textarea.value = "\u{1F600}".repeat(MAX_MESSAGE_LEN);
    key(session.textarea, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
    session.textarea.value = "\u{1F600}".repeat(MAX_MESSAGE_LEN + 1);
    key(session.textarea, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("an Enter that commits an IME candidate does not save", () => {
    const { session, onSave } = make();
    const composing = key(session.textarea, { key: "Enter", isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    const legacy = key(session.textarea, { key: "Enter", keyCode: 229 });
    expect(legacy.defaultPrevented).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("inline editor cancelling", () => {
  it("Escape cancels and is used up", () => {
    const { session, onCancel, onSave } = make();
    const event = key(session.textarea, { key: "Escape" });
    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the cancel link cancels", () => {
    const { session, onCancel } = make();
    session.element.querySelector<HTMLButtonElement>('[data-testid="msg-edit-cancel-7"]')?.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("an Escape that cancels an IME composition does not cancel the edit", () => {
    const { session, onCancel } = make();
    const composing = key(session.textarea, { key: "Escape", isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    key(session.textarea, { key: "Escape", keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("other keys do nothing", () => {
    const { session, onCancel, onSave } = make();
    const event = key(session.textarea, { key: "a" });
    expect(event.defaultPrevented).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("inline editor formatting shortcuts", () => {
  it("Ctrl+B wraps the selection in bold markers and keeps it selected", () => {
    const { session, onSave } = make({ text: "say hello now" });
    select(session.textarea, 4, 9);
    const parentSeen = vi.fn();
    document.body.addEventListener("keydown", parentSeen);
    const event = key(session.textarea, { key: "b", ctrlKey: true });
    document.body.removeEventListener("keydown", parentSeen);
    expect(event.defaultPrevented).toBe(true);
    expect(parentSeen).not.toHaveBeenCalled();
    expect(session.textarea.value).toBe("say **hello** now");
    expect(session.textarea.selectionStart).toBe(6);
    expect(session.textarea.selectionEnd).toBe(11);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Cmd+I and Ctrl+U use italic and underline markers, whatever the key's case", () => {
    const { session } = make({ text: "word" });
    select(session.textarea, 0, 4);
    key(session.textarea, { key: "I", metaKey: true });
    expect(session.textarea.value).toBe("*word*");
    session.textarea.value = "word";
    select(session.textarea, 0, 4);
    key(session.textarea, { key: "u", ctrlKey: true });
    expect(session.textarea.value).toBe("__word__");
  });

  it("re-measures the field after wrapping", () => {
    const { session } = make({ text: "word" });
    Object.defineProperty(session.textarea, "scrollHeight", { configurable: true, value: 64 });
    select(session.textarea, 0, 4);
    key(session.textarea, { key: "b", ctrlKey: true });
    expect(session.textarea.style.height).toBe("64px");
  });

  it("leaves Ctrl+Alt, Ctrl+Shift and unknown letters alone", () => {
    const { session } = make({ text: "word" });
    select(session.textarea, 0, 4);
    const withAlt = key(session.textarea, { key: "b", ctrlKey: true, altKey: true });
    const withShift = key(session.textarea, { key: "b", ctrlKey: true, shiftKey: true });
    const unknown = key(session.textarea, { key: "x", ctrlKey: true });
    expect(session.textarea.value).toBe("word");
    expect(withAlt.defaultPrevented).toBe(false);
    expect(withShift.defaultPrevented).toBe(false);
    expect(unknown.defaultPrevented).toBe(false);
  });

  it("a bare letter with no modifier types normally", () => {
    const { session } = make({ text: "word" });
    select(session.textarea, 0, 4);
    const event = key(session.textarea, { key: "b" });
    expect(event.defaultPrevented).toBe(false);
    expect(session.textarea.value).toBe("word");
  });
});

describe("inline editor focus and teardown", () => {
  it("focusEnd focuses the field with the caret after the last character", () => {
    const { session } = make({ text: "hello" });
    Object.defineProperty(session.textarea, "scrollHeight", { configurable: true, value: 40 });
    session.textarea.setSelectionRange(0, 0);
    session.focusEnd();
    expect(document.activeElement).toBe(session.textarea);
    expect(session.textarea.selectionStart).toBe(5);
    expect(session.textarea.selectionEnd).toBe(5);
    expect(session.textarea.style.height).toBe("40px");
  });

  it("focusEnd does not scroll the page to the field", () => {
    const { session } = make();
    const focus = vi.spyOn(session.textarea, "focus");
    session.focusEnd();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("typing after destroy no longer touches the field", () => {
    const { session } = make();
    session.setError("Too long");
    session.destroy();
    type(session.textarea, "more");
    expect(session.textarea.getAttribute("aria-invalid")).toBe("true");
    expect(session.textarea.style.height).toBe("");
  });

  it("destroy takes the editor out of the page and stops its listeners", () => {
    const { session, onSave, onCancel } = make();
    const cancel = session.element.querySelector<HTMLButtonElement>(
      '[data-testid="msg-edit-cancel-7"]',
    )!;
    const save = session.element.querySelector<HTMLButtonElement>(
      '[data-testid="msg-edit-save-7"]',
    )!;
    session.destroy();
    expect(session.element.isConnected).toBe(false);
    key(session.textarea, { key: "Enter" });
    key(session.textarea, { key: "Escape" });
    cancel.click();
    save.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
