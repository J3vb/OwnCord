import { describe, it, expect, vi } from "vitest";
import { createCertFirstUseModal } from "../../src/components/CertMismatchModal";

describe("createCertFirstUseModal (F4/F8)", () => {
  it("renders the host + fingerprint and wires accept/reject", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const modal = createCertFirstUseModal({
      host: "example.com:8443",
      fingerprint: "aa:bb:cc:dd:ee:ff",
      onAccept,
      onReject,
    });

    const container = document.createElement("div");
    modal.mount(container);

    const text = container.textContent ?? "";
    expect(text).toContain("example.com:8443");
    expect(text).toContain("aa:bb:cc:dd:ee:ff");

    const buttons = Array.from(container.querySelectorAll("button"));
    const trustBtn = buttons.find((b) => b.textContent === "Trust This Certificate");
    const cancelBtn = buttons.find((b) => b.textContent === "Cancel");
    expect(trustBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();

    trustBtn!.click();
    expect(onAccept).toHaveBeenCalledTimes(1);

    cancelBtn!.click();
    expect(onReject).toHaveBeenCalledTimes(1);

    modal.destroy?.();
    expect(container.querySelector(".modal-overlay")).toBeNull();
  });

  it("carries dialog semantics labelled by the h3 title", () => {
    const modal = createCertFirstUseModal({
      host: "example.com:8443",
      fingerprint: "aa:bb:cc:dd:ee:ff",
      onAccept: vi.fn(),
      onReject: vi.fn(),
    });

    const container = document.createElement("div");
    modal.mount(container);

    const dialog = container.querySelector(".modal");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("cert-first-use-title");
    expect(container.querySelector("#cert-first-use-title")?.textContent).toBe(
      "New Server Certificate",
    );
    expect(container.querySelector(".modal-close")?.getAttribute("aria-label")).toBe("Close");

    modal.destroy?.();
  });

  it("rejects on Escape while mounted, but not after destroy", () => {
    const onReject = vi.fn();
    const modal = createCertFirstUseModal({
      host: "example.com:8443",
      fingerprint: "aa:bb:cc:dd:ee:ff",
      onAccept: vi.fn(),
      onReject,
    });

    // Escape listens on document and guards on overlay.isConnected, so the
    // container has to actually be in the document here.
    const container = document.createElement("div");
    document.body.appendChild(container);
    modal.mount(container);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onReject).toHaveBeenCalledTimes(1);

    modal.destroy?.();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onReject).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it("moves focus inside the modal on mount and restores it on destroy", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const modal = createCertFirstUseModal({
      host: "example.com:8443",
      fingerprint: "aa:bb:cc:dd:ee:ff",
      onAccept: vi.fn(),
      onReject: vi.fn(),
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    modal.mount(container);

    expect(container.contains(document.activeElement)).toBe(true);

    modal.destroy?.();
    expect(document.activeElement).toBe(outside);
    container.remove();
    outside.remove();
  });
});
