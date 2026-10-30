// The connect page's auto-login: the startup profile load with its skip-flag
// consumption and quick-switch handling, the stored-token resume, and the wait
// for a server that is still booting. Moved out of main.ts verbatim;
// the only edits are that the page's collaborators arrive through
// createAutoLogin(), the renderPage-scoped `let`s live in its closure, and the
// startup IIFE sits in a function whose synchronous prefix still captures
// `startupAttempt` before its first await. Nothing here runs at import time.

import { errorText } from "@lib/api";
import type { ApiClient } from "@lib/api";
import { loadCredential } from "@lib/net/credentials";
import { setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { ProfileManager } from "@lib/presence/profiles";
import type { SessionScope } from "@lib/net/sessionScope";
import type { createConnectPage } from "@pages/ConnectPage";
import { connectText } from "../i18n/connect";
import { desktop } from "../platform/desktop";
import { checkHealth, runHealthChecks } from "./serverHealth";
import { startSession } from "./session";

const log = createLogger("main");

type ConnectPage = Pick<
  ReturnType<typeof createConnectPage>,
  | "selectServer"
  | "refreshProfiles"
  | "showAutoConnecting"
  | "showError"
  | "showServerWait"
  | "hideServerWait"
> &
  Parameters<typeof checkHealth>[0];

/**
 * Returns [startup, cancel, forgetHost] as a tuple, not an object: object keys
 * survive minification, and this runs in the startup chunk. `startup` loads the
 * profiles and may resume a session; `cancel` marks the auto-login cancelled;
 * `forgetHost` ends a server wait on that host.
 */
export function createAutoLogin(
  api: ApiClient,
  profileManager: ProfileManager,
  pageOwner: SessionScope,
  connectPage: ConnectPage,
  ensureProfileExists: (
    host: string,
    username: string,
    rememberPassword: boolean,
    autoConnect: boolean,
  ) => void,
  getProfileList: () => Parameters<ConnectPage["refreshProfiles"]>[0],
): readonly [() => void, () => void, (host: string) => void] {
  // The web portal's one host; read only behind `__OWNCORD_WEB__`.
  const fixedHost = __OWNCORD_WEB__ ? (desktop.serverScope.fixedHost ?? undefined) : undefined;
  let autoLoginCancelled = false;
  let serverWait: { readonly host: string; readonly scope: SessionScope } | null = null;

  interface ResumableProfile {
    readonly name: string;
    readonly host: string;
    readonly autoConnect: boolean;
    readonly rememberPassword: boolean;
  }

  // A stored-token resume that timed out against a down server (a home
  // server still booting after a power cut) keeps probing it, 5 s doubling to
  // 30 s, and resumes once when it answers. The wait belongs to the API
  // session the timeout left behind, so whatever ends that session ends the
  // wait: a manual login, Cancel, typing or picking another server
  // (onAutoLoginCancel), the resume itself (startSession's setConfig),
  // deleting the server's last profile, or leaving this page.
  function waitForServer(profile: ResumableProfile): void {
    const wait = pageOwner.fork(api.getSession().signal);
    serverWait = { host: profile.host, scope: wait };
    wait.addCleanup(() => connectPage.hideServerWait());
    connectPage.showServerWait(profile.name, profile.host);
    const probeAfter = (delayMs: number): void => {
      setOwnedTimeout(
        wait.signal,
        () => {
          void checkHealth(connectPage, profile.host, wait).then((up) => {
            if (!wait.isCurrent()) return;
            const current = profileManager.getAll().find((p) => p.host === profile.host);
            if (current === undefined) {
              wait.dispose();
              return;
            }
            if (!up) {
              probeAfter(Math.min(delayMs * 2, 30_000));
              return;
            }
            wait.dispose();
            void resumeStoredSession(current, false);
          });
        },
        delayMs,
      );
    };
    probeAfter(5_000);
  }

  // Resume a profile's session from its stored token — startup auto-login
  // and a quick switch back to a server share this path. No-op when the
  // host has no stored token. A resume the wait itself started does not wait
  // again: a server that answers but never signs in gets the offline error.
  async function resumeStoredSession(profile: ResumableProfile, waitIfDown = true): Promise<void> {
    // The stored token outlives an opt-out whose delete failed, so the
    // profile's own setting decides, not the credential's presence. The portal
    // skips this: its store encodes the choice, since an unticked login keeps
    // the token session-only and it dies with the tab.
    if (!__OWNCORD_WEB__ && profile.rememberPassword !== true && profile.autoConnect !== true)
      return;
    const attempt = api.getSession();
    try {
      const cred = await loadCredential(profile.host);
      if (!pageOwner.isCurrent() || !attempt.isCurrent()) return;
      if (cred?.username && cred?.token && !autoLoginCancelled) {
        // Pass autoConnect so the checkbox still reads correctly if the
        // user cancels and lands back on the form.
        connectPage.selectServer(
          profile.host,
          cred.username,
          profile.autoConnect,
          profile.rememberPassword,
        );
        connectPage.showAutoConnecting(profile.name);

        if (autoLoginCancelled) return;

        // Use stored token directly for reconnection, preserving the
        // profile's existing rememberPassword and autoConnect.
        //
        // The credential re-save no longer has to be suppressed here.
        // save_credential used to treat an absent password as "erase it",
        // so re-saving without one destroyed the password the user opted
        // to remember; it now preserves the stored password unless asked
        // to clear it, so this path can refresh the token normally.
        api.setConfig({ host: profile.host });
        ensureProfileExists(
          profile.host,
          cred.username,
          profile.rememberPassword,
          profile.autoConnect,
        );
        startSession(
          profile.host,
          cred.token,
          cred.username,
          undefined,
          profile.rememberPassword,
          false,
          waitIfDown ? () => waitForServer(profile) : undefined,
          profile.autoConnect,
        );
      }
    } catch (err) {
      // A superseded attempt (e.g. a manual login started while this
      // credential read was still pending) must not paint an error over
      // the login that superseded it.
      if (!autoLoginCancelled && pageOwner.isCurrent() && attempt.isCurrent()) {
        const message = errorText(err, connectText("session.autoLoginFailed"));
        log.warn("Auto-login failed", { host: profile.host, error: message });
        connectPage.showError(connectText("session.autoLoginFailedDetail", { message }));
      }
    }
  }

  /** Capture ownership and load the saved profiles, then resume the right session. */
  function startup(): void {
    // Profile loading must not later start auto-login over a manual attempt.
    // Capture ownership before its first await, not after credentials arrive.
    const startupAttempt = api.getSession();
    // Load saved profiles and kick off health checks
    void (async () => {
      try {
        await profileManager.loadProfiles();
        if (!pageOwner.isCurrent()) return;
        const profiles = getProfileList();
        connectPage.refreshProfiles(profiles);
        runHealthChecks(connectPage, profiles, pageOwner);
      } catch (err) {
        if (!pageOwner.isCurrent()) return;
        log.warn("Failed to load profiles, using defaults", err);
        runHealthChecks(connectPage, getProfileList(), pageOwner);
      }

      // Consume any pending skip-auto-login flag on THIS mount regardless of
      // which branch below returns early. It is the single source of truth
      // for "an explicit logout just happened, don't auto-login" (set by the
      // isAuthenticated subscriber further down), and every connect-page
      // mount — quick-switch included — must clear it here or it survives in
      // sessionStorage and goes on to suppress a later, unrelated
      // auto-login.
      const skipAutoLogin = sessionStorage.getItem("owncord:skip-auto-login") !== null;
      sessionStorage.removeItem("owncord:skip-auto-login");

      // Quick-switch: if the user switched servers via the overlay, auto-select
      // the target server profile so they can reconnect with one click.
      const quickSwitchTarget = sessionStorage.getItem("owncord:quick-switch-target");
      if (quickSwitchTarget !== null) {
        sessionStorage.removeItem("owncord:quick-switch-target");
        const targetProfile = profileManager.getAll().find((p) => p.host === quickSwitchTarget);
        connectPage.selectServer(
          quickSwitchTarget,
          targetProfile?.username ?? undefined,
          targetProfile?.autoConnect,
          targetProfile?.rememberPassword,
        );
        // A quick switch keeps each server's saved sign-in, so
        // switching back resumes with the stored token exactly as auto-login
        // does. Without a stored credential the prefilled form stays up.
        if (targetProfile !== undefined && startupAttempt.isCurrent()) {
          await resumeStoredSession(targetProfile);
        }
        return; // Skip auto-login when switching servers
      }

      // A logout that just deleted this host's credential must not be followed
      // by an auto-login (the flag is set by the logout teardown in app/session.ts).
      if (skipAutoLogin || !startupAttempt.isCurrent()) {
        return;
      }

      // Auto-login: if a profile has autoConnect enabled, try to reconnect
      // using the stored token (password is no longer returned from the
      // credential store over IPC for security).
      // The portal resumes its one host: the saved profile, or a stand-in when
      // none was saved. An unticked login leaves no auto-connect profile, so
      // `getAutoConnectProfile` would never find it.
      const autoProfile =
        __OWNCORD_WEB__ && fixedHost !== undefined
          ? (profileManager.getAll().find((p) => p.host === fixedHost) ?? {
              name: fixedHost,
              host: fixedHost,
              // Not true: `ensureProfileExists` would persist it and tick
              // "Stay signed in" for a user who unticked it. The resume runs
              // anyway, because the web skips the opt-out check.
              autoConnect: false,
              rememberPassword: false,
            })
          : profileManager.getAutoConnectProfile();
      if (autoProfile) await resumeStoredSession(autoProfile);
    })();
  }

  return [
    startup,
    () => {
      autoLoginCancelled = true;
    },
    (host) => {
      if (serverWait?.host === host) serverWait.scope.dispose();
    },
  ];
}
