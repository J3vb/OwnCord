// The connect page's auto-login: the startup profile load with its skip-flag
// consumption and quick-switch handling, the stored-token resume, and the wait
// for a server that is still booting. Moved out of main.ts verbatim;
// the only edits are that the page's collaborators arrive through
// createAutoLogin(), the renderPage-scoped `let`s live in its closure, and the
// startup IIFE sits in a function whose synchronous prefix still captures
// `startupAttempt` before its first await. Nothing here runs at import time.

import { errorText, TransportError } from "@lib/api";
import type { ApiClient } from "@lib/api";
import { resumeSavedSession } from "@lib/net/credentials";
import type { SavedSessionResume } from "@lib/net/credentials";
import { normalizeHostForCertCompare } from "@lib/net/hostNormalize";
import { setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { ProfileManager, ServerProfile } from "@lib/presence/profiles";
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
  | "resetToIdle"
  | "showError"
  | "showServerWait"
  | "hideServerWait"
> &
  Parameters<typeof checkHealth>[0];

// Consume any pending skip-auto-login flag. It is the single source of truth
// for "an explicit logout just happened, don't auto-login" (set by the
// isAuthenticated subscriber further down).
function consumeSkipAutoLogin(): boolean {
  const skip = sessionStorage.getItem("owncord:skip-auto-login") !== null;
  sessionStorage.removeItem("owncord:skip-auto-login");
  return skip;
}

function consumeQuickSwitchTarget(): string | null {
  const target = sessionStorage.getItem("owncord:quick-switch-target");
  if (target !== null) sessionStorage.removeItem("owncord:quick-switch-target");
  return target;
}

// The backend answers a resume from the local store at once, unless it has to
// ask the server: only a resume that takes this long shows that it is busy.
const RESUME_PROGRESS_DELAY_MS = 400;
// A switch can ask before the old session's close has reached the backend.
const REFUSED_RETRY_DELAY_MS = 300;

/**
 * Returns [startup, cancel, forgetHost, certAccepted] as a tuple, not an
 * object: object keys survive minification, and this runs in the startup
 * chunk. `startup` loads the profiles and may resume a session; `cancel` marks
 * the auto-login cancelled; `forgetHost` ends a server wait on that host;
 * `certAccepted` carries on with a resume that host's certificate held up.
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
): readonly [() => void, () => void, (host: string) => void, (host: string) => void] {
  // The web portal's one host; read only behind `__OWNCORD_WEB__`.
  const fixedHost = __OWNCORD_WEB__ ? (desktop.serverScope.fixedHost ?? undefined) : undefined;
  let autoLoginCancelled = false;
  let serverWait: { readonly host: string; readonly scope: SessionScope } | null = null;
  let certHeldResume: {
    readonly profile: ResumableProfile;
    readonly attempt: SessionScope;
  } | null = null;

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

  // The stored token outlives an opt-out whose delete failed, so the
  // profile's own setting decides, not the credential's presence. The portal
  // skips this: its store encodes the choice, since an unticked login keeps
  // the token session-only and it dies with the tab.
  function mayResume(profile: ResumableProfile): boolean {
    return __OWNCORD_WEB__ || profile.rememberPassword === true || profile.autoConnect === true;
  }

  // The synchronous tail of a resume, run in the same step as the ownership
  // checks that precede it: select the server, show the progress, then hand
  // the stored token to startSession.
  function launchResume(
    profile: ResumableProfile,
    username: string,
    token: string,
    waitIfDown: boolean,
  ): void {
    // Pass autoConnect so the checkbox still reads correctly if the
    // user cancels and lands back on the form.
    connectPage.selectServer(profile.host, username, profile.autoConnect, profile.rememberPassword);
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
    ensureProfileExists(profile.host, username, profile.rememberPassword, profile.autoConnect);
    startSession(
      profile.host,
      token,
      username,
      undefined,
      profile.rememberPassword,
      false,
      waitIfDown ? () => waitForServer(profile) : undefined,
      profile.autoConnect,
    );
  }

  // A resume that failed. The backend could not ask the server whether it
  // still accepts the saved sign-in: that server is down or out of reach, so
  // say so and wait for it, as a resume that timed out does. Anything else (an
  // unreadable store) is shown as it is.
  function resumeFailed(profile: ResumableProfile, err: unknown, waitIfDown: boolean): void {
    if (err instanceof TransportError) {
      log.warn("Saved sign-in could not be checked", { host: profile.host, error: err.message });
      connectPage.showError(connectText("session.connectTimeout"));
      if (waitIfDown) waitForServer(profile);
      return;
    }
    const message = errorText(err, connectText("session.autoLoginFailed"));
    log.warn("Auto-login failed", { host: profile.host, error: message });
    connectPage.showError(connectText("session.autoLoginFailedDetail", { message }));
  }

  // What the backend answered for a resume this attempt still owns.
  function applyResume(
    profile: ResumableProfile,
    resumed: SavedSessionResume | null,
    waitIfDown: boolean,
    attempt: SessionScope,
    retryRefused: boolean,
  ): void {
    switch (resumed?.outcome) {
      case "resumed":
        launchResume(profile, resumed.username, resumed.token, waitIfDown);
        return;
      case "sign_in_needed":
        log.info("Saved sign-in no longer accepted", { host: profile.host });
        connectPage.showError(connectText("error.unauthorized"));
        return;
      case "certificate_unverified":
        // The certificate prompt is up; accepting it carries on (certAccepted).
        certHeldResume = { profile, attempt };
        connectPage.showError(connectText("error.tlsFailed"));
        return;
      case "refused":
        if (retryRefused) {
          const retry = pageOwner.fork(attempt.signal);
          setOwnedTimeout(
            retry.signal,
            () => {
              retry.dispose();
              if (!autoLoginCancelled) void resumeStoredSession(profile, waitIfDown, false);
            },
            REFUSED_RETRY_DELAY_MS,
          );
          return;
        }
        log.warn("Saved sign-in not resumed: another session is active", { host: profile.host });
        connectPage.showError(connectText("session.autoLoginFailed"));
        return;
      default:
    }
  }

  // Resume a profile's session from its stored token — startup auto-login
  // and a quick switch to a server share this path. No-op when the host has
  // no stored token. For a saved server not signed in to yet during this app
  // run the backend asks that server before it hands the token over; a refusal
  // leaves the sign-in form up. A resume the wait itself started does not wait
  // again: a server that answers but never signs in gets the offline error.
  async function resumeStoredSession(
    profile: ResumableProfile,
    waitIfDown = true,
    retryRefused = true,
  ): Promise<void> {
    if (!mayResume(profile)) return;
    const attempt = api.getSession();
    // A superseded attempt (e.g. a manual login started while this resume was
    // still pending) must neither sign in nor paint an error over the login
    // that superseded it.
    const owned = (): boolean =>
      !autoLoginCancelled && pageOwner.isCurrent() && attempt.isCurrent();
    const pending = pageOwner.fork(attempt.signal);
    let progressShown = false;
    setOwnedTimeout(
      pending.signal,
      () => {
        if (!owned()) return;
        progressShown = true;
        connectPage.showAutoConnecting(profile.name);
      },
      RESUME_PROGRESS_DELAY_MS,
    );
    let resumed: SavedSessionResume | null;
    try {
      resumed = await resumeSavedSession(profile.host);
    } catch (err) {
      if (owned()) resumeFailed(profile, err, waitIfDown);
      return;
    } finally {
      pending.dispose();
    }
    if (!owned()) return;
    // A stored sign-in without a name or a token cannot sign in.
    if (resumed?.outcome === "resumed" && !(resumed.username && resumed.token)) resumed = null;
    if (progressShown && resumed?.outcome !== "resumed") connectPage.resetToIdle();
    applyResume(profile, resumed, waitIfDown, attempt, retryRefused);
  }

  // Auto-select the quick-switch target server profile so the user can
  // reconnect with one click.
  function selectQuickSwitchTarget(host: string): ServerProfile | undefined {
    const targetProfile = profileManager.getAll().find((p) => p.host === host);
    connectPage.selectServer(
      host,
      targetProfile?.username ?? undefined,
      targetProfile?.autoConnect,
      targetProfile?.rememberPassword,
    );
    return targetProfile;
  }

  // The portal resumes its one host: the saved profile, or a stand-in when
  // none was saved. An unticked login leaves no auto-connect profile, so
  // `getAutoConnectProfile` would never find it.
  function pickAutoProfile(): ResumableProfile | null | undefined {
    if (!__OWNCORD_WEB__ || fixedHost === undefined) return profileManager.getAutoConnectProfile();
    return (
      profileManager.getAll().find((p) => p.host === fixedHost) ?? {
        name: fixedHost,
        host: fixedHost,
        // Not true: `ensureProfileExists` would persist it and tick
        // "Stay signed in" for a user who unticked it. The resume runs
        // anyway, because the web skips the opt-out check.
        autoConnect: false,
        rememberPassword: false,
      }
    );
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
      const skipAutoLogin = consumeSkipAutoLogin();

      // Quick-switch: if the user switched servers via the overlay, auto-select
      // the target server profile so they can reconnect with one click.
      const quickSwitchTarget = consumeQuickSwitchTarget();
      if (quickSwitchTarget !== null) {
        const targetProfile = selectQuickSwitchTarget(quickSwitchTarget);
        // A quick switch keeps each server's saved sign-in, so switching to
        // a saved server resumes with the stored token exactly as auto-login
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
      const autoProfile = pickAutoProfile();
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
    (host) => {
      const held = certHeldResume;
      if (held === null || normalizeHostForCertCompare(held.profile.host) !== host) return;
      certHeldResume = null;
      if (!autoLoginCancelled && held.attempt.isCurrent()) void resumeStoredSession(held.profile);
    },
  ];
}
