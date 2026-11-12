// System-wide input idle time (`src-tauri/src/idle.rs`), polled by auto-idle.
// The Android app answers with how long it has been out of view
// (`src-tauri/src/idle_android.rs`) and says when to read that again: that
// side (`./systemIdleHost.ts`) loads on first use (`./androidHost.ts`).
import { androidHost } from "./androidHost";
import { invokeOrThrow } from "./nativeInvoke";
import type { SystemIdle } from "../contracts/systemIdle";

const withHost = androidHost("systemIdle", () => import("./systemIdleHost"));

export const systemIdle: SystemIdle = {
  idleMs(): Promise<number | null> {
    return invokeOrThrow<number | null>("system_idle_ms");
  },
  follow: (signal, thresholdMs, ask) => withHost((host) => host.follow(signal, thresholdMs, ask)),
};
