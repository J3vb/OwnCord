/**
 * What a server says this account's status is. Kept apart from the connect-time
 * settling in statusAgreement.ts because the presence handlers need it from the
 * first frame on, and that code does not.
 */

import type { UserStatus } from "../types";
import { getChannelMutesHost } from "../prefs/channelMutes";
import { loadPref, savePref } from "../prefs/preferences";

const USER_STATUS_AGREED_PREF_KEY = "userStatusAgreed";

/**
 * The status one server account last reported. The saved status is one per
 * device while a server keeps one per account, so on connect this tells
 * "another device chose a status since" (the saved one still equals it) from
 * "this device did" (it no longer does), and one server's status from another's.
 */
interface AgreedStatus {
  /** The server and account that reported it. */
  readonly owner: string;
  readonly status: UserStatus;
}

/** The server and user an agreement belongs to; null until the signed-in server is known. */
export function statusAccount(userId: number): string | null {
  const host = getChannelMutesHost();
  return host === null ? null : `${host}#${userId}`;
}

/** The statuses a server keeps for the whole account (an idle belongs to one connection). */
export function isAccountStatus(status: string | undefined): status is UserStatus {
  return status === "online" || status === "dnd" || status === "invisible";
}

/** The stored agreement, or null when there is none or it is malformed. */
export function loadAgreedStatus(): AgreedStatus | null {
  const raw = loadPref<Record<string, unknown> | null>(USER_STATUS_AGREED_PREF_KEY, null);
  if (raw === null || typeof raw !== "object") return null;
  const { owner, status } = raw;
  if (typeof owner !== "string" || typeof status !== "string" || !isAccountStatus(status)) {
    return null;
  }
  return { owner, status };
}

/**
 * The server itself reported `status` for `account`: at handshake, or in a
 * presence frame. A frame that arrives before the server is known (the page is
 * still loading) is left out, so it is never filed under a wrong account.
 */
export function noteServerStatus(account: string | null, status: string | undefined): void {
  if (account !== null && isAccountStatus(status)) {
    savePref(USER_STATUS_AGREED_PREF_KEY, { owner: account, status });
  }
}
