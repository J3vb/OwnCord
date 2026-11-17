// The Android call service (`src-tauri/src/call_service.rs`, `CallService.kt`):
// a facade that loads the host side (`./callServiceHost.ts`) on first use
// (`./androidHost.ts`). Desktop hosts keep running in the background on their
// own, so only the Android app has a host to talk to.
import { androidHost } from "./androidHost";
import type { CallService } from "../contracts/callService";

const withHost = androidHost("callService", () => import("./callServiceHost"));

export const callService: CallService = {
  update: (state) => withHost((host) => host.update(state)),
  onAction: (signal, handler) => withHost((host) => host.onAction(signal, handler)),
};
