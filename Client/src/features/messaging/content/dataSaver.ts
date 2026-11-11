import { loadPref } from "../../../lib/prefs/preferences";
import { desktop } from "../../../platform/desktop";

export type DataSaverPreference = "off" | "mobile" | "always";

export function dataSaverPreference(): DataSaverPreference {
  const pref = loadPref<string>("dataSaver", "off");
  return pref === "mobile" || pref === "always" ? pref : "off";
}

/** Read once when a media element is built. Existing placeholders keep their choice. */
export function dataSaverActive(): boolean {
  const pref = dataSaverPreference();
  return pref === "always" || (pref === "mobile" && desktop.meteredNetwork.isMetered());
}
