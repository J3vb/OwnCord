import { defineCatalog } from "./format";

/** External-content consent copy: the concealed item, the
 *  per-server choice, YouTube playback and the Text & Images reset. */
export const externalConsentText = defineCatalog("externalConsent", {
  "item.load": "Load external content from {host}",
  "dialog.title": "Load external content on this server?",
  "dialog.body":
    "This content is fetched from your computer, so the site it comes from can see your IP address. Link previews built by your server never need this.",
  "dialog.auto": "Load automatically on this server",
  "dialog.ask": "Ask each time",
  "dialog.cancel": "Cancel",
  "gif.load": "Load GIFs from Klipy",
  "youtube.play": "Play on YouTube",
  "youtube.note": "Playing connects you to YouTube directly.",
  "youtube.frame": "YouTube video player",
  "reset.label": "Reset external content consent",
  "reset.desc":
    "Ask again before your computer loads GIFs, and link previews and images on servers that do not build previews themselves",
  "reset.button": "Reset",
  "reset.done": "Consent reset. External content will ask again.",
});
