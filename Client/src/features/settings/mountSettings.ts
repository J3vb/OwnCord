/**
 * The signed-in Settings overlay: account, profile, 2FA, sessions and API
 * tokens, wired to the API client and the auth store. The page passes in what
 * only it owns (the API client, its focus fallback, presence and the cache
 * scope) and mounts the result.
 */
import { ApiClientError, errorText } from "@lib/api";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { loadCredential, saveCredential } from "@lib/net/credentials";
import type { UserStatus } from "@lib/types";
import { createSettingsOverlay } from "./SettingsOverlay";
import { showToast, showChangeOutcomeToast } from "@lib/ui/toast";
import { accountText as account } from "../../i18n/account";
import { logout } from "../connection/logout";
import { authStore, clearAuth, updateUser } from "@stores/auth.store";
import { closeSettings } from "@stores/ui.store";
import {
  fetchImageAsObjectUrl,
  formatFileSize,
  isImageMime,
  pruneAttachmentCacheScope,
  resolveServerUrl,
  thumbnailUrl,
} from "../messaging/content/attachments";
import { NAVIGATION_DESTINATIONS } from "../navigation/destinations";

const log = createLogger("main-page");

/** What the Settings overlay needs from the page that mounts it. */
export interface SettingsMountDeps {
  readonly api: ApiClient;
  /** The page's attachment cache scope, pruned when the account is deleted. */
  readonly cacheScope: string | null;
  readonly fallbackFocus: () => HTMLElement | null;
  readonly getRetentionNotice?: () => string | null;
  readonly applyPresence: (status: UserStatus) => void;
}

/**
 * Keep a remembered sign-in password in step with a password change made here:
 * the stored copy would otherwise be refused by the server at the next
 * one-click sign-in. Nothing is stored for a host that holds no password.
 */
async function refreshRememberedPassword(host: string, newPassword: string): Promise<void> {
  const token = authStore.getState().token;
  if (token === null) return;
  try {
    const stored = await loadCredential(host);
    if (stored === null || !stored.hasPassword || authStore.getState().token !== token) return;
    const saved = await saveCredential(host, stored.username, token, newPassword);
    if (!saved) log.warn("The remembered password could not be updated after a password change");
  } catch (err) {
    log.warn("The remembered password could not be updated after a password change", {
      error: String(err),
    });
  }
}

