import { defineCatalog } from "./format";

/** The profile card and the Settings > Advanced > Activity music section (WP 8.10). */
export const listeningDetailsText = defineCatalog("listeningDetails", {
  "by.artist": "by {artist}",
  "progress.text": "{elapsed} / {total}",
  "progress.aria": "{elapsed} of {total}",
  "settings.share.label": "Share the music you're listening to",
  "settings.share.desc":
    "Show other members the song you are listening to. While this is on, OwnCord asks this computer which media player is playing and sends only the song's title, artist and player name. While it is off, nothing is checked or sent.",
  "settings.detected": "Detected now: {title} on {player}",
  "settings.detectedNone": "No music detected",
  "settings.serverOff": "Music activity is turned off on this server.",
  "players.title": "Your players",
  "players.desc":
    "The media players seen on this computer. Turn Show to others off to never show songs from a player. Web browsers are never shown. These choices stay on this computer.",
  "players.empty": "No players yet. A player shows up here once it has played a song.",
  "players.show.aria": "Show {player} to others",
  "players.show.label": "Show to others",
});
