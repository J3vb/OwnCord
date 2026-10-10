/**
 * A peer's E2EE identity verification (F3 TOFU) as the call surfaces show it:
 * the shield's look, and the re-trust prompt a blocked peer's shield opens.
 * Shared by the server-channel roster (ChannelSidebar) and the DM call panel
 * (D-09), so both draw the same states and re-pin the same way.
 */

import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { PeerVerification } from "@stores/voice.store";
import { rePinPeerIdentity } from "@lib/livekitSession";
import { showToast } from "@lib/toast";
import { createIdentityMismatchModal } from "./IdentityMismatchModal";
import { createLogger } from "@lib/logger";
import { membersStore } from "@stores/members.store";
import { importIdentityPublicKey, computeKeyFingerprint } from "@lib/e2eeCrypto";
import { shellText } from "../i18n/shell";

const log = createLogger("peer-verification");

/** Icon, color, and tooltip for a peer's E2EE identity verification badge
 *  (F3 TOFU). The states mirror the voice store's PeerVerification:
 *  a green shield-check when the announce signature verified against the pinned
 *  key, an amber shield-alert when it verified against a changed key that was
 *  accepted automatically, a muted shield when the peer published no key
 *  (legacy), a red shield-alert when the peer is blocked (pinned key no longer
 *  delivered, or a bad signature), and an amber shield-question when the local
 *  pin store could not be read (DC-08). */
export function verifyPresentation(v: PeerVerification): {
  icon: IconName;
  color: string;
  title: string;
} {
  if (v.status === "changed") {
    return {
      icon: "shield-alert",
      color: "var(--yellow, #f0b232)",
      title: shellText("identity.keyChanged", { safetyNumber: v.safetyNumber ?? "" }),
    };
  }
  if (v.status === "verified") {
    return {
      icon: "shield-check",
      color: "var(--green, #23a559)",
      title:
        v.safetyNumber !== null
          ? shellText("identity.verifiedWithNumber", { safetyNumber: v.safetyNumber })
          : shellText("identity.verified"),
    };
  }
  if (v.status === "mismatch") {
    return {
      icon: "shield-alert",
      color: "var(--red, #f23f43)",
      title: shellText("identity.mismatch"),
    };
  }
  if (v.status === "unknown") {
    return {
      icon: "shield-question",
      color: "var(--yellow, #f0b232)",
      title: shellText("identity.unknown"),
    };
  }
  // "unverified" — the remaining status: peer published no identity key (legacy).
  // No identity key means no safety number; the per-call session fingerprint
  // is the only value that can be compared out of band (OC-0003).
  return {
    icon: "shield",
    color: "var(--text-muted, #949ba4)",
    title:
      v.sessionFingerprint !== null
        ? shellText("identity.unverifiedWithFingerprint", { fingerprint: v.sessionFingerprint })
        : shellText("identity.unverified"),
  };
}

// Identity-mismatch re-pin modal (F3 TOFU). One instance at a time across the
// app, mounted on document.body; torn down on re-open and when the surface
// that opened it (the sidebar or the DM call panel) is destroyed.
let activeIdentityModal: MountableComponent | null = null;

function closeIdentityModal(): void {
  if (activeIdentityModal !== null) {
    activeIdentityModal.destroy?.();
    activeIdentityModal = null;
  }
}

/** Open the re-pin prompt for a blocked peer. `lifetimeSignal` is the opening
 *  surface's own lifetime, never a per-render signal (OC-0281). */
export async function openIdentityMismatchModal(
  userId: number,
  username: string,
  lifetimeSignal: AbortSignal,
): Promise<void> {
  closeIdentityModal();
  // Compute the newly-delivered key's fingerprint so the user can verify it
  // out-of-band before trusting — the whole purpose of the mismatch prompt (the
  // same importIdentityPublicKey→computeKeyFingerprint round-trip verifyPeerAnnounce
  // runs on the verified path). Without it the modal's "verify out-of-band"
  // instruction is unfollowable and "Trust New Key" is a blind accept.
  let fingerprint: string | null = null;
  const publishedKey = membersStore.getState().members.get(userId)?.identityPublicKey ?? null;
  if (publishedKey !== null) {
    try {
      fingerprint = await computeKeyFingerprint(await importIdentityPublicKey(publishedKey));
    } catch (err) {
      log.warn("E2EE: could not compute changed-key fingerprint for re-pin modal", err);
    }
  }
  // The SIDEBAR (or a newer open) may have superseded us during the async
  // compute — but NOT a mere re-render: `lifetimeSignal` is the sidebar's own
  // factory-lifetime signal (aborted only in destroy()), not the per-render
  // one that renderChannels() replaces on every redraw (OC-0281). Binding this
  // check to the render signal made an unrelated re-render landing mid-compute
  // (a message in another channel, a peer toggling mute) turn the click into a
  // silent no-op.
  if (lifetimeSignal.aborted) return;
  closeIdentityModal();
  const modal = createIdentityMismatchModal({
    username,
    fingerprint,
    onAccept: () => {
      // Pin the EXACT key whose fingerprint we displayed and the user verified
      // out-of-band (captured above), NOT a fresh membersStore re-read — a
      // malicious server could mutate the store (user_update) during the human
      // verification window and get its key pinned instead (TOCTOU).
      //
      // Only pin a key whose fingerprint was actually SHOWN: publishedKey null
      // means the server stripped the key, and fingerprint null means it could
      // not be computed (malformed key). In both cases the user saw nothing to
      // verify, so pinning would be a blind accept — refuse it, and say so
      // rather than closing on a silent no-op.
      if (publishedKey === null || fingerprint === null) {
        closeIdentityModal();
        showToast(shellText("identity.rePinFailed"), "error");
        return;
      }
      // Surface keyring/IO failures instead of dropping them — this re-pins a
      // trust anchor, so a silent failure would leave the user believing they
      // recovered when they did not. rePinPeerIdentity returns false (it does
      // not reject) when the pin could not be persisted, so the boolean must
      // be checked too.
      void rePinPeerIdentity(userId, publishedKey)
        .then((ok: boolean) => {
          if (!ok) {
            showToast(shellText("identity.rePinFailed"), "error");
            return;
          }
          closeIdentityModal();
        })
        .catch((err: unknown) => {
          log.error("E2EE: failed to re-pin peer identity", err);
          showToast(shellText("identity.rePinFailed"), "error");
        });
    },
    onReject: () => {
      closeIdentityModal();
    },
  });
  modal.mount(document.body);
  activeIdentityModal = modal;
  // Close if the owning sidebar is destroyed while the modal is still open —
  // NOT on a re-render, which is why this is `lifetimeSignal` and not the
  // render-scoped signal (OC-0281).
  lifetimeSignal.addEventListener("abort", closeIdentityModal, { once: true });
}
