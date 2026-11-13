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

export const pushRegistration: PushRegistration = {
  get supported() {
    return isAndroidHost();
  },
  async status() {
    if (!isAndroidHost()) return null;
    return (await host()).status();
  },
  async choose(distributor) {
    if (!isAndroidHost()) return false;
    return (await host()).choose(distributor);
  },
  async register(request) {
    if (!isAndroidHost()) return { ok: false, reason: "failed" };
    return (await host()).register(request);
  },
  async unregister(instance) {
    if (!isAndroidHost()) return;
    await (await host()).unregister(instance);
  },
  follow(signal, onEvent) {
    if (!isAndroidHost()) return;
    host().then(
      (h) => h.follow(signal, onEvent),
      (err: unknown) => log.warn("Push host side unavailable", err),
    );
  },
};
