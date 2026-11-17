// What tells a music share apart from a screen share's sound. Both are
// published with the `ScreenShareAudio` source, so the track's name is the one
// signal: every place that treats stream audio has to ask `isMusicPublication`
// before it assumes a `ScreenShareAudio` track belongs to a screen share.

/** The track name a music share publishes under (and the Linux host's). */
export const MUSIC_TRACK_NAME = "music";

/** The slice of a publication this module reads. A native publication names
 *  its track the same way. */
export interface NamedPublication {
  readonly source: string;
  readonly trackName?: string;
}

/** Whether `publication` is a music share rather than a screen share's sound. */
export function isMusicPublication(publication: NamedPublication): boolean {
  return publication.source === "screen_share_audio" && publication.trackName === MUSIC_TRACK_NAME;
}

/** Whether `publication` is a screen share's sound (stream audio): the
 *  `ScreenShareAudio` source under any name but the music one. */
export function isStreamAudioPublication(publication: NamedPublication): boolean {
  return publication.source === "screen_share_audio" && publication.trackName !== MUSIC_TRACK_NAME;
}
