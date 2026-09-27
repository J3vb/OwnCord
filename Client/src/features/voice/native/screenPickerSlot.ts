// The screen-share dialog is a component, so a lower layer may not import it
// (ARCH-06). The UI layer registers the dialog here, the same injection shape
// as `lib/read-state.ts`'s `setMarkReadSender`, and the native picker adapter
// calls it. A leaf module with no imports of its own, so the UI can import the
// setter without pulling the native voice tree into its chunk.
import type { StreamQuality } from "@lib/screenShare";
import type { NativeVoiceScreenSource } from "../../../platform/contracts/nativeVoice";

/** What the dialog returns for a confirmed share. */
export interface ScreenSharePickChoice {
  /** A host source id, or "portal" on Wayland. */
  readonly source: string;
  readonly quality: StreamQuality;
  readonly fps: number;
}

/** What the dialog is handed to render. */
export interface ScreenSharePickerRequest {
  readonly sources: readonly NativeVoiceScreenSource[];
  readonly portal: boolean;
  readonly defaultQuality: StreamQuality;
  readonly defaultFps: number;
}

/** The dialog itself. Returns null on dismissal. */
export type ScreenSourcePicker = (
  request: ScreenSharePickerRequest,
) => Promise<ScreenSharePickChoice | null>;

let picker: ScreenSourcePicker | null = null;

/**
 * Register the screen-share dialog. Called once from MainPage (which owns the
 * component layer). Registering null (page teardown) leaves a share cancelled
 * rather than throwing.
 */
export function setScreenSourcePicker(next: ScreenSourcePicker | null): void {
  picker = next;
}

/** The registered dialog, or null when none is registered (headless). */
export function getScreenSourcePicker(): ScreenSourcePicker | null {
  return picker;
}
