// The certificate trust-on-first-use prompts: the first-use confirmation and
// the fingerprint-mismatch prompt, plus the guard that keeps them from
// stacking. Moved out of main.ts verbatim; the only edits are that the free
// variables (ws, the router's two operations, the connect page's health
// refresh) arrive through installCertPrompts() and the session's host and
// token come from the controller's sessionTarget() accessor. Nothing here runs
// at import time: main.ts calls installCertPrompts() at the point in the boot
// order where this code used to be inline.

import { reconnectAfterCertAccept } from "@lib/cert-reconnect";
import { createLogger } from "@lib/logger";
import { isCertDeclined, normalizeHostForCertCompare } from "@lib/ws";
import type { CertTofuEvent, WsClient } from "@lib/ws";
import { authStore, clearAuth } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import { connectText } from "../i18n/connect";
import type { PageId } from "./context";
import { abandonInFlight, sessionTarget } from "./session";

const log = createLogger("main");

let ws: WsClient;
let getPage: () => PageId;
let navigate: (page: PageId) => void;

// Shared guard so the first-use and mismatch cert modals never stack.
let certModalActive = false;

// The modals only open on a cert event, so they load on demand and stay out of
// the startup closure. A failed load (or a modal that throws while opening)
// releases the guard so a later event retries, then runs `onFail`.
function withCertModals(
  open: (m: typeof import("@components/CertMismatchModal")) => void,
  onFail: () => void,
): void {
  void import("@components/CertMismatchModal").then(open).catch((err: unknown) => {
    log.error("Failed to open certificate modal", err);
    certModalActive = false;
    onFail();
  });
}

// A mismatch the user never got to answer must fail closed. Only tear down the
// live session when the mismatch is FOR that session's host — a rotated cert on
// an unrelated saved profile must not disconnect and log out an unrelated
// authenticated session. Returns whether it told the user why.
function dropSessionOnMismatch(host: string): boolean {
  if (host !== normalizeHostForCertCompare(sessionTarget()?.host ?? "")) return false;
  if (authStore.getState().isAuthenticated) {
    ws.disconnect();
    clearAuth();
    navigate("connect");
    return false;
  }
  // Before the first auth_ok the logout subscriber never fires (the flag was
  // already false), so tear the attempt down here the way a cancelled
  // auto-login does, and end its spinner with the reason.
  clearAuth();
  abandonInFlight();
  setTransientError(connectText("cert.notAccepted"));
  navigate("connect");
  return true;
}

/**
 * Registers the certificate prompts against the ws client and starts the
 * native cert listener. `rerunHealth` re-checks the connect page's servers
 * (a no-op when it is not mounted). Positional rather than an options object:
 * object keys survive minification, and this runs in the startup chunk.
 */
export function installCertPrompts(
  wsClient: WsClient,
  currentPage: () => PageId,
  navigateTo: (page: PageId) => void,
  rerunHealth: () => void,
): void {
  ws = wsClient;
  getPage = currentPage;
  navigate = navigateTo;

  // First-use certificate confirmation (F4/F8). The Rust proxy REJECTS the first
  // connection to a server until the user confirms its fingerprint, so no
  // credential is ever sent to an unconfirmed host. This fires during the connect
  // page's health check (the first TLS contact), before login.
  ws.onCertFirstUse((evt: CertTofuEvent) => {
    if (certModalActive) return;
    certModalActive = true;
    withCertModals(
      ({ createCertFirstUseModal }) => {
        const reject = (): void => {
          modal.destroy?.();
          certModalActive = false;
        };

        const modal = createCertFirstUseModal({
          host: evt.host,
          fingerprint: evt.fingerprint,
          onAccept: () => {
            // The guard stays set until the native confirmation settles, so a
            // repeated event cannot mount a second modal behind the OS dialog.
            modal.destroy?.();
            void (async () => {
              try {
                await ws.acceptCertFingerprint(evt.host, evt.fingerprint);
                // Refresh server health so the now-trusted host becomes reachable,
                // and resume a pending connect if one was in flight — but only when
                // it was pending for THIS host. Accepting a first-use cert for one
                // profile must not force-reconnect (or churn) a session already
                // live for a different host.
                rerunHealth();
                const target = sessionTarget();
                if (target?.token && evt.host === normalizeHostForCertCompare(target.host)) {
                  ws.connect(target);
                }
              } catch (err) {
                if (isCertDeclined(err)) {
                  log.info("First-use certificate not accepted", { host: evt.host });
                  reject();
                  setTransientError(connectText("cert.notAccepted"));
                } else {
                  log.error("Failed to trust first-use certificate", err);
                }
              } finally {
                certModalActive = false;
              }
            })();
          },
          onReject: reject,
        });
        modal.mount(document.body);
      },
      () => {},
    );
  });
  ws.onCertMismatch((evt: CertTofuEvent) => {
    if (certModalActive) return;
    certModalActive = true;
    withCertModals(
      ({ createCertMismatchModal }) => {
        const reject = (): boolean => {
          modal.destroy?.();
          certModalActive = false;
          return dropSessionOnMismatch(evt.host);
        };

        const modal = createCertMismatchModal({
          host: evt.host,
          storedFingerprint: evt.storedFingerprint ?? connectText("common.unknown"),
          newFingerprint: evt.fingerprint,
          onAccept: () => {
            // The guard stays set until the native confirmation settles, so a
            // repeated event cannot mount a second modal behind the OS dialog.
            modal.destroy?.();
            void (async () => {
              try {
                await ws.acceptCertFingerprint(evt.host, evt.fingerprint);
                const target = sessionTarget();
                if (target?.token && evt.host === normalizeHostForCertCompare(target.host)) {
                  reconnectAfterCertAccept(
                    ws,
                    { getCurrentPage: getPage, navigate },
                    target.host,
                    target.token,
                  );
                }
              } catch (err) {
                if (isCertDeclined(err)) {
                  log.info("Certificate not accepted", { host: evt.host });
                  if (!reject()) setTransientError(connectText("cert.notAccepted"));
                } else {
                  log.error("Failed to accept cert fingerprint", err);
                }
              } finally {
                certModalActive = false;
              }
            })();
          },
          onReject: reject,
        });
        modal.mount(document.body);
      },
      () => dropSessionOnMismatch(evt.host),
    );
  });

  // Register the global cert-tofu listener now so first-use / mismatch prompts
  // are received during the connect page's health checks, before any WS connect.
  ws.startCertListener().catch((err: unknown) =>
    log.warn("cert listener registration failed", err),
  );
}
