import { STORAGE_PREFIX, storedKeys } from "./preferences";

/** The screen layout key: the test harness seeds it alone, so it says
 *  nothing about an earlier install. */
const NOT_EVIDENCE = `${STORAGE_PREFIX}screenLayout`;

/** Whether this storage was used by an earlier launch. Read once, at
 *  startup, before anything writes. */
export function hasInstallEvidence(): boolean {
  return storedKeys().some((key) => key.startsWith("owncord:") && key !== NOT_EVIDENCE);
}
