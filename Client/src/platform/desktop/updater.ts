// Client auto-update service.
// Uses custom Tauri commands that build the updater with a dynamic server URL
// at runtime (required because OwnCord is self-hosted).
//
// Lifted verbatim from `lib/updater.ts` (B7-5), install guard and all:
// `installation` stays non-null once native installation succeeds, because
// reinstalling cannot repair a failed app restart. One change of form, none of
// behaviour: `plugin-process` is now a dynamic `import()`. `lib/updater.ts` was
// only reachable from a lazy chunk, and this registry is statically reachable
// from the entry, so a static import here would land the plugin in startup.

import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import type {
  AppUpdater,
  DownloadProgress,
  UpdateCheckResult,
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
    return { available: false, version: null, body: null, manual_upgrade: false };
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
      try {
        await invoke("download_and_install_update", { serverUrl });
        installed = true;
      } finally {
        unlisten();
      }
      log.info("Update installed, relaunching...");
      publishInstallState({ status: "restarting" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      // A failed download may be retried. Once native installation succeeds,
      // keep the guard: reinstalling cannot repair a failed app restart.
      if (!installed) installation = null;
      publishInstallState({ status: "failed", restartRequired: installed });
      throw err;
    }
  });
  publishInstallState({ status: "downloading", progress: null });
  return installation;
}

export const updater: AppUpdater = {
  checkForUpdate,
  downloadAndInstallUpdate,
  subscribeToInstall: subscribeToUpdateInstall,
};
