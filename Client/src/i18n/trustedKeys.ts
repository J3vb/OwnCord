import { defineCatalog } from "./format";

/** The trusted keys panel (features/voice/trustedKeysPanel.ts). Its own
 *  catalog so the copy loads with that lazy module, not with the main page. */
export const trustedKeysText = defineCatalog("trustedKeys", {
  title: "Keys you trust for {name}",
  intro:
    "One key per device. Compare the safety number with {name}, in person or over another app, to confirm it is them.",
  keyInCall: "In this call",
  keyInCallChanged: "In this call · key changed, not yet confirmed",
  keyOlder: "Older key",
  forget: "Forget this key",
  forgetLabel: "Forget key {fingerprint}",
  footnote:
    "A device that comes back with a forgotten key shows as “Key changed, not yet confirmed” again. The key in this call can't be forgotten.",
  none: "No saved keys for {name} yet.",
  unavailable: "Couldn't read the saved keys. Try again.",
  forgetFailed: "Couldn't forget that key. Try again.",
  done: "Done",
});
