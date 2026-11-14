// Whether the server of this session builds link previews itself. The protocol
// has no capability flag for it, so the client infers it from the first sign of
// one: a `message_link_previews` frame, or a history row that carries
// `link_previews`. An older server, or one with link_previews.enabled off,
// sends neither, and its messages keep the local fetch (the legacy path).
// Once seen, a message of this session with no cards yet shows none rather than
// falling back to a local fetch. Per server and per session: forgotten with it.
import { registerSessionReset } from "@lib/net/sessionRegistry";

let serverBuildsCards = false;

/** The server has shown it builds link cards. */
export function noteServerBuildsCards(): void {
  serverBuildsCards = true;
}

/** Whether this session's server has shown it builds link cards. */
export function serverBuildsLinkCards(): boolean {
  return serverBuildsCards;
}

/** Forget the evidence (a logout, a server switch). */
export function resetLinkPreviewSession(): void {
  serverBuildsCards = false;
}
void registerSessionReset("link-previews:server-cards", resetLinkPreviewSession); // app-lifetime
