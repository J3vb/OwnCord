// System-wide input idle time (`src-tauri/src/idle.rs`), polled by auto-idle.
import { invoke } from "@tauri-apps/api/core";
import type { SystemIdle } from "../contracts/systemIdle";

export const systemIdle: SystemIdle = {
  idleMs(): Promise<number | null> {
    return invoke<number | null>("system_idle_ms");
  },
};
