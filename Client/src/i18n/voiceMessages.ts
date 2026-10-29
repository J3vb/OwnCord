import { defineCatalog } from "./format";

/** Copy for voice messages: the composer's recorder and the player. */
export const voiceMessagesText = defineCatalog("voiceMessages", {
  "mic.label": "Record voice message",

  "bar.label": "Voice message",
  "bar.recording": "Recording",
  "bar.ready": "Ready to send",
  "bar.uploading": "Sending…",
  "bar.limit": "Reached the 5 minute limit — send it or discard it",
  "bar.discard": "Discard voice message",
  "bar.send": "Send voice message",
  "bar.retry": "Retry",

  "error.denied": "Microphone access was denied — allow it in your system settings and try again",
  "error.noDevice": "No microphone was found",
  "error.unsupported": "This device can't record audio",
  "error.failed": "Couldn't start recording",
  "error.suspended": "Audio capture is blocked on this device",
  "error.deviceLost": "The microphone was disconnected — the recording was discarded",
  "error.tooLarge": "This voice message is too long for this server's upload limit",
  "error.tooShort": "That recording was too short to send",
  "error.uploadFailed": "Couldn't send the voice message — check your connection and retry",
  "error.recordingFailed": "Recording failed",

  "player.group": "Voice message, {duration}",
  "player.play": "Play voice message",
  "player.pause": "Pause voice message",
  "player.loading": "Loading voice message",
  "player.seek": "Voice message position",
  "player.seekValue": "{elapsed} of {total}",
  "player.speed": "Playback speed {speed}",
  "player.speedValue": "{speed}x",
  "player.loadFailed": "Couldn't load this voice message",
});
