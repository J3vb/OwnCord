import { describe, it, expect } from "vitest";
import { createIdentityMismatchModal } from "../../src/components/IdentityMismatchModal";
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

// ---------------------------------------------------------------------------
// IdentityMismatchModal — the E2EE-identity analogue of the cert-mismatch
// modal (F3 TOFU). Surfaces a peer whose voice identity key no longer matches
// the pinned one, and offers re-pin recovery for legitimate key rotation.
// ---------------------------------------------------------------------------

describe("IdentityMismatchModal", () => {
  const { container, mountModal } = useWarningModal<
    WarningOpts<typeof createIdentityMismatchModal>
  >(createIdentityMismatchModal, {
    username: "Alice",
    fingerprint: "AB12 CD34 EF56 7890",
  });

  it("renders a visible modal overlay", () => checkVisibleOverlay(mountModal, container()));

  it("displays the peer username in the details", () => {
    mountModal();
    const values = container().querySelectorAll(".cert-value");
    const texts = Array.from(values).map((el) => el.textContent);
    expect(texts).toContain("Alice");
  });

  it("displays the new identity-key fingerprint when provided", () => {
    mountModal();
    const fps = container().querySelectorAll(".cert-fingerprint");
    const texts = Array.from(fps).map((el) => el.textContent);
    expect(texts).toContain("AB12 CD34 EF56 7890");
  });

  it("omits the fingerprint row when fingerprint is null", () => {
    mountModal({ fingerprint: null });
    expect(container().querySelectorAll(".cert-fingerprint").length).toBe(0);
  });

  it("calls onAccept when the trust button is clicked", () =>
    checkAcceptClick(mountModal, container()));

  it("calls onReject when the cancel button is clicked", () =>
    checkRejectClick(mountModal, container(), ".btn-ghost"));

  it("calls onReject when the close X button is clicked", () =>
    checkRejectClick(mountModal, container(), ".modal-close"));

  it("calls onReject when the backdrop is clicked", () =>
    checkBackdropRejects(mountModal, container()));

  it("stays open when a drag-select ends on the backdrop", () =>
    checkDragSelectDoesNotReject(mountModal, container()));

  it("does not call onReject when the modal body is clicked", () =>
    checkBodyClickDoesNotReject(mountModal, container()));

  it("destroy removes the modal from the DOM", () =>
    checkDestroyRemovesModal(mountModal, container()));

  it("displays the title 'Identity Warning'", () => {
    mountModal();
    const title = container().querySelector(".modal-header h3");
    expect(title?.textContent).toBe("Identity Warning");
  });

  it("displays the cert title 'Identity Not Verified'", () => {
    mountModal();
    const title = container().querySelector(".cert-title");
    expect(title?.textContent).toBe("Identity Not Verified");
  });

  it("carries dialog semantics labelled by the h3 title", () =>
    checkDialogSemantics(mountModal, container(), "identity-mismatch-title", "Identity Warning"));

  it("gives the icon-only close button an accessible name", () =>
    checkCloseButtonLabel(mountModal, container()));

  it("calls onReject when Escape is pressed", () => checkEscapeRejects(mountModal));

  it("does not call onReject on Escape after destroy", () =>
    checkEscapeIgnoredAfterDestroyRejecting(mountModal));

  it("moves focus inside the modal on mount and restores it on destroy", () =>
    checkFocusRestored(mountModal, container()));
});
