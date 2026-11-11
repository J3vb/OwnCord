/**
 * Settling the saved status with a server on connect.
 *
 * The saved status (and its timer) is one per device and follows the user from
 * server to server, while a server keeps one status per account and announces
 * it at handshake. The two are equal in the normal case. When they differ, the
 * one that changed since they last agreed wins:
 *
 *  - the saved status still equals the agreement with this server account (or
 *    there is none yet, a first sign-in): another device chose the server's,
 *    and it is adopted here, so this device does not put its own old status
 *    back over it;
 *  - otherwise the user chose here and this server has not heard it (the
 *    socket was down, the change was still waiting to be sent, or the last
 *    connection was to another server): the saved status is sent.
 *
 * A server that reports no status, or an idle one (idle belongs to one
 * connection), is answered with the saved status as well.
 *
 * The agreement moves only on what the server is known to hold: its handshake
 * here, and `confirmAgreedStatus` (userStatus.ts) when a change goes on the
 * wire or another device's is adopted.
 */

import type { UserStatus } from "../types";
import {
  chosenStatus,
  loadAgreedStatus,
  loadUserStatus,
  saveAgreedStatus,
  saveUserStatus,
} from "./userStatus";

/** The statuses a server keeps for the whole account. */
function isAccountStatus(status: UserStatus | undefined): status is UserStatus {
  return status === "online" || status === "dnd" || status === "invisible";
}

/**
 * A connect to `account` (server and user) that announced `serverStatus`:
 * adopts it, or returns the saved status for the caller to send; null when
 * there is nothing to send.
 */
export function settleSavedStatus(
  account: string,
  serverStatus: UserStatus | undefined,
): UserStatus | null {
  const status = loadUserStatus();
  const chosen = chosenStatus(status);
  if (serverStatus === status || !isAccountStatus(serverStatus)) {
    saveAgreedStatus(account, chosen);
    return serverStatus === status ? null : status;
  }
  const agreed = loadAgreedStatus();
  // Until the saved status is on the wire, the agreement is what the server holds.
  saveAgreedStatus(account, serverStatus);
  if (agreed !== null && (agreed.owner !== account || agreed.status !== chosen)) return status;
  saveUserStatus(serverStatus);
  return null;
}
