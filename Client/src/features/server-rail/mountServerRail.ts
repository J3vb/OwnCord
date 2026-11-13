/** Loading the server rail into the page on demand. */

import type { ServerRailOptions } from "./ServerRail";
import { createLogger } from "@lib/logger";
import { addServer, loadSavedServers, switchToServer } from "./switchServer";
import { confirmAndJoinInvite, currentServerName, parseInviteInput } from "./joinInvite";

const log = createLogger("main-page");

export interface ServerRailMount {
  readonly host: string;
  readonly slot: HTMLElement;
  readonly isTornDown: () => boolean;
  readonly onOpenDm: NonNullable<ServerRailOptions["onOpenDm"]>;
  readonly onShowServer: () => void;
  /** Called with the rail's teardown once it is mounted. */
  readonly own: (destroy: () => void) => void;
}

/** The rail's code loads on demand, keeping it out of the eager MainPage chunk. */
export function mountServerRail(opts: ServerRailMount): void {
  const { host, slot } = opts;
  void import("./ServerRail")
    .then(({ createServerRail }) => {
      if (opts.isTornDown()) return;
      const rail = createServerRail({
        currentHost: host,
        loadServers: loadSavedServers,
        switchServer: switchToServer,
        addServer,
        onOpenDm: opts.onOpenDm,
        onShowServer: opts.onShowServer,
        joinInvite: (text) => {
          const invite = parseInviteInput(text);
          if (invite === null) return false;
          confirmAndJoinInvite(invite, currentServerName(host));
          return true;
        },
      });
      rail.mount(slot);
      opts.own(() => rail.destroy?.());
    })
    .catch((err: unknown) => log.warn("Server rail failed to load", err));
}
