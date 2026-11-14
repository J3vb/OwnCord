// Keeps the rail's cached server icon for a host in step with the hash its
// `server-info` reports. Loaded lazily by serverHealth.ts.

import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import type { SessionScope } from "@lib/net/sessionScope";
import { pngDataUrl, syncServerIcon } from "@lib/prefs/serverIcons";
import type { ServerInfoResponse } from "@lib/types";

const log = createLogger("main");

/**
 * A changed hash is refetched through the client's pinned HTTP path, an empty
 * one drops the entry. Best effort: the rail shows initials until a picture is
 * cached.
 */
export async function refreshServerIcon(
  api: ApiClient,
  host: string,
  info: ServerInfoResponse,
  owner: SessionScope,
): Promise<void> {
  try {
    await syncServerIcon(host, info.icon, async () => {
      const bytes = await api.getServerIconBytes(host, 5000, owner.signal);
      return bytes === null ? null : pngDataUrl(new Uint8Array(bytes));
    });
  } catch (err) {
    log.debug("server icon refresh failed", { host, error: String(err) });
  }
}
