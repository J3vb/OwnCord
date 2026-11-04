/**
 * The graphics card WebView2 starts on (Windows). The host reads the choice
 * once at startup, before the webview exists, so a change applies on the next
 * start (`src-tauri/src/gpu_adapter.rs`).
 */
export interface GpuCardInfo {
  /** Stable across reboots; what `set` takes. */
  readonly id: string;
  readonly name: string;
  readonly vendorId: number;
  readonly deviceId: number;
}

export interface GpuAdapterState {
  readonly cards: readonly GpuCardInfo[];
  /** "auto" or a card id. */
  readonly saved: string;
  /** The card applied this launch, if any. */
  readonly active: string | null;
  /** The saved card is gone, so Auto was used. */
  readonly notFound: boolean;
  /** The last start on a chosen card did not finish, so the choice was reset. */
  readonly resetAfterCrash: boolean;
  /** Auto leaves the card to Windows after a start on its pick did not finish. */
  readonly autoOff: boolean;
}

export interface GpuAdapter {
  /** True where the host can list cards (the Windows desktop app). */
  readonly available: boolean;
  /** The cards and the current choice, or null when the host cannot answer. */
  list(): Promise<GpuAdapterState | null>;
  /** Save "auto" or a card id. False when the host refused or could not save it. */
  set(choice: string): Promise<boolean>;
}
