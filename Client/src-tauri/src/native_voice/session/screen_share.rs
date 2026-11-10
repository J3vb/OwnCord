//! Screen share for a [`NativeSession`]: starting and replacing the capture,
//! publishing its video and audio, quality changes and teardown.
use super::*;

impl NativeSession {
    /// Start capturing `target` for a screen share, replacing any capture
    /// already running. Returns the capture's id and a receiver that resolves
    /// with the first frame's size — on Wayland only once the user has
    /// completed the portal's dialog — or with why capture never began
    /// ([`screen::PORTAL_NOT_STARTED`] for a portal dialog that ended without
    /// one). The caller awaits it without holding the session, so a leave or
    /// a stop is never blocked behind the dialog: either drops the capture,
    /// which resolves it.
    pub async fn start_screen(
        &mut self,
        target: Target,
        options: CaptureOptions,
    ) -> Result<(u64, Started), String> {
        // The command released any running share before this; direct callers
        // get the old one closed before the new one opens.
        self.release_screen().await.release().await;
        self.next_capture += 1;
        let id = self.next_capture;
        let on_event = self.on_event.clone();
        let (capture, started) = ScreenCapture::start(target, options, move || {
            on_event(Event::ScreenCaptureEnded { capture: id })
        })?;
        self.frames.set_screen(Some(capture.preview()));
        self.screen = Some(ScreenShare { id, capture });
        Ok((id, started))
    }

    /// Publish capture `capture` as the screen share (replacing an earlier
    /// publish of it). E2EE covers it through the room's one key provider,
    /// exactly as the camera. Returns the publication's sid.
    pub async fn publish_screen(
        &mut self,
        capture: u64,
        opts: ScreenOptions,
    ) -> Result<String, String> {
        if !self.screen.as_ref().is_some_and(|s| s.id == capture) {
            return Err(format!("screen capture {capture} is not running"));
        }
        self.unpublish_screen().await;
        let source = NativeVideoSource::new(
            VideoResolution {
                width: opts.width,
                height: opts.height,
            },
            true,
        );
        let track = LocalVideoTrack::create_video_track(
            "screen_share",
            RtcVideoSource::Native(source.clone()),
        );
        let publication = self
            .room
            .local_participant()
            .publish_track(LocalTrack::Video(track), screen_publish_options(&opts))
            .await
            .map_err(|e| e.to_string())?;
        self.require_encrypted(&publication).await?;
        let sid = publication.sid();
        if let Some(screen) = &self.screen {
            screen.capture.set_source(Some(source));
        }
        let capture = self.screen.as_ref().map(|s| s.id);
        *lock(&self.screen_publication) = Some(VideoPublication::of_capture(sid.clone(), capture));
        Ok(sid.to_string())
    }

    /// Publish the other applications' sound as the screen share's audio,
    /// alongside running capture `capture` (replacing an earlier one). The
    /// capture (`share_audio.rs`) starts here and ends with the publication.
    /// Returns the publication's sid.
    pub async fn publish_screen_audio(
        &mut self,
        capture: u64,
    ) -> (Retired, Result<String, String>) {
        if !self.screen.as_ref().is_some_and(|s| s.id == capture) {
            return (
                Retired::default(),
                Err(format!("screen capture {capture} is not running")),
            );
        }
        let source = screen_audio_source();
        let app = self
            .screen
            .as_ref()
            .and_then(|s| screen::target_pid(s.capture.target()));
        let feed = ShareAudio::start(source.clone(), app);
        self.publish_screen_audio_from(capture, source, Some(feed))
            .await
    }

    /// As `publish_screen_audio`, but fed by the caller: the interop example's
    /// synthetic stereo tone (CI has no sound server).
    pub async fn publish_screen_audio_source(
        &mut self,
        capture: u64,
        source: NativeAudioSource,
    ) -> (Retired, Result<String, String>) {
        self.publish_screen_audio_from(capture, source, None).await
    }

    pub(super) async fn publish_screen_audio_from(
        &mut self,
        capture: u64,
        source: NativeAudioSource,
        feed: Option<ShareAudio>,
    ) -> (Retired, Result<String, String>) {
        let mut retired = Retired::default();
        let result = self
            .publish_screen_audio_into(capture, source, feed, &mut retired)
            .await;
        (retired, result)
    }

