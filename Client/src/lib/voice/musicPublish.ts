// Publish options of the music track, apart from `musicTrack.ts` so the
// listener-side modules that only tell the two kinds of audio apart do not
// load the video presets.

import { Track, type TrackPublishOptions } from "livekit-client";
import { MUSIC_TRACK_NAME } from "./musicTrack";
import { SCREENSHARE_AUDIO_PUBLISH } from "./videoPresets";

/** The screen-share audio options (stereo, no DTX, the music preset) under the
 *  music name. */
export const MUSIC_PUBLISH: TrackPublishOptions = {
  ...SCREENSHARE_AUDIO_PUBLISH,
  name: MUSIC_TRACK_NAME,
  source: Track.Source.ScreenShareAudio,
};
