// Push through UnifiedPush (`src-tauri/src/push.rs`, `PushPlugin.kt`). Only the
// Android app has it; desktop hosts keep their socket while open and have no
// push to wake them. The host side (`./pushRegistrationHost.ts`) loads on
// first use, so none of it lands in the startup chunk.
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import type { PushRegistration } from "../contracts/pushRegistration";

const log = createLogger("push");

type Host = typeof import("./pushRegistrationHost");

function host(): Promise<Host> {
  return import("./pushRegistrationHost");
}

/** Runs `use` on the host side; `fallback` when it cannot load, so no call rejects. */
async function withHost<T>(use: (h: Host) => Promise<T>, fallback: T): Promise<T> {
  let h: Host;
  try {
    h = await host();
  } catch (err) {
    log.warn("Push host side unavailable", err);
    return fallback;
  }
  return use(h);
}

export const pushRegistration: PushRegistration = {
  get supported() {
    return isAndroidHost();
  },
  async status() {
    if (!isAndroidHost()) return null;
    return withHost((h) => h.status(), null);
  },
  async choose(distributor) {
    if (!isAndroidHost()) return false;
    return withHost((h) => h.choose(distributor), false);
  },
  async register(request) {
    if (!isAndroidHost()) return { ok: false, reason: "failed" };
    return withHost((h) => h.register(request), { ok: false, reason: "failed" });
  },
  async unregister(instance) {
    if (!isAndroidHost()) return;
    await withHost((h) => h.unregister(instance), undefined);
  },
  follow(signal, onEvent) {
    if (!isAndroidHost()) return;
    host().then(
      (h) => h.follow(signal, onEvent),
      (err: unknown) => log.warn("Push host side unavailable", err),
    );
  },
};
