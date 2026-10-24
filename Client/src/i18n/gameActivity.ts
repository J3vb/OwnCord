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
  "settings.serverOff": "Game activity is turned off on this server.",
  "games.title": "Your games",
  "games.desc":
    "The games seen on this computer and the ones you added. Rename a game to show a different name, or turn Show to others off to never show it. These choices stay on this computer.",
  "games.empty":
    "No games yet. A game shows up here once it has been detected, or add one yourself.",
  "games.detectedAs": "Detected as {game}",
  "games.addedByYou": "Added by you",
  "games.show.aria": "Show {game} to others",
  "games.show.label": "Show to others",
  "games.rename.aria": "Rename {game}",
  "games.rename.input": "Name shown for {game}",
  "games.rename.hint":
    "Press Enter to save, Esc to cancel. Leave it blank to use the detected name.",
  "games.remove.aria": "Remove {game}",
  "add.button": "Add a game",
  "add.title": "Pick a running program",
  "add.desc":
    "These are the programs running on this computer now. The list stays on this computer.",
  "add.filter": "Filter programs",
  "add.loading": "Looking at running programs",
  "add.empty":
    "No programs found. Start the game first, then open this list again. Finding programs is not available on every computer.",
  "add.noMatch": "No program matches the filter.",
  "add.cancel": "Cancel",
  "add.name": "Name shown for {program}",
  "add.nameInvalid": "Enter a name of 1 to 128 characters.",
  "add.save": "Add game",
});
