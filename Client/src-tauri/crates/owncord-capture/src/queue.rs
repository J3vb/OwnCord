use std::collections::VecDeque;
use std::num::NonZeroUsize;

/// Bounded ownership of frames; replacing an old frame releases its GPU texture.
pub struct LatestQueue<T> {
    frames: VecDeque<T>,
    capacity: usize,
    dropped: u64,
}

impl<T> LatestQueue<T> {
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self {
            frames: VecDeque::new(),
            capacity: capacity.get(),
            dropped: 0,
        }
    }
    pub fn push(&mut self, frame: T) {
        if self.frames.len() == self.capacity {
            self.frames.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        self.frames.push_back(frame);
    }
    pub fn take_latest(&mut self) -> Option<T> {
        let latest = self.frames.pop_back();
        self.dropped = self.dropped.saturating_add(self.frames.len() as u64);
        self.frames.clear();
        latest
    }
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
    pub fn len(&self) -> usize {
        self.frames.len()
    }
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn superseded_frames_release_their_resources() {
        use std::cell::Cell;
        use std::rc::Rc;
        struct Frame(Rc<Cell<usize>>);
        impl Drop for Frame {
            fn drop(&mut self) {
                self.0.set(self.0.get() + 1);
            }
        }
        let released = Rc::new(Cell::new(0));
        let mut queue = LatestQueue::new(NonZeroUsize::new(2).unwrap());
        for _ in 0..10 {
            queue.push(Frame(released.clone()));
        }
        assert_eq!(released.get(), 8);
        let latest = queue.take_latest();
        assert_eq!(released.get(), 9);
        drop(latest);
        assert_eq!(released.get(), 10);
    }

    #[test]
    fn slow_consumer_gets_freshest_frame_with_bounded_memory() {
        let mut queue = LatestQueue::new(NonZeroUsize::new(2).unwrap());
        for frame in 0..100 {
            queue.push(frame);
            assert!(queue.len() <= 2);
        }
        assert_eq!(queue.dropped(), 98);
        assert_eq!(queue.take_latest(), Some(99));
        assert_eq!(queue.dropped(), 99);
        assert!(queue.is_empty());
        assert_eq!(queue.take_latest(), None);
        queue.push(100);
        assert_eq!(queue.take_latest(), Some(100));
        assert_eq!(queue.dropped(), 99);
    }
}
