// The announce, join/reconnect and leave flows of E2EEManager, built over one
// E2EEHost. One factory so the manager reaches them through a single module.
import { E2EEAnnounce } from "./e2eeAnnounce";
import { E2EELeave } from "./e2eeLeave";
import { E2EESetup } from "./e2eeSetup";
import type { E2EEHost } from "./e2eeHost";

export interface E2EEFlows {
  /** Announce verification and application, and the re-pin. See e2eeAnnounce.ts. */
  announce: E2EEAnnounce;
  /** The join and reconnect key exchange. See e2eeSetup.ts. */
  setup: E2EESetup;
  /** Participant departure: election and rekey. See e2eeLeave.ts. */
  leave: E2EELeave;
}

export function createE2EEFlows(host: E2EEHost): E2EEFlows {
  return {
    announce: new E2EEAnnounce(host),
    setup: new E2EESetup(host),
    leave: new E2EELeave(host),
  };
}
