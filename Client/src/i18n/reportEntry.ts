import { defineCatalog } from "./format";

/**
 * The report entry points' labels. Apart from the reports catalog so
 * the message row and profile popup do not pull the whole form's copy into the
 * main bundle; the form loads on first use.
 */
export const reportEntryText = defineCatalog("reportEntry", {
  report: "Report",
  safetyLoadFailed: "Couldn't load your reports. Close Settings and try again.",
  dmPrivacyLoadFailed: "Couldn't load your direct message settings. Close Settings and try again.",
  blockedLoadFailed: "Couldn't load your blocked users. Close Settings and try again.",
  reportLoadFailed: "Couldn't open the report form. Try again.",
  profileLoadFailed: "Couldn't open the profile. Try again.",
});
