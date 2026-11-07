use std::time::Duration;

/// A rational clock: late callers skip slots instead of accumulating work.
pub struct Pacer {
    fps: u32,
    next_slot: u64,
    missed: u64,
}

impl Pacer {
    pub fn new(fps: u32) -> Option<Self> {
        if fps == 0 || fps > 1000 {
            return None;
        }
        Some(Self {
            fps,
            next_slot: 0,
            missed: 0,
        })
    }

    pub fn poll(&mut self, elapsed: Duration) -> Option<u64> {
        let slot = (elapsed.as_nanos() * u128::from(self.fps) / 1_000_000_000)
            .min(u128::from(u64::MAX - 1)) as u64;
        if slot < self.next_slot {
            return None;
        }
        self.missed = self.missed.saturating_add(slot - self.next_slot);
        self.next_slot = slot + 1;
        Some(slot)
    }

    pub fn missed(&self) -> u64 {
        self.missed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_consumer_skips_deadlines_without_bursting() {
        let mut pacer = Pacer::new(60).unwrap();
        assert_eq!(pacer.poll(Duration::ZERO), Some(0));
        assert_eq!(pacer.poll(Duration::from_millis(5)), None);
        assert_eq!(pacer.poll(Duration::from_millis(100)), Some(6));
        assert_eq!(pacer.missed(), 5);
        assert_eq!(pacer.poll(Duration::from_millis(100)), None);
        assert_eq!(pacer.poll(Duration::from_nanos(116_666_667)), Some(7));
    }

    #[test]
    fn rational_clock_has_no_accumulated_sixty_hertz_drift() {
        let mut pacer = Pacer::new(60).unwrap();
        for slot in 0..=216_000_u64 {
            let nanos = (u128::from(slot) * 1_000_000_000).div_ceil(60) as u64;
            assert_eq!(pacer.poll(Duration::from_nanos(nanos)), Some(slot));
            assert_eq!(pacer.poll(Duration::from_nanos(nanos)), None);
        }
        assert_eq!(pacer.missed(), 0);
        assert!(Pacer::new(0).is_none());
    }
}
