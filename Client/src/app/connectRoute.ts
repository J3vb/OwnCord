// The connect route: the connect page with its login, register, recover and
// TOTP callbacks, the profile callbacks, the update-required notifier, the
// periodic health check and the invite hook. Moved out of main.ts's renderPage
// connect branch verbatim. The edits: the collaborators arrive as
// arguments, the three route-scoped `let`s for the 2FA challenge live in the
// renderConnect closure, and the branch's three outputs (the page handle,
// the health refresh and the invite hook) are returned as a tuple. Nothing
// here runs at import time.

import { ApiClientError } from "@lib/api";
import type { ApiClient } from "@lib/api";
import { deleteCredential, loginWithSavedPassword, parseRelayedLogin } from "@lib/net/credentials";
import { createLogger } from "@lib/logger";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import type { ProfileManager } from "@lib/profiles";
import { safeMount } from "@lib/text/safeRender";
import type { MountableComponent, RenderRecovery } from "@lib/text/safeRender";
import { SessionScope } from "@lib/net/sessionScope";
import { parseRegistrationMode, retentionNotice } from "@lib/types";
import type { AuthResponse } from "@lib/types";
import { bracketBareIPv6Host } from "@lib/ws";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import { createConnectPage } from "@pages/ConnectPage";
import { setUpdateRequiredHost, uiStore } from "@stores/ui.store";
import type { UpdateRequired } from "@stores/ui.store";
import { desktop } from "../platform/desktop";
import { connectText } from "../i18n/connect";
import { createAutoLogin } from "./autoLogin";
import { createConnectProfiles } from "./connectProfiles";
import { probeServerInfo, runHealthChecks, serverInfoFor, serverInfoProbing } from "./serverHealth";
import { abandonInFlight, startSession } from "./session";

const log = createLogger("main");

/**
 * Mounts the connect page and returns [page, rerunHealth, applyInvite] as a
 * tuple, not an object: object keys survive minification, and this runs in the
 * startup chunk. `page.destroy` tears the route down; `rerunHealth` re-checks
 * the profiles' servers; `applyInvite` pre-fills the register form. A link that
 * arrived before the page mounted is taken from `takePendingInvite`, which
 * hands it over once and forgets it.
 */
