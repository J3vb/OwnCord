// Steps of the voice E2EE peer check that hold no state of their own: reading
// a pin lookup, deciding whether a delivered key is new for a pinned peer or
// needs a pin write, logging the pin write outcome, resolving the identity key
// an announce is checked against (a read of the members store) and showing the
// new-device notice (a toast).
import { getIdentityPin, storeIdentityPin } from "../../lib/net/identity";
import { trustedPins } from "../../lib/net/identityPins";
import { createLogger } from "../../lib/logger";
import { memberDisplayName, membersStore } from "../../stores/members.store";
import { showToast } from "../../lib/ui/toast";
import { voiceText } from "../../i18n/voice";

// Same logger tag as the peer state, so the E2EE log lines are unchanged.
const log = createLogger("livekitE2EE");

/** An announce held back from verification, kept for a re-pin to replay. */
export type BlockedAnnounce = {
  publicKeyBase64: string;
  signatureBase64?: string;
  identityKeyBase64?: string;
};

export type PinLookup = Exclude<
  Awaited<ReturnType<typeof getIdentityPin>>,
  { status: "unavailable" }
>;

/** The trusted keys and current pin from a readable pin lookup. */
export function pinnedKeys(lookup: PinLookup): { trusted: readonly string[]; pin: string | null } {
  return lookup.status === "pinned"
    ? { trusted: trustedPins(lookup), pin: lookup.pin }
    : { trusted: [], pin: null };
}

/** A pinned peer delivering a key none of its pins match. */
export function isUntrustedNewKey(
  pin: string | null,
  publishedIdentity: string | null,
  trusted: readonly string[],
): boolean {
  return pin !== null && !!publishedIdentity && !trusted.includes(publishedIdentity);
}

export function needsPinWrite(
  pin: string | null,
  keyChanged: boolean,
  host: string | null,
): boolean {
  return (pin === null || keyChanged) && !!host;
}

/** Log the outcome of a pin write and say whether it failed. A null result
 *  means no write was attempted. */
export function logPinWrite(
  pinResult: Awaited<ReturnType<typeof storeIdentityPin>> | null,
  keyChanged: boolean,
  userId: number,
): boolean {
  if (pinResult === null) return false;
  if (pinResult === "failed") {
    log.error("E2EE: failed to persist identity pin — marking unverified, not verified", {
      userId,
    });
    return true;
  }
  if (keyChanged) {
    log.warn("E2EE: peer is using a new device key — accepted and pinned (identity-tofu)", {
      userId,
    });
  } else {
    log.info("E2EE: pinned peer identity key on first sight", { userId });
  }
  return false;
}

/** The identity key an announce is checked against: its own, else the
 *  member's published one, else null. */
export function deliveredIdentityKey(userId: number, announcedIdentityKey?: string): string | null {
  return (
    announcedIdentityKey ?? membersStore.getState().members.get(userId)?.identityPublicKey ?? null
  );
}

/** Tell the user once that a peer is using a new device key. */
export function showKeyChangedToast(userId: number): void {
  const member = membersStore.getState().members.get(userId);
  showToast(
    voiceText("identity.keyChanged", {
      name: member ? memberDisplayName(member) : String(userId),
    }),
    "warning",
    Infinity,
  );
}
