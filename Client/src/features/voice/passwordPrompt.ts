// The password dialog a refused voice_join opens, and the join its submit
// sends. The password goes from the input straight into one voice_join frame:
// it is not kept in a store, a closure that outlives the dialog, or the log.
import { voiceStore } from "../../stores/voice.store";
import { channelsStore } from "../../stores/channels.store";
import { uiStore } from "../../stores/ui.store";
import { registerSessionReset } from "../../lib/net/sessionRegistry";
import { showToast } from "../../lib/ui/toast";
import { createLogger } from "../../lib/logger";
import type { MountableComponent } from "../../lib/text/safeRender";
import type { PasswordProblem } from "./ChannelPasswordDialog";
import type { DispatchWs } from "../connection/dispatchContext";
import { joinBackoffText } from "./joinBackoffText";
import { sendUserJoin, switchWaiting } from "./joinClick";
import { onNonRetryJoin } from "./joinRequest";

const log = createLogger("voice:passwordPrompt");

let active: MountableComponent | null = null;
// Bumped on every open and close, so a dialog chunk that finishes loading
// after the prompt was replaced or the session ended drops itself.
let generation = 0;
// Stops watching the dialog's channel; set while a dialog is open.
let stopWatching: (() => void) | null = null;

// The channel the last prompt asked about, while a typed password may still be
// sent for it: until the session ends or the user starts any other join.
let askedChannelId: number | null = null;

/** Close the dialog, if one is open. */
export function closePasswordPrompt(): void {
  generation++;
  const dialog = active;
  active = null;
  stopWatching?.();
  stopWatching = null;
  dialog?.destroy?.();
}

/** The ask is over: close the dialog and refuse a submit still on its way. */
function endAsk(): void {
  askedChannelId = null;
  closePasswordPrompt();
}

// The dialog belongs to the signed-in session: sign-out closes it. The
// registration lives as long as the app.
void registerSessionReset("voice:passwordPrompt", endAsk);
// Any other join starting makes the dialog about an older attempt.
onNonRetryJoin(endAsk);

/**
 * Send the user's own join of `channelId` with the password they typed. Like
 * the sidebar's join (a call the user is in is kept until the server accepts
 * the switch), and the frame is remembered as a password retry so its refusal
 * reopens the dialog.
 */
export function sendPasswordJoin(ws: DispatchWs, channelId: number, password: string): void {
  // No socket: the sidebar already shows the reconnect state and freezes the
  // voice rows, so there is nothing to add. (The catalogs stay out of this
  // module: it is in the startup chunk and only the dialog needs the text.)
  if (uiStore.getState().connectionStatus !== "connected") return;
  // The channel was deleted, or another join took over since the dialog
  // opened: a retry for the old attempt must not fire. A call the user is in
  // does not count: the server keeps it until this switch is accepted.
  if (!channelsStore.getState().channels.has(channelId)) return;
  if (askedChannelId !== channelId || switchWaiting()) return;
  if (voiceStore.getState().currentChannelId === channelId) return;
  const wait = joinBackoffText();
  if (wait !== null) {
    showToast(wait, "error");
    return;
  }
  sendUserJoin(ws, channelId, password);
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
  askedChannelId = channelId;
  const mine = generation;
  const channelName = channelsStore.getState().channels.get(channelId)?.name ?? "";
  void import("./ChannelPasswordDialog").then(
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
