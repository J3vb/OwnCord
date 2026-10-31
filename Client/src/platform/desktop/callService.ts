// The Android call service (`src-tauri/src/call_service.rs`, `CallService.kt`).
// Desktop hosts keep running in the background on their own, so only the
// Android app talks to the host.
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import { tryInvoke } from "./nativeInvoke";
import type { CallService } from "../contracts/callService";

const log = createLogger("callService");

export const callService: CallService = {
  update(state) {
    if (!isAndroidHost()) return;
    void tryInvoke<void>("set_call_service", { active: state.active, camera: state.camera }).then(
      (result) => {
        if (!result.ok)
          log.warn(
            "Call service refused; the call may stop in the background",
            result.error.message,
          );
      },
    );
  },
};
