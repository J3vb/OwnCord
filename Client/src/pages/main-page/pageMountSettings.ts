/**
 * Main page mount steps for the settings overlay, the quick switcher, keyboard
 * and global shortcuts, and toasts.
 */
import { ApiClientError, errorText } from "@lib/api";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { showToast, showChangeOutcomeToast } from "@lib/ui/toast";
import { accountText as account } from "../../i18n/account";
import { logout } from "@lib/net/logout";
import { authStore, clearAuth, updateUser } from "@stores/auth.store";
import { closeSettings, uiStore } from "@stores/ui.store";
import {
  fetchImageAsObjectUrl,
  formatFileSize,
  isImageMime,
  pruneAttachmentCacheScope,
  resolveServerUrl,
  thumbnailUrl,
} from "../../features/messaging/content/attachments";
import { createQuickSwitcherManager } from "./OverlayManagers";
import { createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import { NAVIGATION_DESTINATIONS } from "../../features/navigation/destinations";
import { log } from "./pageShared";
import type { PageState, PageApi, MountScope } from "./pageState";

export function mountSettings(st: PageState, pg: PageApi, ms: MountScope): void {
  // Settings overlay
  // Bumped by every local 2FA change so an in-flight profile refresh
  // cannot overwrite it with an older answer.
  ms.totpEpoch = 0;

  ms.safety = NAVIGATION_DESTINATIONS.safety;

  ms.settingsOverlay = createSettingsOverlay({
    onClose: () => closeSettings(),
    fallbackFocus: ms.focusReachable,
    onChangePassword: async (oldPassword, newPassword) => {
      try {
        const outcome = await st.api.changePassword(oldPassword, newPassword);
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
        const updated = await st.api.updateProfile({ ...patch, username });
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
        const uploaded = await st.api.uploadAvatar(file);
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
        const updated = await st.api.removeAvatar(username);
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
        const uploaded = await st.api.uploadBanner(file);
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
        const updated = await st.api.removeBanner();
        updateUser({ banner: updated.banner ?? null });
        showToast(account("toast.bannerRemoved"), "success");
      } catch (err) {
        showToast(errorText(err, account("toast.bannerRemoveFailed")), "error");
        throw err;
      }
    },
    onLogout: () => logout(st.api),
    getRetentionNotice: st.options.getRetentionNotice,
    ...(ms.safety === undefined ? {} : { safetyTab: (signal) => ms.safety!.build(signal, st.api) }),
    myUploadsTab: (signal) => {
      // Loaded on first open, like the About tab: the list code stays out of this chunk.
      const host = document.createElement("div");
      host.className = "settings-pane active";
      void import("../../features/uploads/myUploadsTab").then(
        ({ buildMyUploadsTab }) => {
          if (!signal.aborted)
            host.replaceWith(
              buildMyUploadsTab(signal, st.api, {
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
      await st.api.deleteAccount(password);
      clearAuth();
      // The account is gone, so its cached server images go too.
      // clearAuth has already disarmed the scope, so no late write follows.
      if (st.cacheScope !== null) await pruneAttachmentCacheScope(st.cacheScope);
      showToast(account("toast.accountDeleted"), "success");
    },
    onEnableTotp: async (password) => {
      try {
        return await st.api.enableTotp(password);
      } catch (err) {
        const msg = errorText(err, account("toast.enableTotpFailed"));
        showToast(msg, "error");
        throw err;
      }
    },
    onConfirmTotp: async (password, code) => {
      try {
        const outcome = await st.api.confirmTotp(password, code);
        ms.totpEpoch++;
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
        const outcome = await st.api.disableTotp(password);
        ms.totpEpoch++;
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
      const epoch = ms.totpEpoch;
      try {
        const me = await st.api.getMe();
        if (epoch === ms.totpEpoch && typeof me.totp_enabled === "boolean") {
          updateUser({ totp_enabled: me.totp_enabled });
        }
      } catch (err) {
        log.warn("Failed to refresh the 2FA state", err);
      }
    },
    onRegenerateRecoveryCodes: async (password) =>
      (await st.api.regenerateRecoveryCodes(password)).backup_codes,
    onEnrolRecoveryKit: (password) => st.api.enrolRecoveryKit(password),
    onGetRecoveryKitStatus: () => st.api.getRecoveryKitStatus(),
    onStatusChange: (status) => pg.applyPresence(status),
    onListSessions: () => st.api.getSessions(),
    onRevokeSession: (id) => st.api.revokeSession(id),
    onRevokeAllSessions: async () => {
      const result = await st.api.revokeAllSessions();
      // The token died with the response: leave for the connect page now
      // rather than let the next request fail with a 401.
      if (result.current_session_revoked) clearAuth();
      return result;
    },
  });

  ms.settingsOverlay.mount(st.root!);

  st.children.push(ms.settingsOverlay);

  // Quick switcher (Ctrl+K)
  // Don't fire while the settings panel is on top of it — same guard as
  // attachGlobalKeybinds below, reading the same source of truth.
  ms.qsManager = createQuickSwitcherManager(
    () => st.root,
    () => uiStore.getState().settingsOpen,
    // A voice row in the switcher joins voice (matching the sidebar row): a
    // pick joins, as a click on the row does. The call view's own chat
    // reaches the voice channel through navigateToChannel (callChat).
    (channelId: number) => createSidebarVoiceCallbacks(st.ws).onVoiceJoin(channelId),
    () => ms.sidebar.rememberChannel(),
    () => ms.sidebar.forgetChannel(),
  );

  st.unsubscribers.push(ms.qsManager.attach());
}
