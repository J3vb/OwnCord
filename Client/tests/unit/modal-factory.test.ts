import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createModal, createPromptModal } from "../../src/lib/modalFactory";

describe("createModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clean up any stray overlays
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  it("renders with correct structure (overlay > modal > content)", () => {
    const content = document.createElement("div");
    content.textContent = "Hello";

    const inst = createModal({ content }, container);

    expect(inst.overlay.classList.contains("modal-overlay")).toBe(true);
    expect(inst.overlay.classList.contains("visible")).toBe(true);
    expect(inst.modal.classList.contains("modal")).toBe(true);
    expect(inst.modal.textContent).toBe("Hello");
    expect(container.contains(inst.overlay)).toBe(true);
  });

  it("applies additional className to modal container", () => {
    const content = document.createElement("div");
    const inst = createModal({ content, className: "dm-picker" }, container);

    expect(inst.modal.classList.contains("modal")).toBe(true);
    expect(inst.modal.classList.contains("dm-picker")).toBe(true);
  });

  it("applies overlay attributes", () => {
    const content = document.createElement("div");
    const inst = createModal({ content, overlayAttrs: { "data-testid": "my-modal" } }, container);

    expect(inst.overlay.getAttribute("data-testid")).toBe("my-modal");
  });

  it("backdrop click closes and calls onClose", () => {
    const onClose = vi.fn();
    const content = document.createElement("div");
    const inst = createModal({ content, onClose }, container);

    // Click on the overlay itself (not the modal content)
    inst.overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.contains(inst.overlay)).toBe(false);
  });

  it("clicking inside modal does not close", () => {
    const onClose = vi.fn();
    const content = document.createElement("div");
    content.textContent = "inner";
    const inst = createModal({ content, onClose }, container);

    // Click on the modal content, not the overlay
    inst.modal.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
    expect(container.contains(inst.overlay)).toBe(true);
  });

  it("Escape key closes and calls onClose", () => {
    const onClose = vi.fn();
    const content = document.createElement("div");
    createModal({ content, onClose }, container);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close() removes from DOM", () => {
    const content = document.createElement("div");
    const inst = createModal({ content }, container);

    expect(container.contains(inst.overlay)).toBe(true);

    inst.close();

    expect(container.contains(inst.overlay)).toBe(false);
  });

  it("destroy() removes from DOM (alias for close)", () => {
    const content = document.createElement("div");
    const inst = createModal({ content }, container);

    inst.destroy();

    expect(container.contains(inst.overlay)).toBe(false);
  });

  it("closeOnBackdrop=false prevents backdrop close", () => {
    const onClose = vi.fn();
    const content = document.createElement("div");
    const inst = createModal({ content, onClose, closeOnBackdrop: false }, container);

    inst.overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).not.toHaveBeenCalled();
    expect(container.contains(inst.overlay)).toBe(true);
  });

  it("closeOnEscape=false prevents Escape close", () => {
    const onClose = vi.fn();
    const content = document.createElement("div");
    createModal({ content, onClose, closeOnEscape: false }, container);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("cleans up when external signal is aborted", () => {
    const externalAc = new AbortController();
    const content = document.createElement("div");
    const inst = createModal({ content, signal: externalAc.signal }, container);

    expect(container.contains(inst.overlay)).toBe(true);

    externalAc.abort();

    expect(container.contains(inst.overlay)).toBe(false);
  });

  it("onClose is called only once even with multiple close triggers", () => {
    const onClose = vi.fn();
    const content = document.createElement("div");
    const inst = createModal({ content, onClose }, container);

    inst.close();
    inst.close();
    inst.destroy();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("external abort removes the modal and fires onClose exactly once", () => {
    const onClose = vi.fn();
    const externalAc = new AbortController();
    const content = document.createElement("div");
    const inst = createModal({ content, onClose, signal: externalAc.signal }, container);

    externalAc.abort();

    expect(container.contains(inst.overlay)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    // A close() after the abort must not re-fire onClose or throw.
    inst.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── dialog accessibility contract (DC-13) ─────────────────────────────────

  it("stamps dialog semantics on the modal container", () => {
    const content = document.createElement("div");
    const inst = createModal({ content, ariaLabel: "Pick members" }, container);

    expect(inst.modal.getAttribute("role")).toBe("dialog");
    expect(inst.modal.getAttribute("aria-modal")).toBe("true");
    expect(inst.modal.getAttribute("aria-label")).toBe("Pick members");
    inst.destroy();
  });

  it("moves focus into the dialog on open and restores it on close", () => {
    const trigger = document.createElement("button");
    container.appendChild(trigger);
    trigger.focus();

    const content = document.createElement("div");
    const btn = document.createElement("button");
    content.appendChild(btn);
    const inst = createModal({ content }, container);

    expect(document.activeElement).toBe(btn);

    inst.close();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus when torn down by the external signal", () => {
    const trigger = document.createElement("button");
    container.appendChild(trigger);
    trigger.focus();

    const externalAc = new AbortController();
    const inst = createModal(
      { content: document.createElement("div"), signal: externalAc.signal },
      container,
    );
    expect(document.activeElement).toBe(inst.modal);

    externalAc.abort();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps Tab inside the dialog (wraps last → first)", () => {
    const content = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("button");
    content.appendChild(first);
    content.appendChild(last);
    const inst = createModal({ content }, container);

    last.focus();
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    inst.destroy();
  });
});

describe("createPromptModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  function getInput(): HTMLInputElement {
    const el = document.querySelector<HTMLInputElement>("[data-testid='prompt-input']");
    if (el === null) throw new Error("prompt input not rendered");
    return el;
  }

  function clickConfirm(): void {
    document.querySelector<HTMLButtonElement>("[data-testid='prompt-confirm']")?.click();
  }

  function clickCancel(): void {
    document.querySelector<HTMLButtonElement>("[data-testid='prompt-cancel']")?.click();
  }

  it("renders title, optional label, and defaults", () => {
    createPromptModal({ title: "Rename group", label: "Group name", onSubmit: vi.fn() }, container);

    expect(document.querySelector("h3")?.textContent).toBe("Rename group");
    expect(document.body.textContent).toContain("Group name");
    const input = getInput();
    expect(input.placeholder).toBe("");
    expect(input.getAttribute("maxlength")).toBe("100");
    expect(
      document.querySelector<HTMLButtonElement>("[data-testid='prompt-confirm']")?.textContent,
    ).toBe("Save");
  });

  it("honors placeholder, maxLength, confirmLabel, testId, and initialValue", () => {
    createPromptModal(
      {
        title: "t",
        placeholder: "Type here",
        maxLength: 32,
        confirmLabel: "Rename",
        testId: "rename-input",
        initialValue: "old name",
        onSubmit: vi.fn(),
      },
      container,
    );

    const input = document.querySelector<HTMLInputElement>("[data-testid='rename-input']");
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe("Type here");
    expect(input?.getAttribute("maxlength")).toBe("32");
    expect(input?.value).toBe("old name");
    expect(
      document.querySelector<HTMLButtonElement>("[data-testid='prompt-confirm']")?.textContent,
    ).toBe("Rename");
  });

  it("confirm submits the trimmed value and closes", () => {
    const onSubmit = vi.fn();
    const inst = createPromptModal({ title: "t", onSubmit }, container);

    getInput().value = "  spaced out  ";
    clickConfirm();

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("spaced out");
    expect(container.contains(inst.overlay)).toBe(false);
  });

  it("submits an empty value — clearing a name is a legitimate submission", () => {
    const onSubmit = vi.fn();
    createPromptModal({ title: "t", initialValue: "old", onSubmit }, container);

    getInput().value = "   ";
    clickConfirm();

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("");
  });

  it("Enter submits and prevents the default", () => {
    const onSubmit = vi.fn();
    createPromptModal({ title: "t", onSubmit }, container);

    const input = getInput();
    input.value = "via enter";
    const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input.dispatchEvent(ev);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("via enter");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("cancel closes without submitting and fires onClose", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const inst = createPromptModal({ title: "t", onSubmit, onClose }, container);

    getInput().value = "discarded";
    clickCancel();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.contains(inst.overlay)).toBe(false);
  });

  it("onClose fires on submit too — close and submit are one gesture", () => {
    const onClose = vi.fn();
    createPromptModal({ title: "t", onSubmit: vi.fn(), onClose }, container);

    clickConfirm();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
