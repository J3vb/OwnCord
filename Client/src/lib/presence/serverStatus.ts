/**
 * What a server says this account's status is. Kept apart from the connect-time
 * settling in statusAgreement.ts because the presence handlers need it from the
 * first frame on, and that code does not.
 */

import type { UserStatus } from "../types";
import { getChannelMutesHost } from "../prefs/channelMutes";
import { saveAgreedStatus } from "./userStatus";

/** The server and user an agreement belongs to. */
export function statusAccount(userId: number): string {
  return `${getChannelMutesHost() ?? ""}#${userId}`;
}

/** The statuses a server keeps for the whole account (an idle belongs to one connection). */
export function isAccountStatus(status: string | undefined): status is UserStatus {
  return status === "online" || status === "dnd" || status === "invisible";
}

/** The server itself reported `status` for `account`: at handshake, or in a presence frame. */
export function noteServerStatus(account: string, status: string | undefined): void {
  if (isAccountStatus(status)) saveAgreedStatus(account, status);
}
