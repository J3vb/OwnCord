// The host side of `callService`, loaded in the Android app only
// (`src-tauri/src/call_service.rs`, `CallServicePlugin.kt`).
import { createLogger } from "@lib/logger";
import { tryInvoke } from "./nativeInvoke";
import type { CallServiceState } from "../contracts/callService";

const log = createLogger("callService");
/** Settles when the last state sent was answered; the next goes out then. */
let answered: Promise<unknown> = Promise.resolve();

/** One state at a time: the host runs each command as a task of its own, and
 *  two on their way at once (a camera going on as its picture appears) could
 *  reach the plugin either way round. `tryInvoke` never rejects, so a refused
 *  state does not hold up the next. */
export function update(state: CallServiceState): void {
  answered = answered
    .then(() =>
      tryInvoke<void>("set_call_service", {
        active: state.active,
        camera: state.camera,
        videoOnScreen: state.videoOnScreen,
      }),
    )
    .then((result) => {
      if (result.ok) return;
      log.warn("Call service refused; the call may stop in the background", result.error.message);
    });
}
