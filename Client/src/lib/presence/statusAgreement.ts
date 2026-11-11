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
 *  - otherwise the user chose here while the socket was down, or was last
 *    connected to another server: the saved status is sent.
 *
 * A server that reports no status, or an idle one (idle belongs to one
 * connection), is answered with the saved status as well.
 */

import type { UserStatus } from "../types";
import {
  loadAgreedStatus,
  loadUserStatus,
  loadUserStatusOrigin,
  saveAgreedStatus,
  saveUserStatus,
} from "./userStatus";

/** The statuses a server keeps for the whole account. */
function isAccountStatus(status: UserStatus | undefined): status is UserStatus {
  return status === "online" || status === "dnd" || status === "invisible";
}

/** What the user chose on this device: an idle the idle watcher set stands for
 *  the Online it goes back to. */
function chosenStatus(status: UserStatus): UserStatus {
  return status === "idle" && loadUserStatusOrigin() === "auto" ? "online" : status;
}

interface StatusAgreement {
  /** The saved status changed, whoever wrote it. */
  saved(status: UserStatus): void;
  /** A connect to `account` (server and user) that announced `serverStatus`:
   *  adopts it, or returns the saved status for the caller to send; null when
   *  there is nothing to send. */
  settle(account: string, serverStatus: UserStatus | undefined): UserStatus | null;
}

/** One per page session. `connected` says whether the socket is up now. */
export function createStatusAgreement(connected: () => boolean): StatusAgreement {
  /** The server account this session is connected to, once a connect said so. */
  let owner: string | null = null;

  return {
    // A status saved while the socket is up is one the server hears (a pick
    // here) or already holds (another device's, adopted from a live presence),
    // so it becomes the agreed one. One saved while the socket is down does
    // not: the next connect finds it differs from the agreement and sends it.
    saved(status) {
      if (owner !== null && connected()) saveAgreedStatus(owner, chosenStatus(status));
    },
    settle(account, serverStatus) {
      owner = account;
      const status = loadUserStatus();
      const chosen = chosenStatus(status);
      const agreed = loadAgreedStatus();
      if (serverStatus !== status && isAccountStatus(serverStatus)) {
        const unchangedHere =
          agreed === null || (agreed.owner === account && agreed.status === chosen);
        if (unchangedHere) {
          saveUserStatus(serverStatus);
          saveAgreedStatus(account, serverStatus);
          return null;
        }
      }
      saveAgreedStatus(account, chosen);
      return serverStatus === status ? null : status;
    },
  };
}
