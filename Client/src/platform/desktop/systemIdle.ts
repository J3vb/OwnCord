// System-wide input idle time (`src-tauri/src/idle.rs`), polled by auto-idle.
import { isAndroidHost } from "@lib/hostPlatform";
import { invokeOrThrow } from "./nativeInvoke";
import type { SystemIdle } from "../contracts/systemIdle";

export const systemIdle: SystemIdle = {
  idleMs(): Promise<number | null> {
    // A phone has no system idle time to read; null leaves the in-app timer in
    // charge, as in the browser build.
    if (isAndroidHost()) return Promise.resolve(null);
    return invokeOrThrow<number | null>("system_idle_ms");
  },
};
