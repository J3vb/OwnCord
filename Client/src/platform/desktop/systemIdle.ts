// System-wide input idle time (`src-tauri/src/idle.rs`), polled by auto-idle.
import { invokeOrThrow } from "./nativeInvoke";
import type { SystemIdle } from "../contracts/systemIdle";

export const systemIdle: SystemIdle = {
  idleMs(): Promise<number | null> {
    return invokeOrThrow<number | null>("system_idle_ms");
  },
};
