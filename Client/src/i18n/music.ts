import { defineCatalog } from "./format";

/**
 * Share music copy that only the lazy music modules read: the picker, the
 * reasons the button is off and the refusal notices. The always-loaded
 * labels (Share music, Stop music, the volume menu rows) stay in voice.ts.
 */
export const musicText = defineCatalog("music", {
  checking: "Checking whether this system can share music",
  "reason.browser": "Sharing music needs the desktop app",
  "reason.android": "Sharing music isn't available on Android",
  "reason.platform": "Sharing music isn't available on this system",
  "reason.windowsOld": "Sharing music needs Windows 10 version 2004 or newer",
  "reason.noSoundServer": "Sharing music needs a running PulseAudio or PipeWire sound server",
  "picker.title": "Share music",
  "picker.hint":
    "Pick the app whose sound you want to share. Only that app's sound goes out, not your microphone or other apps.",
  "picker.listLabel": "Apps with sound",
  "picker.appLabel": "Share {name}",
  "picker.playing": "Playing",
  "picker.quiet": "Not playing",
  "picker.loading": "Looking for apps with sound",
  "picker.empty": "No apps with sound found. Start your music player, then refresh.",
  "picker.loadFailed": "Couldn't list the apps with sound",
  "picker.refresh": "Refresh",
  "picker.cancel": "Cancel",
  "picker.share": "Share",
  failed: "Couldn't share this app's sound",
  notFound: "That app is no longer playing sound. Pick it again.",
  ended: "Music sharing stopped",
});