export function renderConnect(
  api: ApiClient,
  profileManager: ProfileManager,
  appEl: HTMLElement,
  renderRecovery: RenderRecovery,
  handleUnauthorized: () => void,
  takePendingInvite: () => { code: string; host?: string } | null,
): readonly [{ destroy(): void }, () => void, (code: string, host?: string) => void] {
  // Track partial auth state for TOTP flow
  let pendingTotpHost = "";
  let pendingTotpPartialToken = "";
  let pendingTotpUsername = "";

  const pageOwner = new SessionScope({ host: "", generation: 0 });
  const [getSavedProfiles, persistProfiles, mutateAutoLogin, ensureProfileExists] =
    createConnectProfiles(profileManager, pageOwner);

  // The web portal is bound to the server that served it: its one
  // profile is all the page lists, so no health check probes anything else.
  // Written literally so the desktop build drops every use.
  const fixedHost = __OWNCORD_WEB__ ? (desktop.serverScope.fixedHost ?? undefined) : undefined;
  const getProfileList = (): ReturnType<typeof getSavedProfiles> =>
    __OWNCORD_WEB__ && fixedHost !== undefined
      ? [
          ...getSavedProfiles().filter((p) => p.host === fixedHost),
          ...(profileManager.getAll().some((p) => p.host === fixedHost)
            ? []
            : [{ name: fixedHost, host: fixedHost, synthetic: true }]),
        ]
      : getSavedProfiles();

  // Shared tail of both login paths: branch to the 2FA challenge, or wire the
  // session. Structural rather than duplicated, so the saved-password path
  // cannot drift from the typed-password one. `password` is undefined on the
  // saved-password path — the plaintext never leaves the credential store,
  // and save_credential preserves it when none is supplied.
  function completeLogin(
    host: string,
    username: string,
    result: AuthResponse,
    password?: string,
  ): void {
    if (result.requires_2fa) {
      pendingTotpHost = host;
      pendingTotpPartialToken = result.partial_token ?? "";
      pendingTotpUsername = username;
      connectPage.showTotp();
      return;
    }
    if (!result.token) return;
    const remember = connectPage.getRememberPassword();
    ensureProfileExists(host, username, remember, connectPage.getAutoConnect());
    startSession(
      host,
      result.token,
      username,
      remember ? password : undefined,
      remember,
      true,
      undefined,
      connectPage.getAutoConnect(),
    );
  }

  const connectPage = createConnectPage(
    {
      // The mode is read from the per-host snapshot `runHealthChecks` fills
      // beside the health probe. Unknown (no snapshot / unrecognised value)
      // returns null, which LoginForm treats as invite-required.
      getRegistrationMode(host) {
        const info = serverInfoFor(host);
        return parseRegistrationMode(info?.registration_mode);
      },
      getRetentionNotice: (host) => retentionNotice(serverInfoFor(host)),
      ...(__OWNCORD_WEB__ ? { getServerName: (host) => serverInfoFor(host)?.name ?? null } : {}),
      // A typed host has no health row; probe it so register mode can read its mode.
      onHostSettled(host) {
        if (!serverInfoFor(host) && !serverInfoProbing(host))
          void probeServerInfo(connectPage, host, pageOwner);
      },
      async onLogin(host, username, password) {
        api.endSession();
        api.setConfig({ host });
        const attempt = api.getSession();
        const result = await api.login(username, password);
        attempt.assertCurrent();
        pageOwner.assertCurrent();
        completeLogin(host, username, result, password);
      },
      async onLoginWithSavedPassword(host, username) {
        api.endSession();
        api.setConfig({ host });
        const attempt = api.getSession();
        // loginWithSavedPassword's own IPC await isn't cancellable, so a
        // cancelled login would otherwise hang until the backend's own
        // SAVED_LOGIN_TIMEOUT — route it through the scope so it rejects
        // promptly instead.
        const relayed = await attempt.run(loginWithSavedPassword(host, username));
        attempt.assertCurrent();
        pageOwner.assertCurrent();
        if (!relayed) {
          throw new Error(connectText("session.savedLoginUnavailable"));
        }
        // The relayed body is the same AuthResponse shape api.login returns,
        // so from here the flow is literally the typed-password one.
        let result;
        try {
          result = parseRelayedLogin(relayed);
        } catch (err) {
          // Run the same side effect `api.ts` runs for a 401 on any other
          // request, so the two login paths cannot diverge on session state.
          if (err instanceof ApiClientError && err.status === 401) {
            handleUnauthorized();
          }
          throw err;
        }
        completeLogin(host, username, result);
      },
      async onRegister(host, username, password, inviteCode) {
        api.endSession();
        api.setConfig({ host });
        const attempt = api.getSession();
        const result = await api.register(username, password, inviteCode);
        attempt.assertCurrent();
        pageOwner.assertCurrent();
        if (result.status === "pending_approval" || result.token === undefined) {
          // Approval mode: no session yet — an admin decides. This is
          // an expected state, not a failure, so it is an informational
          // notice rather than a red error.
          connectPage.showNotice(connectText("registration.pendingApproval"));
          return;
        }
        const remember = connectPage.getRememberPassword();
        const savedPassword = remember ? password : undefined;
        ensureProfileExists(host, username, remember, connectPage.getAutoConnect());
        startSession(
          host,
          result.token,
          username,
          savedPassword,
          remember,
          true,
          undefined,
          connectPage.getAutoConnect(),
        );
      },
      async onRecover(host, username, secret, newPassword) {
        api.endSession();
        api.setConfig({ host });
        const attempt = api.getSession();
        const result = await api.recoverAccount(username, secret, newPassword);
        attempt.assertCurrent();
        pageOwner.assertCurrent();
        // The login shape: sign the session in exactly as a login does.
        completeLogin(host, username, result, newPassword);
      },
      async onTotpSubmit(code) {
        if (!pendingTotpPartialToken) {
          log.error("TOTP submit without pending partial token");
          return;
        }
        const attempt = api.getSession();
        const result = await api.verifyTotp(code, pendingTotpPartialToken);
        attempt.assertCurrent();
        pageOwner.assertCurrent();
        if (result.token) {
          // Clear the sensitive partial token now that it has been
          // exchanged for a real session token. A rejected code must NOT
          // clear it here — the TOTP *code* is single-use (the server
          // 401s a replay), but the partial token is the short-lived 2FA
          // challenge itself and stays valid for a retry. LoginForm keeps
          // the TOTP overlay open across a failed verify for exactly that
          // retry; clearing this unconditionally (the old `finally`) made
          // every retry hit the guard above and silently do nothing.
          pendingTotpPartialToken = "";
          const remember = connectPage.getRememberPassword();
          // "" when the saved-password placeholder was used — save_credential
          // then keeps the stored password rather than clearing it.
          const savedPassword = remember ? connectPage.getPassword() || undefined : undefined;
          ensureProfileExists(
            pendingTotpHost,
            pendingTotpUsername,
            remember,
            connectPage.getAutoConnect(),
          );
          startSession(
            pendingTotpHost,
            result.token,
            pendingTotpUsername,
            savedPassword,
            remember,
            true,
            undefined,
            connectPage.getAutoConnect(),
          );
        }
      },
      onAddProfile(name, host) {
        profileManager.addProfile({
          name,
          host,
          username: "",
          autoConnect: false,
          rememberPassword: false,
          color: "#5865F2",
        });
        persistProfiles();
        connectPage.refreshProfiles(getProfileList());
        // Check health for the new profile
        runHealthChecks(connectPage, getProfileList(), pageOwner);
      },
      onDeleteProfile(profileId) {
        // Look the host up before removal: deleting a saved profile must
        // also drop its OS credential, or re-adding the same host resumes
        // the old remembered password (F11). Credentials are keyed by host,
        // so keep it while another profile still points at that server.
        const host = profileManager.getAll().find((p) => p.id === profileId)?.host;
        profileManager.removeProfile(profileId);
        if (host && !profileManager.getAll().some((p) => p.host === host)) {
          void deleteCredential(host);
          forgetServerWait(host);
        }
        persistProfiles();
        connectPage.refreshProfiles(getProfileList());
      },
      onToggleAutoLogin(profileId, enabled) {
        mutateAutoLogin(() => profileManager.setAutoLogin(enabled ? profileId : null));
        persistProfiles();
        connectPage.refreshProfiles(getProfileList());
      },
      onAutoLoginCancel() {
        cancelAutoLogin();
        deactivatePendingMessages();
        api.endSession();
        // Every read of this flag (in app/autoLogin.ts) runs before the overlay carrying
        // this Cancel button is ever painted, so by the time a click
        // reaches here the session is already in flight (startSession has
        // called ws.connect and registered listeners). Tear it down the
        // same way the logout path does.
        abandonInFlight();
      },
      onUpdateClient(host) {
        // The portal's update ships with the server: reloading fetches it.
        if (__OWNCORD_WEB__) location.reload();
        else mountUpdateNotifier(host);
      },
    },
    getProfileList(),
  );

  const [startAutoLogin, cancelAutoLogin, forgetServerWait] = createAutoLogin(
    api,
    profileManager,
    pageOwner,
    connectPage,
    ensureProfileExists,
    getProfileList,
  );

  safeMount(connectPage, appEl, renderRecovery);

  // A server refused this client's protocol epoch as too old: state the
  // requirement on the connect page itself and offer the update there. The
  // main page's notifier never mounts on a refusal, so without this the user
  // would have to fetch the installer by hand. Subscribed, not read once:
  // on a first login or a startup auto-login this page is already mounted
  // when the refusal arrives and nothing re-renders it (no overlay exists
  // before auth_ok, so the isAuthenticated subscriber below does not
  // navigate).
  let updateNotifier: MountableComponent | null = null;
  const mountUpdateNotifier = (host: string): void => {
    // A later refusal (another server tried from this same page) replaces
    // the banner rather than being ignored.
    updateNotifier?.destroy?.();
    const notifier = createUpdateNotifier({ serverUrl: `https://${bracketBareIPv6Host(host)}` });
    notifier.mount(appEl);
    updateNotifier = notifier;
  };
  const offerUpdate = (required: UpdateRequired | null): void => {
    if (!required) return;
    // Consume the fact: the next connect page must not re-offer it.
    setUpdateRequiredHost(null);
    connectPage.showIncompatible(required.host, required.serverEpoch, required.clientEpoch);
    if (
      !__OWNCORD_WEB__ &&
      required.serverEpoch !== null &&
      required.serverEpoch > required.clientEpoch
    ) {
      mountUpdateNotifier(required.host);
    }
  };
  const unsubUpdateRequired = uiStore.subscribeSelector((s) => s.updateRequiredHost, offerUpdate);
  offerUpdate(uiStore.getState().updateRequiredHost);

  // Periodic health check — re-run every 15s so offline servers update when they come back
  const healthCheckInterval = setInterval(() => {
    runHealthChecks(connectPage, getProfileList(), pageOwner);
  }, 15_000);

  pageOwner.addCleanup(() => clearInterval(healthCheckInterval));
  pageOwner.addCleanup(unsubUpdateRequired);
  // Page-owned checks and listeners cannot update a later connect screen: the
  // scope's cleanups clear the health interval and the store subscription, and
  // destroy also tears down the update notifier and the page.
  const page = {
    destroy(): void {
      pageOwner.dispose();
      updateNotifier?.destroy?.();
      connectPage.destroy?.();
    },
  };

  // Route deep-link invites into this connect page. Apply any that arrived
  // before it mounted.
  const pendingInvite = takePendingInvite();
  if (pendingInvite !== null) connectPage.applyInviteLink(pendingInvite.code, pendingInvite.host);

  startAutoLogin();

  return [
    page,
    // A health-refresh hook so trusting a first-use certificate can re-check
    // the now-reachable server without a full page navigation.
    () => runHealthChecks(connectPage, getProfileList(), pageOwner),
    (code, host) => connectPage.applyInviteLink(code, host),
  ];
}
