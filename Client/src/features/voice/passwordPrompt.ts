// The password dialog a refused voice_join opens, and the join its submit
// sends. The password goes from the input straight into one voice_join frame:
// it is not kept in a store, a closure that outlives the dialog, or the log.
import { joinVoiceChannel, voiceStore } from "../../stores/voice.store";
import { channelsStore } from "../../stores/channels.store";
import { uiStore } from "../../stores/ui.store";
import { registerSessionReset } from "../../lib/sessionRegistry";
import { showToast } from "../../lib/toast";
import { createLogger } from "../../lib/logger";
import type { MountableComponent } from "../../lib/safe-render";
import type { PasswordProblem } from "../../components/ChannelPasswordDialog";
import type { DispatchWs } from "../connection/dispatchContext";
import { joinBackoffText } from "./joinBackoffText";
import { noteJoinSent, onNonRetryJoin } from "./joinRequest";

const log = createLogger("voice:passwordPrompt");

let active: MountableComponent | null = null;
// Bumped on every open and close, so a dialog chunk that finishes loading
// after the prompt was replaced or the session ended drops itself.
let generation = 0;
// Stops watching the dialog's channel; set while a dialog is open.
let stopWatching: (() => void) | null = null;

/** Close the dialog, if one is open. */
export function closePasswordPrompt(): void {
  generation++;
  const dialog = active;
  active = null;
  stopWatching?.();
  stopWatching = null;
  dialog?.destroy?.();
}

// The dialog belongs to the signed-in session: sign-out closes it. The
// registration lives as long as the app.
void registerSessionReset("voice:passwordPrompt", closePasswordPrompt);
// Any other join starting makes the dialog about an older attempt.
onNonRetryJoin(closePasswordPrompt);

/**
 * Send the user's own join of `channelId` with the password they typed. Like
 * the sidebar's join: the store goes to "joining" first, and the frame is
 * remembered as a password retry so its refusal reopens the dialog.
 */
export function sendPasswordJoin(ws: DispatchWs, channelId: number, password: string): void {
  // No socket: the sidebar already shows the reconnect state and freezes the
  // voice rows, so there is nothing to add. (The catalogs stay out of this
  // module: it is in the startup chunk and only the dialog needs the text.)
  if (uiStore.getState().connectionStatus !== "connected") return;
  // The channel was deleted, or another join or call took over since the
  // dialog opened: a retry for the old attempt must not fire.
  if (!channelsStore.getState().channels.has(channelId)) return;
  if (voiceStore.getState().currentChannelId !== null) return;
  const wait = joinBackoffText();
  if (wait !== null) {
    showToast(wait, "error");
    return;
  }
  joinVoiceChannel(channelId);
  noteJoinSent(
    ws.send({
      type: "voice_join",
      payload: { channel_id: channelId, user_initiated: true, password },
    }),
    true,
  );
}

/**
 * Ask for `channelId`'s password. At most one dialog is open: a newer ask
 * replaces the older one (a refused retry reopens it with the error).
 */
export function promptForChannelPassword(
  ws: DispatchWs,
  channelId: number,
  problem: PasswordProblem | null,
): void {
  closePasswordPrompt();
  // A socket that is gone has nothing to join with; the session may be over.
  if (uiStore.getState().connectionStatus !== "connected") return;
  if (!channelsStore.getState().channels.has(channelId)) return;
  const mine = generation;
  const channelName = channelsStore.getState().channels.get(channelId)?.name ?? "";
  void import("../../components/ChannelPasswordDialog").then(
    ({ createChannelPasswordDialog }) => {
      if (mine !== generation) return;
      const dialog = createChannelPasswordDialog({
        channelName,
        problem,
        onSubmit: (password) => sendPasswordJoin(ws, channelId, password),
        onClose: () => {
          if (active === dialog) active = null;
        },
      });
      active = dialog;
      // The channel going away (deleted, or no longer visible) ends the ask.
      stopWatching = channelsStore.subscribeSelector(
        (s) => s.channels.has(channelId),
        (present) => {
          if (!present) closePasswordPrompt();
        },
      );
      dialog.mount(document.body);
    },
    (err: unknown) => log.error("Password dialog failed to load", err),
  );
}