export function createAccountSettingsOverlay(
  deps: SettingsMountDeps,
): ReturnType<typeof createSettingsOverlay> {
  const { api } = deps;
  // Bumped by every local 2FA change so an in-flight profile refresh
  // cannot overwrite it with an older answer.
  let totpEpoch = 0;

  const safety = NAVIGATION_DESTINATIONS.safety;

  return createSettingsOverlay({
    onClose: () => closeSettings(),
    fallbackFocus: deps.fallbackFocus,
    onChangePassword: async (oldPassword, newPassword, revokeApiTokens) => {
      try {
        const outcome = await api.changePassword(oldPassword, newPassword, revokeApiTokens);
        const host = api.getConfig().host;
        if (host) await refreshRememberedPassword(host, newPassword);
        showChangeOutcomeToast(outcome, account("toast.passwordChanged"));
        // The form shows the same outcome inline, so a partial success is
        // never a green "changed successfully" beside the warning toast.
        return outcome;
      } catch (err) {
        const msg = errorText(err, account("toast.passwordChangeFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onUpdateProfile: async (patch) => {
      try {
        // The username is required by the API but optional in the patch (the
        // profile form only edits the display name and about), so fill it in
        // from the current user rather than making every caller repeat it.
        const username = patch.username ?? authStore.getState().user?.username ?? "";
        const updated = await api.updateProfile({ ...patch, username });
        updateUser({
          username: updated.username,
          display_name: updated.display_name ?? null,
          about: updated.about ?? null,
          // An older server sends no banner keys: leave the stored colour be.
          ...(updated.banner_color === undefined ? {} : { banner_color: updated.banner_color }),
        });
        showToast(account("toast.profileUpdated"), "success");
      } catch (err) {
        const msg = errorText(err, account("toast.profileUpdateFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onUploadAvatar: async (file) => {
      try {
        const uploaded = await api.uploadAvatar(file);
        // The server has already pointed the column at the served file and
        // broadcast a user_update; this keeps the local copy from lagging a
        // round-trip behind.
        updateUser({ avatar: uploaded.url });
        showToast(account("toast.avatarUpdated"), "success");
        return uploaded.url;
      } catch (err) {
        const msg = errorText(err, account("toast.avatarUploadFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onRemoveAvatar: async () => {
      try {
        const username = authStore.getState().user?.username ?? "";
        const updated = await api.removeAvatar(username);
        // Same as the upload path: the user_update broadcast also lands, but
        // this keeps the local copy from lagging a round-trip behind.
        updateUser({ avatar: updated.avatar ?? null });
        showToast(account("toast.avatarRemoved"), "success");
      } catch (err) {
        const msg = errorText(err, account("toast.avatarRemoveFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onUploadBanner: async (file) => {
      try {
        const uploaded = await api.uploadBanner(file);
        // The user_update broadcast also lands; this keeps the card from lagging.
        updateUser({ banner: uploaded.url });
        showToast(account("toast.bannerUpdated"), "success");
        return uploaded.url;
      } catch (err) {
        // 404: the server advertises banners but has attachment storage off,
        // so the upload route is not mounted.
        const msg =
          err instanceof ApiClientError && err.status === 404
            ? account("profile.bannerStorageOff")
            : errorText(err, account("profile.bannerUploadFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onRemoveBanner: async () => {
      try {
        const updated = await api.removeBanner();
        updateUser({ banner: updated.banner ?? null });
        showToast(account("toast.bannerRemoved"), "success");
      } catch (err) {
        showToast(errorText(err, account("toast.bannerRemoveFailed")), "error");
        throw err;
      }
    },
    onLogout: () => logout(api),
    getRetentionNotice: deps.getRetentionNotice,
    ...(safety === undefined ? {} : { safetyTab: (signal) => safety.build(signal, api) }),
    myUploadsTab: (signal) => {
      // Loaded on first open, like the About tab: the list code stays out of this chunk.
      const host = document.createElement("div");
      host.className = "settings-pane active";
      void import("../uploads/myUploadsTab").then(
        ({ buildMyUploadsTab }) => {
          if (!signal.aborted)
            host.replaceWith(
              buildMyUploadsTab(signal, api, {
                formatFileSize,
                isImage: isImageMime,
                thumbnail: (att) =>
                  fetchImageAsObjectUrl(thumbnailUrl(resolveServerUrl(att.url), att.mime)),
              }),
            );
        },
        (err: unknown) => {
          log.warn("My uploads tab failed to load", { error: String(err) });
        },
      );
      return host;
    },
    onDeleteAccount: async (password) => {
      await api.deleteAccount(password);
      clearAuth();
      // The account is gone, so its cached server images go too.
      // clearAuth has already disarmed the scope, so no late write follows.
      if (deps.cacheScope !== null) await pruneAttachmentCacheScope(deps.cacheScope);
      showToast(account("toast.accountDeleted"), "success");
    },
    onEnableTotp: async (password) => {
      try {
        return await api.enableTotp(password);
      } catch (err) {
        const msg = errorText(err, account("toast.enableTotpFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onConfirmTotp: async (password, code) => {
      try {
        const outcome = await api.confirmTotp(password, code);
        totpEpoch++;
        updateUser({ totp_enabled: true });
        showChangeOutcomeToast(outcome, account("toast.totpEnabled"));
      } catch (err) {
        const msg = errorText(err, account("toast.confirmTotpFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onDisableTotp: async (password) => {
      try {
        const outcome = await api.disableTotp(password);
        totpEpoch++;
        updateUser({ totp_enabled: false });
        showChangeOutcomeToast(outcome, account("toast.totpDisabled"));
      } catch (err) {
        const msg = errorText(err, account("toast.disableTotpFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onRefreshTotpStatus: async () => {
      // GET /auth/me is the only response that states totp_enabled;
      // auth_ok never does. A failed read changes nothing, and
      // a read that lands after the user enabled or disabled 2FA in the
      // meantime is discarded: the local change is newer than the answer.
      const epoch = totpEpoch;
      try {
        const me = await api.getMe();
        if (epoch === totpEpoch && typeof me.totp_enabled === "boolean") {
          updateUser({ totp_enabled: me.totp_enabled });
        }
      } catch (err) {
        log.warn("Failed to refresh the 2FA state", err);
      }
    },
    onRegenerateRecoveryCodes: async (password) =>
      (await api.regenerateRecoveryCodes(password)).backup_codes,
    onEnrolRecoveryKit: (password) => api.enrolRecoveryKit(password),
    onGetRecoveryKitStatus: () => api.getRecoveryKitStatus(),
    onStatusChange: (status) => deps.applyPresence(status),
    onListSessions: () => api.getSessions(),
    onRevokeSession: (id) => api.revokeSession(id),
    onListApiTokens: () => api.getApiTokens(),
    onRevokeApiToken: (id) => api.revokeApiToken(id),
    onRevokeAllSessions: async () => {
      const result = await api.revokeAllSessions();
      // The token died with the response: leave for the connect page now
      // rather than let the next request fail with a 401.
      if (result.current_session_revoked) clearAuth();
      return result;
    },
  });
}
