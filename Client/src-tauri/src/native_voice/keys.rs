//! The room key ring: the key sent with, a key staged in the other slot, and
//! wiping both on leave.
use super::{session, Inner};

pub(super) fn wipe(key: &mut Option<Vec<u8>>) {
    if let Some(mut k) = key.take() {
        k.iter_mut().for_each(|b| *b = 0);
    }
}

impl Inner {
    /// Record a room key: staged in `slot` (received with only) or sent
    /// with at once. Staging into the slot being sent on replaces the sending
    /// key, so that is a send-at-once.
    pub(super) fn install_key(&mut self, material: Vec<u8>, slot: i32, stage: bool) -> bool {
        let stage = stage && self.key.is_some() && slot != self.key_slot;
        if stage {
            if let Some((_, mut old)) = self.staged.take() {
                old.iter_mut().for_each(|b| *b = 0);
            }
            self.staged = Some((slot, material));
        } else {
            if matches!(&self.staged, Some((s, _)) if *s == slot) {
                let mut old = self.staged.take();
                if let Some((_, k)) = old.as_mut() {
                    k.iter_mut().for_each(|b| *b = 0);
                }
            }
            wipe(&mut self.key);
            self.key = Some(material);
            self.key_slot = slot;
        }
        stage
    }

    /// Send with the key staged in `slot`. The key sent with until now stays
    /// in its own slot, staged, for frames still in flight. False when nothing
    /// is staged there.
    pub(super) fn use_key_slot(&mut self, slot: i32) -> bool {
        if slot == self.key_slot && self.key.is_some() {
            return true;
        }
        match self.staged.take() {
            Some((s, material)) if s == slot => {
                let previous = self.key.replace(material);
                if let Some(prev) = previous {
                    self.staged = Some((self.key_slot, prev));
                }
                self.key_slot = slot;
                true
            }
            other => {
                self.staged = other;
                false
            }
        }
    }

    /// Forget every key (leave).
    pub(super) fn clear_keys(&mut self) {
        wipe(&mut self.key);
        if let Some((_, mut k)) = self.staged.take() {
            k.iter_mut().for_each(|b| *b = 0);
        }
        self.key_slot = session::KEY_INDEX;
    }
}
