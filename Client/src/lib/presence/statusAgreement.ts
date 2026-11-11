/**
 * Settling the saved status with a server on connect.
 *
 * The saved status (and its timer) is one per device and follows the user from
 * server to server, while a server keeps one status per account and announces
 * it at handshake. The two are equal in the normal case. When they differ, the
 * one that changed since the server last reported its own wins:
 *
 *  - the saved status still equals what this server account last reported (or
 *    nothing was ever reported, a first sign-in): another device chose the
 *    server's, and it is adopted here, so this device does not put its own old
 *    status back over it;
 *  - otherwise the user chose here and this server has not heard it (the
 *    socket was down, the change was still waiting to be sent or was lost on
 *    the way, or the last connection was to another server): the saved status
 *    is sent.
 *
 * A server that reports no status, or an idle one (idle belongs to one
 * connection), is answered with the saved status as well.
 *
 * The agreement is only ever what a server reported: its handshake here, and
 * each presence frame naming this user (serverStatus.ts). A change that never
 * reached the server is therefore still unsent at the next connect.
 */

import type { UserStatus } from "../types";
import { isAccountStatus, loadAgreedStatus, noteServerStatus } from "./serverStatus";
import { loadUserStatus, loadUserStatusOrigin, saveUserStatus } from "./userStatus";

/**
 * A connect to `account` that announced `serverStatus`: adopts it, or returns
 * the saved status for the caller to send; null when there is nothing to send.
 */
export function settleSavedStatus(
  account: string | null,
  serverStatus: UserStatus | undefined,
): UserStatus | null {
  const status = loadUserStatus();
  const agreed = loadAgreedStatus();
  noteServerStatus(account, serverStatus);
  if (serverStatus === status) return null;
  // With no server to file an agreement under, nothing says who changed last.
  if (account === null || !isAccountStatus(serverStatus)) return status;
  // An idle the idle watcher set stands for the Online it goes back to.
  const chosen = status === "idle" && loadUserStatusOrigin() === "auto" ? "online" : status;
  if (agreed !== null && (agreed.owner !== account || agreed.status !== chosen)) return status;
  saveUserStatus(serverStatus);
  return null;
}
