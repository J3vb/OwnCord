import { desktop } from "../../platform/desktop";

/** The version the host reports without a leading "v", or null when it gives
 *  none (a browser mock) or the call fails. */
export async function readAppVersion(): Promise<string | null> {
  try {
    const v = await desktop.appMetadata.getVersion();
    return typeof v === "string" && v !== "" ? v.replace(/^v/, "") : null;
  } catch {
    return null;
  }
}
