import { describe, it, expect } from "vitest";
import { createCertMismatchModal } from "../../src/components/CertMismatchModal";
import {
  checkAcceptClick,
  checkBackdropRejects,
  checkBodyClickDoesNotReject,
  checkCloseButtonLabel,
  checkDestroyRemovesModal,
  checkDialogSemantics,
  checkDragSelectDoesNotReject,
  checkEscapeIgnoredAfterDestroyRejecting,
  checkEscapeRejects,
  checkFocusRestored,
  checkRejectClick,
  checkVisibleOverlay,
  useWarningModal,
  type WarningOpts,
} from "../helpers/warningModalHarness";
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
  const { container, mountModal } = useWarningModal<WarningOpts<typeof createCertMismatchModal>>(
    createCertMismatchModal,
    {
      host: "localhost:8443",
      storedFingerprint: "AA:BB:CC:DD",
      newFingerprint: "11:22:33:44",
    },
  );

  it("renders a visible modal overlay", () => checkVisibleOverlay(mountModal, container()));

  it("displays the host in the details", () => {
    mountModal();
    const values = container().querySelectorAll(".cert-value");
    const texts = Array.from(values).map((el) => el.textContent);
    expect(texts).toContain("localhost:8443");
  });

  it("displays stored and new fingerprints", () => {
    mountModal();
    const fps = container().querySelectorAll(".cert-fingerprint");
    const texts = Array.from(fps).map((el) => el.textContent);
    expect(texts).toContain("AA:BB:CC:DD");
    expect(texts).toContain("11:22:33:44");
  });

  it("tells the user how to verify the new fingerprint before accepting", () => {
    mountModal();
    const desc = container().querySelector(".cert-desc")?.textContent ?? "";
    // Routine public-CA renewals are re-pinned silently, so the prompt must
    // not call a change routine; it asks for extra care instead...
    expect(desc).not.toMatch(/routine, but/);
    expect(desc).toMatch(/public certificate authorities no longer prompt/);
    expect(desc).toMatch(/extra care/);
    // ...and it says how to check: who has the value, where they find it,
    // which row to compare, over which channel, and what to do otherwise.
    expect(desc).toMatch(/server owner/);
    expect(desc).toMatch(/admin Dashboard/);
    expect(desc).toMatch(/matches Current/);
    expect(desc).toMatch(/another channel/);
    expect(desc).toMatch(/choose Disconnect/);
  });

  it("shows 'Unknown' when storedFingerprint is empty", () => {
    mountModal({ storedFingerprint: "" });
    const fps = container().querySelectorAll(".cert-fingerprint");
    const texts = Array.from(fps).map((el) => el.textContent);
    expect(texts).toContain("Unknown");
  });

  it("calls onAccept when accept button is clicked", () =>
    checkAcceptClick(mountModal, container()));

  it("calls onReject when disconnect button is clicked", () =>
    checkRejectClick(mountModal, container(), ".btn-ghost"));

  it("calls onReject when close X button is clicked", () =>
    checkRejectClick(mountModal, container(), ".modal-close"));

  it("calls onReject when backdrop is clicked", () =>
    checkBackdropRejects(mountModal, container()));

  it("stays open when a drag-select ends on the backdrop", () =>
    checkDragSelectDoesNotReject(mountModal, container()));

  it("does not call onReject when modal body is clicked", () =>
    checkBodyClickDoesNotReject(mountModal, container()));

  it("destroy removes the modal from the DOM", () =>
    checkDestroyRemovesModal(mountModal, container()));

  it("displays the title 'Certificate Warning'", () => {
    mountModal();
    const title = container().querySelector(".modal-header h3");
    expect(title?.textContent).toBe("Certificate Warning");
  });

  it("displays the cert title 'Certificate Changed'", () => {
    mountModal();
    const title = container().querySelector(".cert-title");
    expect(title?.textContent).toBe("Certificate Changed");
  });

  it("carries dialog semantics labelled by the h3 title", () =>
    checkDialogSemantics(mountModal, container(), "cert-mismatch-title", "Certificate Warning"));

  it("gives the icon-only close button an accessible name", () =>
    checkCloseButtonLabel(mountModal, container()));

  it("calls onReject when Escape is pressed", () => checkEscapeRejects(mountModal));

  it("does not call onReject on Escape after destroy", () =>
    checkEscapeIgnoredAfterDestroyRejecting(mountModal));

  it("moves focus inside the modal on mount and restores it on destroy", () =>
    checkFocusRestored(mountModal, container()));
});
