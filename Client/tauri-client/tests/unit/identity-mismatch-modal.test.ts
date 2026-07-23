import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdentityMismatchModal } from "../../src/components/CertMismatchModal";

// ---------------------------------------------------------------------------
// IdentityMismatchModal — the E2EE-identity analogue of the cert-mismatch
// modal (F3 TOFU). Surfaces a peer whose voice identity key no longer matches
// the pinned one, and offers re-pin recovery for legitimate key rotation.
// ---------------------------------------------------------------------------

describe("IdentityMismatchModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function mountModal(overrides?: Partial<Parameters<typeof createIdentityMismatchModal>[0]>) {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const modal = createIdentityMismatchModal({
      username: "Alice",
      fingerprint: "AB12 CD34 EF56 7890",
      onAccept,
      onReject,
      ...overrides,
    });
    modal.mount(container);
    return { modal, onAccept, onReject };
  }

  it("renders a visible modal overlay", () => {
    mountModal();
    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.classList.contains("visible")).toBe(true);
  });

  it("displays the peer username in the details", () => {
    mountModal();
    const values = container.querySelectorAll(".cert-value");
    const texts = Array.from(values).map((el) => el.textContent);
    expect(texts).toContain("Alice");
  });

  it("displays the new identity-key fingerprint when provided", () => {
    mountModal();
    const fps = container.querySelectorAll(".cert-fingerprint");
    const texts = Array.from(fps).map((el) => el.textContent);
    expect(texts).toContain("AB12 CD34 EF56 7890");
  });

  it("omits the fingerprint row when fingerprint is null", () => {
    mountModal({ fingerprint: null });
    expect(container.querySelectorAll(".cert-fingerprint").length).toBe(0);
  });

  it("calls onAccept when the trust button is clicked", () => {
    const { onAccept } = mountModal();
    const btn = container.querySelector(".btn-danger") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("calls onReject when the cancel button is clicked", () => {
    const { onReject } = mountModal();
    const btn = container.querySelector(".btn-ghost") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("calls onReject when the close X button is clicked", () => {
    const { onReject } = mountModal();
    const btn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("calls onReject when the backdrop is clicked", () => {
    const { onReject } = mountModal();
    const overlay = container.querySelector(".modal-overlay") as HTMLDivElement;
    overlay.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("does not call onReject when the modal body is clicked", () => {
    const { onReject } = mountModal();
    const modal = container.querySelector(".modal") as HTMLDivElement;
    modal.click();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("destroy removes the modal from the DOM", () => {
    const { modal } = mountModal();
    expect(container.querySelector(".modal-overlay")).not.toBeNull();
    modal.destroy?.();
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("displays the title 'Identity Warning'", () => {
    mountModal();
    const title = container.querySelector(".modal-header h3");
    expect(title?.textContent).toBe("Identity Warning");
  });

  it("displays the cert title 'Identity Key Changed'", () => {
    mountModal();
    const title = container.querySelector(".cert-title");
    expect(title?.textContent).toBe("Identity Key Changed");
  });
});
