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
});
