// Client auto-update service.
// Uses custom Tauri commands that build the updater with a dynamic server URL
// at runtime (required because OwnCord is self-hosted).
//
// Lifted verbatim from `lib/net/updater.ts`, install guard and all:
// `installation` stays non-null once native installation succeeds, because
// reinstalling cannot repair a failed app restart. One change of form, none of
// behaviour: `plugin-process` is now a dynamic `import()`. `lib/net/updater.ts` was
// only reachable from a lazy chunk, and this registry is statically reachable
// from the entry, so a static import here would land the plugin in startup.

import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import type {
  AppUpdater,
  DownloadProgress,
  UpdateCheckResult,
  UpdateFailureReason,
  UpdateInstallState,
} from "../contracts/updater";

const log = createLogger("updater");

let installation: Promise<void> | null = null;
let installState: UpdateInstallState = { status: "idle" };
const installListeners = new Set<(state: UpdateInstallState) => void>();

/** Observe the app-wide install, including when its original page has closed. */
function subscribeToUpdateInstall(listener: (state: UpdateInstallState) => void): () => void {
  installListeners.add(listener);
  notifyInstallListener(listener, installState);
  return () => {
    installListeners.delete(listener);
  };
}

function publishInstallState(state: UpdateInstallState): void {
  installState = state;
  for (const listener of installListeners) {
    notifyInstallListener(listener, state);
  }
}

function notifyInstallListener(
  listener: (state: UpdateInstallState) => void,
  state: UpdateInstallState,
): void {
  try {
    listener(state);
  } catch (err) {
    log.error("Update observer failed", { error: String(err) });
  }
}

/** The backend's stable error prefixes for a .deb install that did not run
 *  (`src-tauri/src/text.rs`): the password prompt dismissed, or no permission. */
const FAILURE_REASONS = new Map<string, UpdateFailureReason>([
  // i18n-exempt: backend error code (text.rs), mapped to catalog text by the notifier
  ["update cancelled", "cancelled"],
  // i18n-exempt: backend error code (text.rs), mapped to catalog text by the notifier
  ["update not authorized", "not-authorized"],
  // i18n-exempt: backend error code (text.rs), mapped to catalog text by the notifier
  ["update install permission needed", "android-permission"],
]);

/** Check if a newer client version is available on the connected server. */
async function checkForUpdate(serverUrl: string): Promise<UpdateCheckResult> {
  try {
    const result = await invoke<UpdateCheckResult>("check_client_update", {
      serverUrl,
    });
    if (result.available) {
      log.info("Update available", { version: result.version });
    } else {
      log.debug("No update available");
    }
    return result;
  } catch (err) {
    log.error("Update check failed", { error: String(err) });
    return { available: false, version: null, body: null, manual_upgrade: false, failed: true };
  }
}

/**
 * Download and install a pending update, then relaunch the app.
 * All callers join the same operation, even across page changes. Reserve it
 * before registering the progress listener, which is itself asynchronous.
 */
function downloadAndInstallUpdate(serverUrl: string): Promise<void> {
  if (installation !== null) return installation;

  installation = Promise.resolve().then(async () => {
    log.info("Downloading and installing update...");
    let installed = false;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<DownloadProgress>("update-progress", (event) => {
        publishInstallState({
          status: "downloading",
          progress: { received: event.payload.received, total: event.payload.total ?? null },
        });
      });
      let unlistenInstalling: (() => void) | null = null;
      let unlistenHandedOff: (() => void) | null = null;
      let handedOff = false;
      try {
        // A .deb install asks for the system password after the download; the
        // backend says so just before it does.
        unlistenInstalling = await listen("update-installing", () => {
          publishInstallState({ status: "installing" });
        });
        // Android opens its own installer and restarts the app after the
        // user taps Install there.
        unlistenHandedOff = await listen("update-installer-opened", () => {
          handedOff = true;
        });
        await invoke("download_and_install_update", { serverUrl });
        installed = true;
      } finally {
        unlistenHandedOff?.();
        unlistenInstalling?.();
        unlisten();
      }
      if (handedOff) {
        // The user can close Android's prompt, so the update must stay
        // startable again.
        installation = null;
        publishInstallState({
          status: "failed",
          restartRequired: false,
          reason: "android-confirm",
        });
        return;
      }
      log.info("Update installed, relaunching...");
      publishInstallState({ status: "restarting" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      // A failed download may be retried. Once native installation succeeds,
      // keep the guard: reinstalling cannot repair a failed app restart.
      if (!installed) installation = null;
      publishInstallState({
        status: "failed",
        restartRequired: installed,
        reason: installed ? undefined : FAILURE_REASONS.get(String(err)),
      });
      throw err;
    }
  });
  publishInstallState({ status: "downloading", progress: null });
  return installation;
}

export const updater: AppUpdater = {
  available: true,
  checkForUpdate,
  downloadAndInstallUpdate,
  subscribeToInstall: subscribeToUpdateInstall,
};