    pub(super) async fn publish_screen_audio_into(
        &mut self,
        capture: u64,
        source: NativeAudioSource,
        feed: Option<ShareAudio>,
        retired: &mut Retired,
    ) -> Result<String, String> {
        if !self.screen.as_ref().is_some_and(|s| s.id == capture) {
            retired.share_audio.extend(feed);
            return Err(format!("screen capture {capture} is not running"));
        }
        // Replace semantics. On any error below `feed` is retired, leaving the
        // slot empty and no capture thread behind.
        retired.merge(self.release_screen_audio().await);
        let track = LocalAudioTrack::create_audio_track(
            "screen_share_audio",
            RtcAudioSource::Native(source),
        );
        let published = self
            .room
            .local_participant()
            .publish_track(LocalTrack::Audio(track), screen_audio_publish_options())
            .await
            .map_err(|e| e.to_string());
        let publication = match published {
            Ok(publication) => publication,
            Err(e) => {
                retired.share_audio.extend(feed);
                return Err(e);
            }
        };
        if let Err(e) = self.require_encrypted(&publication).await {
            retired.share_audio.extend(feed);
            return Err(e);
        }
        let sid = publication.sid();
        *lock(&self.screen_audio) = Some(VideoPublication::of_capture(sid.clone(), Some(capture)));
        self.share_audio = feed;
        Ok(sid.to_string())
    }

    /// The opus codec the published screen-share audio `sid` was negotiated
    /// with, as the sender's stats report it: `(channels, sdp_fmtp_line)`.
    /// The interop example prints it to prove the publisher is stereo.
    pub async fn screen_audio_codec(&self, sid: &str) -> Result<(u32, String), String> {
        let publication = self
            .room
            .local_participant()
            .track_publications()
            .into_values()
            .find(|p| p.sid().as_str() == sid)
            .ok_or_else(|| format!("screen audio {sid} is not published"))?;
        let Some(LocalTrack::Audio(track)) = publication.track() else {
            return Err(format!("screen audio {sid} has no audio track"));
        };
        let stats = track
            .get_stats()
            .await
            .map_err(|e| format!("screen audio stats: {e}"))?;
        stats
            .into_iter()
            .find_map(|s| match s {
                RtcStats::Codec(c) if c.codec.mime_type.to_ascii_lowercase().contains("opus") => {
                    Some((c.codec.channels, c.codec.sdp_fmtp_line))
                }
                _ => None,
            })
            .ok_or_else(|| "screen audio stats carry no opus codec".to_string())
    }

    /// Unpublish screen audio `sid` if it is still the published one; a stale
    /// sid, one a later publish replaced, is a no-op.
    pub async fn unpublish_screen_audio(&mut self, sid: &str) -> Retired {
        let issued = lock(&self.screen_audio)
            .as_ref()
            .is_some_and(|a| a.issued == sid);
        if issued {
            self.release_screen_audio().await
        } else {
            Retired::default()
        }
    }

    /// Unpublish the screen audio and stop its capture thread (joined on
    /// drop). Called by `release_screen` (stop, close, a new share) and not by
    /// `unpublish_screen`, so a codec republish keeps the audio, as the web
    /// path does (screenShare.ts: "Screen audio stays published"); the
    /// interop example's `--republish-screen` and stop cover both.
    pub(super) async fn release_screen_audio(&mut self) -> Retired {
        let mut retired = Retired::default();
        let publication = lock(&self.screen_audio).take();
        retired.share_audio.extend(self.share_audio.take());
        if let Some(publication) = publication {
            if let Err(e) = self
                .room
                .local_participant()
                .unpublish_track(&publication.live)
                .await
            {
                log::warn!("[native_voice] screen audio unpublish: {e}");
            }
        }
        retired
    }

    /// Start capturing `target` to replace the published share's source,
    /// leaving the live capture and its publication running. Returns the
    /// new capture's id and its first-frame receiver, as `start_screen`;
    /// the caller awaits it without holding the session, then calls
    /// `finish_screen_change` (or `stop_screen` to give up).
    /// Take out the pending screen source change, if any, for the caller to
    /// release before it starts another.
    pub fn retire_screen_change(&mut self) -> Retired {
        let mut retired = Retired::default();
        retired.screens.extend(self.screen_change.take());
        retired
    }

    pub fn start_screen_change(
        &mut self,
        target: Target,
        options: CaptureOptions,
    ) -> (Retired, Result<(u64, Started), String>) {
        let mut retired = Retired::default();
        if !self.screen_published() {
            return (retired, Err("no published screen share to change".into()));
        }
        retired.screens.extend(self.screen_change.take());
        self.next_capture += 1;
        let id = self.next_capture;
        let on_event = self.on_event.clone();
        let started = ScreenCapture::start(target, options, move || {
            on_event(Event::ScreenCaptureEnded { capture: id })
        });
        match started {
            Ok((capture, started)) => {
                self.screen_change = Some(ScreenShare { id, capture });
                (retired, Ok((id, started)))
            }
            Err(e) => (retired, Err(e)),
        }
    }

    /// Move the published share onto capture `capture` (started by
    /// `start_screen_change`): same publication and sid, same preview socket,
    /// and the old capture is released. Fails, changing nothing, when a stop,
    /// a new share or another change came first.
    pub fn finish_screen_change(&mut self, capture: u64) -> (Retired, Result<(), String>) {
        let mut retired = Retired::default();
        let result = self.swap_screen(capture, &mut retired);
        (retired, result)
    }

