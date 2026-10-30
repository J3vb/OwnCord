// The owncord:// deep-link handlers: an invite into the register form, a
// message or channel permalink into the main page's jumper, and the external
// invite's ask-first dialog. Moved out of main.ts verbatim; the free variables
// become the router's accessors (./router) and the session's (./session), and
// the api client arrives through installDeepLinks(). Nothing here runs at
// import time: main.ts calls installDeepLinks() at the point in the boot order
// where this code used to be inline. Only main.ts imports this module.

import type { ApiClient } from "@lib/api";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import { openMessageTarget } from "@lib/notifications";
import { setInviteJoinHandler } from "@lib/nav/inviteNavigation";
import { createLogger } from "@lib/logger";
import { authStore, clearAuth } from "@stores/auth.store";
import { voiceStore } from "@stores/voice.store";
import { desktop } from "../platform/desktop";
import { abandonInFlight, sessionInFlight } from "./session";
import { activePageId, applyInviteNow, navigate, queuePendingInvite } from "./router";

const log = createLogger("main");

let api: ApiClient;

// Route owncord:// invite deep links into the register form. OwnCord invites
// are registration invites, so a link can only pre-fill + open the register
// form — it can't complete a join by itself.
function handleInviteDeepLink(code: string, host?: string): void {
  queuePendingInvite({ code, host });
  if (activePageId() === "main") {
    // Let the logout path do the teardown instead of navigating behind a
    // live session: clearAuth() fires while the router is still on "main",
    // so the authStore subscriber in session.ts runs its full teardown (voice leave,
    // dispatcher/session cleanup, ws.disconnect) and navigates to "connect"
    // itself — whose render branch (router.ts) consumes the pending invite.
    //
    // "server_switch", not the default "user": the invite is not a logout, so
    // the current server's credential must survive (the user may return to A
    // later) — the same reason the quick-switch path uses it (F7).
    clearAuth("server_switch");
    return;
  }
  deactivatePendingMessages();
  api.endSession();
  if (sessionInFlight()) {
    // startSession already ran — a login/auto-login/register is connecting,
    // or reached auth_ok (isAuthenticated flipped true) but the connected
    // overlay's ready hand-off hasn't called navigate("main") yet, so
    // the branch above never triggered. The authStore subscriber only tears
    // down once the active page IS "main", so it won't fire for this window
    // either: left alone, the overlay's timer fires navigate("main")
    // regardless, mounting MainPage on top of whatever this handler does to
    // authStore below. Tear the in-flight session down directly, the same
    // way onAutoLoginCancel does, before applying the invite below.
    abandonInFlight();
    if (authStore.getState().isAuthenticated) {
      clearAuth();
    }
  }
  navigate("connect");
  // If the connect page was already mounted, navigate() may not re-render it —
  // apply directly. Otherwise the connect render branch consumes the pending link.
  applyInviteNow(code, host);
}
// Route owncord://message/<channelId>/<messageId> permalinks, and a call
// toast's owncord://channel/<channelId> (no message id), to the main
// page's jumper. Before the main page mounts (or when the channel isn't
// visible to this user) the jump is a logged no-op — a link into a server the
// user is not signed into has nothing to open. A link that named a server (a
// Windows toast's launch URI) is ignored when another server is signed in now,
// the same guard a clicked notification goes through.
function handleMessageDeepLink(
  channelId: number,
  messageId: number | undefined,
  host?: string,
): void {
  openMessageTarget(channelId, messageId, host);
}
// An invite link from outside the app (the OS, a browser, another program)
// would otherwise end the signed-in session the moment it arrives. While
// signed in (or signing in), ask first; Cancel leaves everything as it is and the
// link is dropped. Elsewhere (connect page) nothing is lost, so it runs as
// before. A second link while the dialog is open replaces the first.
function handleExternalInviteLink(code: string, host?: string): void {
  // Signed in, or signing in (the connect call is in flight, or the connected
  // overlay is still up before the main page mounts): taking the link ends
  // that session, so ask. Otherwise nothing is lost and it runs as before.
  if (activePageId() !== "main" && !authStore.getState().isAuthenticated && !sessionInFlight()) {
    handleInviteDeepLink(code, host);
    return;
  }
  const inVoice = voiceStore.getState().currentChannelId !== null;
  const currentName = authStore.getState().serverName ?? api.getConfig().host;
  // On demand, like the in-chat chip: keeps the modal and its catalog out of
  // the startup chunk.
  void Promise.all([import("@components/InviteJoinConfirm"), import("../i18n/messaging")])
    .then(([{ confirmInviteJoin }, { messagingText }]) => {
      const current =
        currentName === undefined || currentName === ""
          ? messagingText("invite.thisServer")
          : currentName;
      confirmInviteJoin(
        messagingText(inVoice ? "invite.openBodyInVoice" : "invite.openBody", { current }),
        () => handleInviteDeepLink(code, host),
        {
          title:
            host === undefined
              ? messagingText("invite.openTitleNoHost")
              : messagingText("invite.openTitle", { target: host }),
          confirmLabel: messagingText("invite.openButton"),
        },
      );
    })
    .catch((err: unknown) => log.warn("Invite confirmation failed to open", err));
}

/**
 * Registers the invite-join handler and the native deep-link listener, in that
 * order. Call after the first render, as the inline code ran.
 */
export function installDeepLinks(apiClient: ApiClient): void {
  api = apiClient;
  // An invite chip clicked in chat already asked ("Leave X to join Y?") through
  // the same dialog before it reached this handler, so it goes straight in.
  setInviteJoinHandler(handleInviteDeepLink);
  void desktop.deepLinks.init(handleExternalInviteLink, handleMessageDeepLink);
}
