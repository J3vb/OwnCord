//! The crate's one policy for `std::sync::Mutex`. `clippy.toml` bans
//! `Mutex::lock` everywhere else, so every lock goes through here.

use std::sync::{LockResult, Mutex, MutexGuard, PoisonError};

/// Lock `m`, taking the data back if a thread panicked while holding it.
///
/// A panic while a lock is held poisons it, and `lock().unwrap()` would then
/// panic on every later call. The guarded state here is a slot, a cache or a
/// handle that each writer leaves whole between statements, so carrying on
/// with it is safer than taking the rest of the app down with the first panic.
#[allow(clippy::disallowed_methods)]
pub(crate) fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Lock `m` and report a poisoned lock instead of reading through it. Only for
/// the few checks that must fail closed, such as reading the certificate a
/// TLS handshake captured.
#[allow(clippy::disallowed_methods)]
pub(crate) fn lock_checked<T: ?Sized>(m: &Mutex<T>) -> LockResult<MutexGuard<'_, T>> {
    m.lock()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn poisoned(value: Vec<u32>) -> Arc<Mutex<Vec<u32>>> {
        let m = Arc::new(Mutex::new(value));
        let held = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _guard = lock(&held);
            panic!("poison the lock on purpose");
        })
        .join();
        assert!(m.is_poisoned());
        m
    }

    #[test]
    fn a_poisoned_lock_hands_back_its_data() {
        let m = poisoned(vec![1, 2]);
        lock(&m).push(3);
        assert_eq!(*lock(&m), [1, 2, 3]);
    }

    #[test]
    fn the_checked_lock_reports_a_poisoned_lock() {
        let m = poisoned(vec![1]);
        assert!(lock_checked(&m).is_err());
        assert!(lock_checked(&Mutex::new(0)).is_ok());
    }
}