    pub(super) fn swap_screen(
        &mut self,
        capture: u64,
        retired: &mut Retired,
    ) -> Result<(), String> {
        let next = self
            .screen_change
            .take_if(|c| c.id == capture)
            .ok_or("the screen source change was superseded")?;
        let Some(live) = self.screen.as_mut() else {
            retired.screens.push(next);
            return Err("the screen share stopped during the source change".into());
        };
        {
            // One guard for the published check and the write: a release
            // clearing the slot in between must not be written over.
            let mut slot = lock(&self.screen_publication);
            let Some(publication) = slot.as_mut().filter(|p| p.capture == Some(live.id)) else {
                retired.screens.push(next);
                return Err("the screen share stopped during the source change".into());
            };
            // The source keeps the size it was published at: the encoder follows
            // each frame's own size, but the layer sizes the server was told stay
            // (as on the web path's replaceTrack).
            next.capture.take_over(&live.capture);
            publication.capture = Some(next.id);
        }
        // Asked before the lock below: it is a round trip to the X server.
        let app = screen::target_pid(next.capture.target());
        {
            // The share audio follows the capture that is live, so a
            // withdrawal ends that one. A short lock of its own, taken after
            // the video slot's guard is released.
            let mut slot = lock(&self.screen_audio);
            if let Some(audio) = slot.as_mut().filter(|a| a.capture == Some(live.id)) {
                audio.capture = Some(next.id);
                // A window's share sound is that app's: follow the new source.
                if let Some(feed) = &self.share_audio {
                    feed.set_app(app);
                }
            }
        }
        // Releasing the old share joins its capture thread (and, on Wayland,
        // closes its portal session); the preview lives on in `next`.
        retired.screens.push(std::mem::replace(live, next));
        Ok(())
    }

    /// Change the live share's quality: re-size and re-pace the running
    /// capture, then publish it again with `publish` at the new size (the
    /// SDK cannot change a sender's encoding). One `&mut self` hold covers
    /// both steps, so a stop, source change or leave queued behind it runs
    /// after the new publication exists and releases it, and one that came
    /// first makes the gate refuse. Returns the new sid and the size.
    pub async fn set_screen_quality(
        &mut self,
        capture: u64,
        options: CaptureOptions,
        publish: ScreenOptions,
    ) -> Result<(String, u32, u32), QualityError> {
        quality_gate(
            self.screen.as_ref().map(|s| s.id),
            self.screen_published(),
            self.screen_change.is_some(),
            capture,
        )?;
        let size = self
            .screen
            .as_ref()
            .and_then(|s| s.capture.set_options(options));
        let (width, height) = size.unwrap_or((publish.width, publish.height));
        let sid = self
            .publish_screen(
                capture,
                ScreenOptions {
                    width,
                    height,
                    ..publish
                },
            )
            .await
            .map_err(QualityError::Publish)?;
        Ok((sid, width, height))
    }

    /// Whether the running capture is the one published as the screen share.
    pub(super) fn screen_published(&self) -> bool {
        let live = self.screen.as_ref().map(|s| s.id);
        live.is_some()
            && lock(&self.screen_publication)
                .as_ref()
                .is_some_and(|p| p.capture == live)
    }

    /// Stop capture `capture` if it is still the running one (a stale id is
    /// a no-op): unpublish it, and release the capturer and, on Wayland, the
    /// portal session. A pending source change's capture is only dropped.
    pub async fn stop_screen(&mut self, capture: u64) -> Retired {
        let mut retired = Retired::default();
        if self.screen_change.as_ref().is_some_and(|s| s.id == capture) {
            retired.screens.extend(self.screen_change.take());
        }
        if self.screen.as_ref().is_some_and(|s| s.id == capture) {
            retired.merge(self.release_screen().await);
        }
        retired
    }

    /// Unpublish the screen share if `capture` is the running one, keeping the
    /// capture alive (a codec republish publishes it again). A stale id is a
    /// no-op.
    pub async fn unpublish_screen_keep_capture(&mut self, capture: u64) {
        if self.screen.as_ref().is_some_and(|s| s.id == capture) {
            self.unpublish_screen().await;
        }
    }

    pub(super) async fn unpublish_screen(&mut self) {
        if let Some(screen) = &self.screen {
            screen.capture.set_source(None);
        }
        let publication = lock(&self.screen_publication).take();
        if let Some(publication) = publication {
            if let Err(e) = self
                .room
                .local_participant()
                .unpublish_track(&publication.live)
                .await
            {
                log::warn!("[native_voice] screen unpublish: {e}");
            }
        }
    }

    pub async fn release_screen(&mut self) -> Retired {
        let mut retired = Retired::default();
        retired.screens.extend(self.screen_change.take());
        retired.merge(self.release_screen_audio().await);
        self.unpublish_screen().await;
        self.frames.set_screen(None);
        // Releasing joins the capture thread.
        retired.screens.extend(self.screen.take());
        retired
    }
}
