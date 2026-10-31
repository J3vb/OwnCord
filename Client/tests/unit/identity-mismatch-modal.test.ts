import { describe, it, expect } from "vitest";
import { createIdentityMismatchModal } from "../../src/components/IdentityMismatchModal";
import {
  checkVisibleOverlay,
  registerWarningModalTests,
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

  registerWarningModalTests(
    { container, mountModal },
    {
      accept: "calls onAccept when the trust button is clicked",
      reject: "calls onReject when the cancel button is clicked",
      close: "calls onReject when the close X button is clicked",
      backdrop: "calls onReject when the backdrop is clicked",
      body: "does not call onReject when the modal body is clicked",
      title: "Identity Warning",
      certTitle: "Identity Not Verified",
      titleId: "identity-mismatch-title",
    },
  );
});
