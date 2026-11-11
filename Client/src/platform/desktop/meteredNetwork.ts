import { addPluginListener, type PluginListener } from "@tauri-apps/api/core";
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import { tryInvoke } from "./nativeInvoke";
import type { MeteredNetwork } from "../contracts/meteredNetwork";

const log = createLogger("meteredNetwork");
let metered = false;
let generation = 0;
let warned = false;

function warnOnce(): void {
  if (warned) return;
  warned = true;
  log.warn("Network cost unavailable; treating this connection as unmetered");
}

function readMetered(value: unknown): boolean | null {
  return typeof value === "object" &&
    value !== null &&
    "metered" in value &&
    typeof value.metered === "boolean"
    ? value.metered
    : null;
}

function stop(listener: PluginListener): void {
  void listener.unregister().catch(warnOnce);
}

export const meteredNetwork: MeteredNetwork = {
  isMetered: () => isAndroidHost() && metered,
  async start(signal) {
    const mine = ++generation;
    metered = false;
    if (!isAndroidHost() || signal.aborted) return;
    let revision = 0;
    let listener: PluginListener;
    try {
      listener = await addPluginListener<unknown>(
        "owncord-metered-network",
        "metered-changed",
        (payload) => {
          if (signal.aborted || generation !== mine) return;
          const next = readMetered(payload);
          if (next === null) return;
          revision++;
          metered = next;
        },
      );
    } catch {
      warnOnce();
      return;
    }
    if (signal.aborted || generation !== mine) {
      stop(listener);
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        stop(listener);
        if (generation === mine) metered = false;
      },
      { once: true },
    );
    const before = revision;
    const result = await tryInvoke<unknown>("is_metered");
    if (signal.aborted || generation !== mine || revision !== before) return;
    const value = result.ok ? readMetered(result.value) : null;
    metered = value ?? false;
    if (value === null) warnOnce();
  },
};
