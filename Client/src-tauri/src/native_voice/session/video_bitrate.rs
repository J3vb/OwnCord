//! Holding a published camera or share under a bitrate cap without
//! republishing it. The rule is the web path's (`lib/voice/senderLayers.ts`):
//! the top layer runs at the cap and every lower layer at the lower of its own
//! rate and that top. The vendored SDK reads and writes the sender's encodings
//! in place (`LocalVideoTrack::set_sender_max_bitrates`), so viewers keep the
//! same publication and see no keyframe.
use super::*;

/// Which published video a bitrate change is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoKind {
    Camera,
    Screen,
}

impl VideoKind {
    pub fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "camera" => Ok(Self::Camera),
            "screen" => Ok(Self::Screen),
            other => Err(format!("unsupported video kind {other}")),
        }
    }
}

/// The rate each layer carries under a top of `top` bits per second.
/// `original` is the layers' rates right after the publish, the full-size
/// layer last. The top layer takes `top`; every lower layer takes the lower of
/// its own rate and `top` (a layer with no rate of its own stays without one).
/// A `top` of 0 restores `original`.
pub(super) fn capped_layers(original: &[Option<u64>], top: u64) -> Vec<Option<u64>> {
    if top == 0 {
        return original.to_vec();
    }
    let last = original.len().saturating_sub(1);
    original
        .iter()
        .enumerate()
        .map(|(i, rate)| {
            if i == last {
                Some(top)
            } else {
                rate.map(|r| r.min(top))
            }
        })
        .collect()
}

impl NativeSession {
    fn video_slot(&self, kind: VideoKind) -> &VideoSlot {
        match kind {
            VideoKind::Camera => &self.camera,
            VideoKind::Screen => &self.screen_publication,
        }
    }

    /// Right after a publish: take the layers the SDK produced as the originals
    /// and hold them under `top`, the rate the publish asked for, so a lower
    /// layer never outruns the top one. A failure only logs: the publish worked.
    pub(super) fn hold_published_layers(
        &self,
        kind: VideoKind,
        live: &TrackSid,
        track: Option<LocalTrack>,
        top: u64,
    ) {
        let Some(LocalTrack::Video(track)) = track else {
            return;
        };
        let layers = track.sender_max_bitrates();
        if let Some(publication) = lock(self.video_slot(kind))
            .as_mut()
            .filter(|p| p.live == *live)
        {
            publication.original_layers = layers.clone();
        }
        if let Err(e) = track.set_sender_max_bitrates(&capped_layers(&layers, top)) {
            log::warn!("[native_voice] holding the published layers under the cap: {e}");
        }
    }

    /// Hold the live camera or share `sid` under `max_bitrate` bits per second,
    /// in place. A `sid` that is not the live publication (stopped, or replaced
    /// by a republish) is a no-op, so a late change never touches a newer one.
    /// A `max_bitrate` of 0 restores the rates the publish produced.
    pub fn set_video_bitrate(
        &self,
        kind: VideoKind,
        sid: &str,
        max_bitrate: u64,
    ) -> Result<(), String> {
        let slot = self.video_slot(kind);
        // The slot is locked alone and only to read; the SDK call below runs
        // after the guard is gone.
        let (live, recorded) = match lock(slot).as_ref().filter(|p| p.issued == sid) {
            Some(p) => (p.live.clone(), p.original_layers.clone()),
            None => return Ok(()),
        };
        let publications = self.room.local_participant().track_publications();
        let Some(LocalTrack::Video(track)) = publications.get(&live).and_then(|p| p.track()) else {
            return Ok(());
        };
        // A republish after a full reconnect starts the layers over: take what
        // the sender carries now as the originals.
        let original = if recorded.is_empty() {
            let layers = track.sender_max_bitrates();
            if let Some(p) = lock(slot).as_mut().filter(|p| p.live == live) {
                p.original_layers = layers.clone();
            }
            layers
        } else {
            recorded
        };
        track
            .set_sender_max_bitrates(&capped_layers(&original, max_bitrate))
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_top_layer_takes_the_cap_and_lower_layers_stay_under_it() {
        let original = [Some(450_000), Some(1_700_000), Some(4_000_000)];
        assert_eq!(
            capped_layers(&original, 1_000_000),
            vec![Some(450_000), Some(1_000_000), Some(1_000_000)]
        );
    }

    #[test]
    fn a_lower_layer_already_under_the_cap_keeps_its_own_rate() {
        let original = [Some(300_000), Some(2_000_000)];
        assert_eq!(
            capped_layers(&original, 5_000_000),
            vec![Some(300_000), Some(5_000_000)]
        );
    }

    #[test]
    fn a_single_layer_is_the_top() {
        assert_eq!(
            capped_layers(&[Some(8_000_000)], 600_000),
            vec![Some(600_000)]
        );
        assert_eq!(capped_layers(&[None], 600_000), vec![Some(600_000)]);
    }

    #[test]
    fn a_layer_without_a_rate_stays_without_one() {
        let original = [None, Some(1_200_000)];
        assert_eq!(capped_layers(&original, 700_000), vec![None, Some(700_000)]);
    }

    #[test]
    fn a_top_of_zero_restores_the_originals() {
        let original = [Some(450_000), None, Some(4_000_000)];
        assert_eq!(capped_layers(&original, 0), original.to_vec());
    }

    #[test]
    fn no_layers_stay_no_layers() {
        assert!(capped_layers(&[], 1_000_000).is_empty());
        assert!(capped_layers(&[], 0).is_empty());
    }

    #[test]
    fn a_video_kind_parses_the_two_names_the_webview_sends() {
        assert_eq!(VideoKind::parse("camera"), Ok(VideoKind::Camera));
        assert_eq!(VideoKind::parse("screen"), Ok(VideoKind::Screen));
        assert!(VideoKind::parse("audio").is_err());
    }
}
