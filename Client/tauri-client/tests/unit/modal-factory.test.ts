import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createModal } from "../../src/lib/modalFactory";

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
});
