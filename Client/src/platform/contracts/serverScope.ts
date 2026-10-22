/**
 * Which server this client instance is bound to. The desktop app talks to any
 * server the user adds, so it has no fixed host (`null`). A client served by a
 * server's own web portal talks only to that server, and names it here so the
 * connect flow can skip the host picker.
 */
export interface ServerScope {
  /** The one host this client may connect to, or null when the user chooses. */
  readonly fixedHost: string | null;
}
