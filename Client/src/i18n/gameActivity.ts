import { defineCatalog } from "./format";

/** The "Playing <game>" lines (WP 8.3): member row, DM row, profile card and
 *  the Settings > Advanced > Activity section. */
export const gameActivityText = defineCatalog("gameActivity", {
  playing: "Playing {game}",
  "playing.justStarted": "Playing {game} · just started",
  "playing.minutes": {
    one: "Playing {game} · for {count} min",
    other: "Playing {game} · for {count} min",
  },
  "playing.hours": "Playing {game} · for {hours} h",
  "playing.hoursMinutes": "Playing {game} · for {hours} h {minutes} min",
  "icon.label": "Game",
  "settings.title": "Activity",
  "settings.share.label": "Share the game you are playing",
  "settings.share.desc":
    "Show other members which game you are playing. While this is on, OwnCord checks the programs running on this computer for a known game and sends only the game's name. While it is off, nothing is checked or sent.",
  "settings.detected": "Detected now: {game}",
  "settings.detectedNone": "No game detected",
});
