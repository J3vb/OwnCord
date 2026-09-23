import { defineCatalog } from "./format";

/** Settings copy. B9-3 moved the Accessibility tab here; B9-20 extends it with the other tabs. */
export const settingsText = defineCatalog("settings", {
  "tabs.safety": "Safety",
  "accessibility.reducedMotion.label": "Reduce Motion",
  "accessibility.reducedMotion.desc": "Disable animations and transitions",
  "accessibility.highContrast.label": "High Contrast",
  "accessibility.highContrast.desc": "Increase contrast for better readability",
  "accessibility.roleColors.label": "Role Colors",
  "accessibility.roleColors.desc": "Show colored usernames based on role in chat",
  "accessibility.syncOsMotion.label": "Sync with OS",
  "accessibility.syncOsMotion.desc":
    "Automatically enable reduced motion based on your OS accessibility settings",
  "accessibility.largeFont.label": "Large Font",
  "accessibility.largeFont.desc": "Use larger text throughout the app for better readability",
});
