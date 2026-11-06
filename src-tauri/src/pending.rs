//! Requests Rust hands to a window and waits on by ID, until the window answers or Rust gives up:
//! the HTTP API's calls, `devot append` and quick capture.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// As many requests are waiting as the registry holds.
    Busy,
    Failed,
}

/// What Rust knows of a request it gave up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GaveUp {
    /// No window took it, and none can now: it never runs.
    Unclaimed,
    /// A window claimed it (or answered it just now), so it may still land.
    MayLand,
}

enum Reply<T> {
    Blocking(SyncSender<T>),
    Async(oneshot::Sender<T>),
}

impl<T> Reply<T> {
    fn send(self, answer: T) -> bool {
        match self {
            Self::Blocking(reply) => reply.send(answer).is_ok(),
            Self::Async(reply) => reply.send(answer).is_ok(),
        }
    }
}

struct Waiting<T> {
    reply: Reply<T>,
    claimed: bool,
}

pub struct Pending<T> {
    next: AtomicU64,
    limit: usize,
    waiting: Mutex<HashMap<u64, Waiting<T>>>,
}

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Self::with_limit(usize::MAX)
    }
}

impl<T> Pending<T> {
    pub fn with_limit(limit: usize) -> Self {
        Self {
            next: AtomicU64::new(0),
            limit,
            waiting: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, reply: Reply<T>) -> Result<u64, Refused> {
        let mut waiting = self.waiting.lock().map_err(|_| Refused::Failed)?;
        if waiting.len() >= self.limit {
            return Err(Refused::Busy);
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        waiting.insert(
            id,
            Waiting {
                reply,
                claimed: false,
            },
        );
        Ok(id)
    }

    /// A new request's ID and where its answer comes, for a thread that blocks on it.
    pub fn wait(&self) -> Result<(u64, Receiver<T>), Refused> {
        let (reply, answer) = sync_channel(1);
        Ok((self.register(Reply::Blocking(reply))?, answer))
    }

    #[cfg_attr(mobile, allow(dead_code))]
    pub fn wait_async(&self) -> Result<(u64, oneshot::Receiver<T>), Refused> {
        let (reply, answer) = oneshot::channel();
        Ok((self.register(Reply::Async(reply))?, answer))
    }

    /// The window takes a request before it acts on it; false once Rust has given up on it.
    pub fn claim(&self, id: u64) -> bool {
        let mut waiting = crate::locks::lock(&self.waiting);
        waiting.get_mut(&id).map(|w| w.claimed = true).is_some()
    }

    /// False for an ID that is not waiting (answered already, given up, or never asked).
    pub fn answer(&self, id: u64, answer: T) -> bool {
        let waiting = crate::locks::lock(&self.waiting).remove(&id);
        waiting.is_some_and(|w| w.reply.send(answer))
    }

    pub fn forget(&self, id: u64) {
        crate::locks::lock(&self.waiting).remove(&id);
    }

    /// Stops waiting on `id`; a request already gone counts as one that may land, since its
    /// answer may be on its way.
    pub fn give_up(&self, id: u64) -> GaveUp {
        let waiting = crate::locks::lock(&self.waiting).remove(&id);
        match waiting {
            Some(w) if !w.claimed => GaveUp::Unclaimed,
            _ => GaveUp::MayLand,
        }
    }

    /// Whether any request is waiting; true when that cannot be told.
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn busy(&self) -> bool {
        !crate::locks::lock(&self.waiting).is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn numbers_requests_from_one_and_passes_each_answer_on_once() {
        let pending = Arc::new(Pending::<&str>::default());
        let (first, first_answer) = pending.wait().unwrap();
        let (second, second_answer) = pending.wait().unwrap();
        assert_eq!((first, second), (1, 2));
        let answering = Arc::clone(&pending);
        std::thread::spawn(move || assert!(answering.answer(second, "two")))
            .join()
            .unwrap();
        assert!(pending.answer(first, "one"));
        assert_eq!(first_answer.recv_timeout(Duration::from_secs(5)), Ok("one"));
        assert_eq!(
            second_answer.recv_timeout(Duration::from_secs(5)),
            Ok("two")
        );
        assert!(!pending.answer(first, "again"), "answered once");
        assert!(!pending.answer(99, "never"), "never asked");
        assert!(!pending.busy());
    }

    #[test]
    fn an_answer_still_reaches_its_waiter_after_a_panic_under_the_lock() {
        let pending = Pending::<u8>::default();
        let (id, answer) = pending.wait().unwrap();
        let _ = std::panic::catch_unwind(|| {
            let _held = pending.waiting.lock().unwrap();
            panic!("poison");
        });
        assert!(pending.claim(id));
        assert!(pending.answer(id, 9));
        assert_eq!(answer.recv(), Ok(9));
    }

    #[test]
    fn answers_an_async_waiter() {
        let pending = Pending::<u8>::default();
        let (id, answer) = pending.wait_async().unwrap();
        assert!(pending.busy());
        assert!(pending.answer(id, 7));
        assert_eq!(tauri::async_runtime::block_on(answer), Ok(7));
    }

    #[test]
    fn a_forgotten_request_takes_no_answer_or_claim() {
        let pending = Pending::<()>::default();
        let (id, _answer) = pending.wait().unwrap();
        pending.forget(id);
        assert!(!pending.answer(id, ()));
        assert!(!pending.claim(id));
        assert!(!pending.busy());
    }

    #[test]
    fn giving_up_tells_an_unclaimed_request_from_one_that_may_land() {
        let pending = Pending::<()>::default();
        let (unclaimed, _a) = pending.wait().unwrap();
        assert_eq!(pending.give_up(unclaimed), GaveUp::Unclaimed);
        assert!(!pending.claim(unclaimed), "the window must not act on it");

        let (claimed, _b) = pending.wait_async().unwrap();
        assert!(pending.claim(claimed));
        assert_eq!(pending.give_up(claimed), GaveUp::MayLand);
        assert!(!pending.answer(claimed, ()));

        let (answered, _c) = pending.wait().unwrap();
        assert!(pending.answer(answered, ()));
        assert_eq!(
            pending.give_up(answered),
            GaveUp::MayLand,
            "answered just now"
        );
        assert!(!pending.claim(99), "never asked");
    }

    #[test]
    fn holds_a_bounded_number_of_requests_and_makes_room_as_they_end() {
        let pending = Pending::<()>::with_limit(2);
        let (first, _a) = pending.wait().unwrap();
        let _b = pending.wait().unwrap();
        assert_eq!(pending.wait().unwrap_err(), Refused::Busy);
        assert_eq!(pending.wait_async().unwrap_err(), Refused::Busy);
        pending.forget(first);
        assert_eq!(
            pending.wait().unwrap().0,
            3,
            "a refused request takes no ID"
        );
    }
}
