import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCertMismatchModal } from "../../src/components/CertMismatchModal";
import { parseStoredFingerprint } from "../../src/lib/ws";

// ---------------------------------------------------------------------------
// parseStoredFingerprint
// ---------------------------------------------------------------------------

describe("parseStoredFingerprint", () => {
  it("extracts stored fingerprint from Rust message", () => {
    const msg =
      "Certificate fingerprint changed for localhost:8443.\n" +
      "Stored:  51:32:d1:f9:61:47:e4:cc:26:6f:3a:87\n" +
      "Current: 23:e4:00:61:11:f7:e5:12:eb:b9:2d:19\n" +
      "This may indicate a man-in-the-middle attack.";
    expect(parseStoredFingerprint(msg)).toBe("51:32:d1:f9:61:47:e4:cc:26:6f:3a:87");
  });

  it("returns undefined for undefined message", () => {
    expect(parseStoredFingerprint(undefined)).toBeUndefined();
  });

  it("returns undefined when no Stored line present", () => {
    expect(parseStoredFingerprint("some other message")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseStoredFingerprint("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CertMismatchModal
// ---------------------------------------------------------------------------

describe("CertMismatchModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function mountModal(overrides?: Partial<Parameters<typeof createCertMismatchModal>[0]>) {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const modal = createCertMismatchModal({
      host: "localhost:8443",
      storedFingerprint: "AA:BB:CC:DD",
      newFingerprint: "11:22:33:44",
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

  it("displays the host in the details", () => {
    mountModal();
    const values = container.querySelectorAll(".cert-value");
    const texts = Array.from(values).map((el) => el.textContent);
    expect(texts).toContain("localhost:8443");
  });

  it("displays stored and new fingerprints", () => {
    mountModal();
    const fps = container.querySelectorAll(".cert-fingerprint");
    const texts = Array.from(fps).map((el) => el.textContent);
    expect(texts).toContain("AA:BB:CC:DD");
    expect(texts).toContain("11:22:33:44");
  });

  it("shows 'Unknown' when storedFingerprint is empty", () => {
    mountModal({ storedFingerprint: "" });
    const fps = container.querySelectorAll(".cert-fingerprint");
    const texts = Array.from(fps).map((el) => el.textContent);
    expect(texts).toContain("Unknown");
  });

  it("calls onAccept when accept button is clicked", () => {
    const { onAccept } = mountModal();
    const btn = container.querySelector(".btn-danger") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("calls onReject when disconnect button is clicked", () => {
    const { onReject } = mountModal();
    const btn = container.querySelector(".btn-ghost") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("calls onReject when close X button is clicked", () => {
    const { onReject } = mountModal();
    const btn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("calls onReject when backdrop is clicked", () => {
    const { onReject } = mountModal();
    const overlay = container.querySelector(".modal-overlay") as HTMLDivElement;
    overlay.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("does not call onReject when modal body is clicked", () => {
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

  it("displays the title 'Certificate Warning'", () => {
    mountModal();
    const title = container.querySelector(".modal-header h3");
    expect(title?.textContent).toBe("Certificate Warning");
  });

  it("displays the cert title 'Certificate Changed'", () => {
    mountModal();
    const title = container.querySelector(".cert-title");
    expect(title?.textContent).toBe("Certificate Changed");
  });
});
