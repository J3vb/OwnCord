import { defineCatalog } from "./format";

/** The About settings tab and the "What's new" dialog shown after an update. */
export const whatsNewText = defineCatalog("whatsNew", {
  "about.appName": "OwnCord v{version}",
  "about.appNameUnknown": "OwnCord",
  "about.desktop": "Desktop app",
  "about.android": "Android app",
  "about.github": "OwnCord on GitHub",
  "about.notesFor": "What's new in {version}",
  "about.notesLabel": "Release notes",
  "about.history": "Version history",
  "about.historyEmpty": "No earlier versions are listed.",
  "about.notesMissing": "This build has no release notes. See the releases on GitHub.",
  "about.loadFailed": "Couldn't load the release notes. See the releases on GitHub.",
  "about.version": "Version {version}",
  "about.updateTitle": "Version {version} is available",
  "about.updateDesc": "You have {current}. The app restarts to finish the update.",
  "about.updateDescNoVersion": "The app restarts to finish the update.",
  "about.updateNotesFor": "What's coming in {version}",
  "about.updateNotesLabel": "Release notes for {version}",
  "about.updateNotesMissing": "See the release notes on GitHub.",
  "about.updateNow": "Update now",
  "dialog.updatedTo": "Updated to {version}",
  "dialog.title": "What's new in OwnCord",
  "dialog.history": "Version history",
  "dialog.close": "Got it",
  "dialog.closeLabel": "Close",
});
