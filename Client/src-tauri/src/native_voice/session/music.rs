//! The music share for a [`NativeSession`]: one application's sound as a
//! stereo track named `music`, in a slot of its own beside the screen share's
//! audio, so starting or stopping one never touches the other.
use super::*;

impl NativeSession {
    /// Publish application `app_id`'s sound as the music track, replacing a
    /// running one. The capture (`share_audio.rs`, filtered to the id and
    /// re-matched every poll) starts here and ends with the publication. The
    /// track is published as the screen-share-audio source, stereo, no DTX, at
    /// the music bitrate: the options of the screen share's own audio.
    /// Returns the publication's sid.
    pub async fn publish_music(&mut self, app_id: String) -> (Retired, Result<String, String>) {
        // Replace semantics. On any error below the new feed is retired,
        // leaving the slot empty and no capture thread behind.
        let mut retired = self.release_music().await;
        let source = screen_audio_source();
        let feed = ShareAudio::start_music(source.clone(), app_id);
        let track =
            LocalAudioTrack::create_audio_track(MUSIC_TRACK_NAME, RtcAudioSource::Native(source));
        let published = self
            .room
            .local_participant()
            .publish_track(LocalTrack::Audio(track), screen_audio_publish_options())
            .await
            .map_err(|e| e.to_string());
        let publication = match published {
            Ok(publication) => publication,
            Err(e) => {
                retired.share_audio.push(feed);
                return (retired, Err(e));
            }
        };
        if let Err(e) = self.require_encrypted(&publication).await {
            retired.share_audio.push(feed);
            return (retired, Err(e));
        }
        let sid = publication.sid();
        *lock(&self.music_audio) = Some(VideoPublication::new(sid.clone()));
        self.music_feed = Some(feed);
        (retired, Ok(sid.to_string()))
    }

    /// Unpublish the music track and hand back its capture thread (joined on
    /// release). Nothing published is a no-op.
    pub async fn release_music(&mut self) -> Retired {
        let mut retired = Retired::default();
        let publication = lock(&self.music_audio).take();
        retired.share_audio.extend(self.music_feed.take());
        if let Some(publication) = publication {
            if let Err(e) = self
                .room
                .local_participant()
                .unpublish_track(&publication.live)
                .await
            {
                log::warn!("[native_voice] music unpublish: {e}");
            }
        }
        retired
    }
}
