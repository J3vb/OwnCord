import { defineCatalog } from "./format";

/** External-content consent copy (B9-8, Q3): the concealed item, the
 *  per-server choice, YouTube playback and the Text & Images reset. */
export const externalConsentText = defineCatalog("externalConsent", {
  "item.load": "Load external content from {host}",
  "dialog.title": "Load external content on this server?",
  "dialog.body":
    "Link previews and images are fetched from your computer, so the sites that message authors link to can see your IP address.",
  "dialog.auto": "Load automatically on this server",
  "dialog.ask": "Ask each time",
  "dialog.cancel": "Cancel",
  "gif.load": "Load GIFs from Klipy",
  "youtube.play": "Play on YouTube",
  "youtube.note": "Playing connects you to YouTube directly.",
  "youtube.frame": "YouTube video player",
  "reset.label": "Reset external content consent",
  "reset.desc": "Ask again before loading link previews and images on every server",
  "reset.button": "Reset",
  "reset.done": "Consent reset. Previews and images will ask again.",
});
