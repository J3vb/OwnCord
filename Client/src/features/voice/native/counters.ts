// Native-backend resource counts for the facade's debug surface (B7-11 rule
// 3: the long-session soak cannot see Rust memory, so it reads these). The
// TS-side counts are exact; the Rust snapshot is whatever the backend last
// reported: the return of NativeRoom.disconnect(), or the refresh each
// LiveKitSession.getSessionDebugInfo() read requests — so a read shows the
// snapshot from the previous read or disconnect, whichever landed last. A
// leaf module with no imports so the facade can read it without pulling the
// native backend into its chunk.

import type { NativeVoiceResources } from "../../../platform/contracts/nativeVoice";

export const nativeCounters = {
  /** NativeRoom instances connected and not yet disconnected. */
  openRooms: 0,
  /** Tauri `native-voice` subscriptions currently registered. */
  listeners: 0,
  /** Remote video renderers (one frame socket and GL context each) alive. */
  videoRenderers: 0,
  /** Camera frame pumps (one frame socket each) alive. */
  cameraUplinks: 0,
  /** Last Rust-reported snapshot, null before the first report. */
  rust: null as NativeVoiceResources | null,
};
