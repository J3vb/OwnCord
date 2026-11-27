/** What a server switcher needs from the page, and the options it builds from it. */

import type { ServerRailOptions } from "./ServerRail";
import { addServer, loadSavedServers, switchToServer } from "./switchServer";
import { pendingRequestCount } from "../message-requests/store";
import { confirmAndJoinInvite, currentServerName, parseInviteInput } from "./joinInvite";

export interface ServerSwitcherDeps {
  readonly host: string;
  readonly isTornDown: () => boolean;
  readonly onOpenDm: NonNullable<ServerRailOptions["onOpenDm"]>;
  readonly onShowServer: () => void;
  /** Called with the rail's teardown once it is mounted. */
  readonly own: (destroy: () => void) => void;
}

/** The switcher's options for this session: its server, the saved list, switching and joining. */
export function switcherOptions(deps: ServerSwitcherDeps): ServerRailOptions {
  const { host } = deps;
  return {
    currentHost: host,
    loadServers: loadSavedServers,
    switchServer: switchToServer,
    addServer,
    onOpenDm: deps.onOpenDm,
    onShowServer: deps.onShowServer,
    pendingRequests: pendingRequestCount,
    joinInvite: (text) => {
      const invite = parseInviteInput(text);
      if (invite === null) return false;
      confirmAndJoinInvite(invite, currentServerName(host));
      return true;
    },
  };
}
