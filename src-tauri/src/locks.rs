use std::panic::Location;
use std::sync::{Mutex, MutexGuard};

/// Takes a lock whose value stays sound when a holder panics, even after one did. The panic is
/// logged once, with the site that found it: the poison is cleared, so later takers do not log it
/// again. A lock whose value a panic could leave half-changed maps the poison to an error instead.
#[track_caller]
pub fn lock<T: ?Sized>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    let site = Location::caller();
    mutex.lock().unwrap_or_else(|poisoned| {
        log::warn!("W_LOCK_POISONED at={}:{}", site.file(), site.line());
        mutex.clear_poison();
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poisoned() -> Mutex<u32> {
        let mutex = Mutex::new(7);
        let _ = std::panic::catch_unwind(|| {
            let _held = mutex.lock().unwrap();
            panic!("poison");
        });
        assert!(mutex.is_poisoned());
        mutex
    }

    #[test]
    fn takes_a_lock_that_is_not_poisoned() {
        let mutex = Mutex::new(1);
        *lock(&mutex) += 1;
        assert_eq!(*lock(&mutex), 2);
    }

    #[test]
    fn takes_a_poisoned_lock_and_logs_it_once() {
        crate::test_log::capture();
        let mutex = poisoned();
        assert_eq!(*lock(&mutex), 7);
        assert!(!mutex.is_poisoned());
        assert_eq!(*lock(&mutex), 7);
        let logged = crate::test_log::lines()
            .into_iter()
            .filter(|line| line.contains("W_LOCK_POISONED at=src/locks.rs"))
            .count();
        assert_eq!(logged, 1);
    }
}
