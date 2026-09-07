// updater.ts — Client auto-update service.
// Uses custom Tauri commands that build the updater with a dynamic server URL
// at runtime (required because OwnCord is self-hosted).

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { createLogger } from "@lib/logger";

const log = createLogger("updater");

export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version: string | null;
  readonly body: string | null;
}

/** Download progress reported by the Rust updater during install. */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

export type UpdateInstallState =
  | { readonly status: "idle" }
  | { readonly status: "downloading"; readonly progress: DownloadProgress | null }
  | { readonly status: "restarting" }
  | { readonly status: "failed"; readonly restartRequired: boolean };

let installation: Promise<void> | null = null;
let installState: UpdateInstallState = { status: "idle" };
const installListeners = new Set<(state: UpdateInstallState) => void>();

/** Observe the app-wide install, including when its original page has closed. */
export function subscribeToUpdateInstall(
  listener: (state: UpdateInstallState) => void,
): () => void {
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
export async function checkForUpdate(serverUrl: string): Promise<UpdateCheckResult> {
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
    return { available: false, version: null, body: null };
  }
}

/**
 * Download and install a pending update, then relaunch the app.
 * All callers join the same operation, even across page changes. Reserve it
 * before registering the progress listener, which is itself asynchronous.
 */
export function downloadAndInstallUpdate(serverUrl: string): Promise<void> {
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
