// Graphics card for video (`src-tauri/src/gpu_adapter.rs`). Both calls turn a
// native failure into a typed result: the settings row hides or reports
// "not saved", never a rejection.
import { createLogger } from "@lib/logger";
import { tryInvoke } from "./nativeInvoke";
import type { GpuAdapter, GpuAdapterState, GpuCardInfo } from "../contracts/gpuAdapter";

const log = createLogger("gpuAdapter");

function isCard(value: unknown): value is GpuCardInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.vendorId === "number" &&
    typeof v.deviceId === "number"
  );
}

function isState(value: unknown): value is GpuAdapterState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.cards) &&
    v.cards.every(isCard) &&
    typeof v.saved === "string" &&
    (v.active === null || typeof v.active === "string") &&
    typeof v.notFound === "boolean" &&
    typeof v.resetAfterCrash === "boolean"
  );
}

/** WebView2 is the only webview that takes the card choice. */
function onWindows(): boolean {
  return typeof navigator !== "undefined" && /\bWindows\b/.test(navigator.userAgent);
}

export const gpuAdapter: GpuAdapter = {
  get available(): boolean {
    return onWindows();
  },
  async list(): Promise<GpuAdapterState | null> {
    if (!onWindows()) return null;
    const result = await tryInvoke<unknown>("get_gpu_adapters");
    // No log: the row is simply not shown.
    if (!result.ok) return null;
    return isState(result.value) ? result.value : null;
  },
  async set(choice: string): Promise<boolean> {
    const result = await tryInvoke<unknown>("set_gpu_adapter", { choice });
    if (!result.ok) log.warn("graphics card not saved", { error: result.error.message });
    return result.ok;
  },
};
