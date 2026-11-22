//! The settings tab's camera preview slot (`native_voice_start_camera_preview`).
//!
//! A preview start opens the device under the camera gate, then drops the gate
//! while it waits for the first frame, so a stop can end that wait. The capture
//! is parked here during the wait rather than held by the start alone: the
//! call camera, a newer preview start and the preview stop all take it out
//! (under the gate) and release it before they open the device, instead of
//! finding the device still busy.

use super::{camera, video, CameraPreviewStarted, Inner};

/// A camera preview outside any room: its own frame socket and a capture,
/// kept alive until stopped or replaced. The socket is dropped (and so closed)
/// with the preview; `Drop` holds it only for that side effect.
pub(super) struct Standalone {
    #[allow(dead_code)]
    pub(super) frames: video::FrameServer,
    pub(super) _capture: camera::CameraCapture,
}

/// The live preview and the start still waiting for its first frame. Generic
/// so the tests can hold plain values.
pub(super) struct Slot<T> {
    live: Option<T>,
    /// A start waiting for its first frame, under its generation. Its capture
    /// holds the device as much as the live one does.
    starting: Option<(u64, T)>,
    /// The latest start, so overlapping starts cannot leave an older capture
    /// owning the slot.
    generation: u64,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self {
            live: None,
            starting: None,
            generation: 0,
        }
    }
}

impl<T> Slot<T> {
    /// Begin a new start: its generation, and the older start it supersedes,
    /// for the caller to release before it opens the device.
    pub(super) fn begin(&mut self) -> (u64, Option<T>) {
        self.generation += 1;
        (self.generation, self.starting.take().map(|(_, v)| v))
    }

    /// Whether `generation` is still the latest start.
    pub(super) fn is_latest(&self, generation: u64) -> bool {
        self.generation == generation
    }

    /// Hold start `generation`'s capture while it waits for its first frame.
    /// A start already superseded gets its value back, to release.
    pub(super) fn park(&mut self, generation: u64, value: T) -> Option<T> {
        if !self.is_latest(generation) {
            return Some(value);
        }
        self.starting = Some((generation, value));
        None
    }

    /// Start `generation` got its first frame: its capture becomes the live
    /// preview. `Ok` carries the preview it replaced, to release; `Err` means
    /// the start was superseded and its capture was already taken out.
    pub(super) fn promote(&mut self, generation: u64) -> Result<Option<T>, ()> {
        match self.starting.take() {
            Some((g, value)) if g == generation => Ok(self.live.replace(value)),
            other => {
                self.starting = other;
                Err(())
            }
        }
    }

    /// Start `generation` failed: its capture, to release, or `None` when it
    /// was superseded and its capture was already taken out.
    pub(super) fn abandon(&mut self, generation: u64) -> Option<T> {
        match self.starting.take() {
            Some((g, value)) if g == generation => Some(value),
            other => {
                self.starting = other;
                None
            }
        }
    }

    /// The live preview, taken out (the call's camera shows instead).
    pub(super) fn take_live(&mut self) -> Option<T> {
        self.live.take()
    }

    /// Supersede any start and take out everything holding the device, the
    /// live preview and a start still waiting, for the caller to release.
    pub(super) fn clear(&mut self) -> (Option<T>, Option<T>) {
        self.generation += 1;
        (self.live.take(), self.starting.take().map(|(_, v)| v))
    }
}

/// The call camera's preview socket and frame size, as a preview start's
/// result.
pub(super) fn call_preview(
    (frames, (width, height)): (String, (u32, u32)),
) -> CameraPreviewStarted {
    CameraPreviewStarted {
        width,
        height,
        frames,
    }
}

/// A preview start whose capture another command took out: the call camera's
/// preview when that took the device, otherwise rejected.
pub(super) fn superseded(inner: &Inner) -> Result<CameraPreviewStarted, String> {
    inner
        .call_camera_preview()
        .map(call_preview)
        .ok_or_else(|| "camera preview superseded by a newer request".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_superseded_start_does_not_claim_the_slot() {
        let mut slot = Slot::default();
        let (older, _) = slot.begin();
        let (newer, _) = slot.begin();
        assert!(!slot.is_latest(older));
        assert!(slot.is_latest(newer));
        assert_eq!(slot.park(older, "older"), Some("older"));
        assert_eq!(slot.park(newer, "newer"), None);
        assert_eq!(slot.promote(older), Err(()));
        assert_eq!(slot.promote(newer), Ok(None));
        assert_eq!(slot.take_live(), Some("newer"));
    }

    /// The call camera turning on while the settings preview still waits for
    /// its first frame: the parked capture comes out with the live one, so
    /// the device is free before the call camera opens it.
    #[test]
    fn clearing_takes_out_a_start_still_waiting_for_its_first_frame() {
        let mut slot = Slot::default();
        let (first, _) = slot.begin();
        assert_eq!(slot.park(first, "first"), None);
        assert_eq!(slot.promote(first), Ok(None));
        let (second, _) = slot.begin();
        assert_eq!(slot.park(second, "second"), None);

        assert_eq!(slot.clear(), (Some("first"), Some("second")));
        assert!(!slot.is_latest(second));
        // The start then fails or gets its frame: either way it owns nothing.
        assert_eq!(slot.abandon(second), None);
        assert_eq!(slot.promote(second), Err(()));
        assert_eq!(slot.clear(), (None, None));
    }

    #[test]
    fn a_newer_start_takes_out_the_older_one_still_waiting() {
        let mut slot = Slot::default();
        let (older, _) = slot.begin();
        assert_eq!(slot.park(older, "older"), None);
        let (newer, superseded) = slot.begin();
        assert_eq!(superseded, Some("older"));
        assert_eq!(slot.abandon(older), None);
        assert_eq!(slot.park(newer, "newer"), None);
        // A late result of the older start leaves the newer one parked.
        assert_eq!(slot.promote(older), Err(()));
        assert_eq!(slot.abandon(newer), Some("newer"));
    }

    #[test]
    fn a_stop_supersedes_a_start_in_flight() {
        let mut slot = Slot::<&str>::default();
        let (generation, _) = slot.begin();
        assert_eq!(slot.clear(), (None, None));
        assert!(!slot.is_latest(generation));
        assert_eq!(slot.park(generation, "late"), Some("late"));
        let (replacement, _) = slot.begin();
        assert!(slot.is_latest(replacement));
    }
}
