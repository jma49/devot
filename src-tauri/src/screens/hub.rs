use std::cell::Cell;
use std::collections::{BTreeMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use serde_json::Value;

use super::direct;
use super::message::{self, Asked, FromPage, Reply};

/// Requests Swift waits on at once, the page's queue included; far above what one screen asks.
const MAX_WAITING: usize = 1024;
const INTERNAL: &str = "E_SCREENS_INTERNAL";

/// What `screens_take` answers: whether the screens attached, and the requests that came before
/// the page listened, oldest first.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Taken {
    pub installed: bool,
    pub pending: Vec<Value>,
}

/// Where Swift's request goes. `R` is how its reply reaches Swift: its callback on the phone.
#[derive(Debug, PartialEq)]
pub enum Called<R> {
    /// Refused at once.
    Answer(R, Vec<u8>),
    /// For the page now, as the `devot://screens` event.
    Forward(Value),
    /// Held until the page takes it.
    Queued,
    /// For Rust to answer, page or none.
    Direct(R, direct::Asked),
}

#[derive(Debug, PartialEq)]
pub enum Posted<R> {
    /// For the waiting call, with its request number.
    Reply(R, u64, Vec<u8>),
    Notice(Vec<u8>),
    /// A reply no request waits for: late, repeated, or never asked.
    Unmatched(u64),
}

struct Waiting<R> {
    reply: R,
    forwarded: bool,
}

struct State<R> {
    installed: bool,
    listening: bool,
    pending: VecDeque<Value>,
    waiting: BTreeMap<u64, Waiting<R>>,
}

/// The bridge's state between Swift and the page, kept apart from the C calls so it is tested
/// off the phone. A request is waited on by its ID from the moment it arrives; the page's reply
/// is matched to a request already handed to the page, and any other reply is dropped.
pub struct Hub<R> {
    state: Mutex<State<R>>,
}

fn encoded(reply: &Reply) -> Vec<u8> {
    serde_json::to_vec(&reply.to_value()).unwrap_or_default()
}

impl<R: Copy> Hub<R> {
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(State {
                installed: false,
                listening: false,
                pending: VecDeque::new(),
                waiting: BTreeMap::new(),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State<R>> {
        crate::locks::lock(&self.state)
    }

    pub fn set_installed(&self, installed: bool) {
        self.state().installed = installed;
    }

    pub fn installed(&self) -> bool {
        self.state().installed
    }

    pub fn call(&self, request: u64, bytes: &[u8], reply: R) -> Called<R> {
        let refuse = |code: &str| {
            log::warn!("W_SCREENS_REQUEST_REFUSED id={request} code={code}");
            Called::Answer(reply, encoded(&Reply::refused(request, code)))
        };
        let asked = match message::from_swift(request, bytes) {
            Ok(asked) => asked,
            Err(code) => return refuse(code),
        };
        let mut state = self.state();
        if !state.installed {
            return refuse("E_SCREENS_NOT_INSTALLED");
        }
        let checked = match asked {
            Asked::Page(checked) => checked,
            Asked::Direct(asked) => return Called::Direct(reply, asked),
        };
        if state.waiting.contains_key(&checked.id) {
            return refuse("E_SCREENS_ID_IN_USE");
        }
        if state.waiting.len() >= MAX_WAITING {
            return refuse("E_SCREENS_BUSY");
        }
        let forwarded = state.listening;
        state
            .waiting
            .insert(checked.id, Waiting { reply, forwarded });
        if forwarded {
            Called::Forward(checked.to_value())
        } else {
            state.pending.push_back(checked.to_value());
            Called::Queued
        }
    }

    /// Swift's call, answered through `send` at most once: refused, forwarded (`forward` says
    /// whether the page was reached), queued, or handed to `direct`, which answers it itself. A
    /// panic on the way abandons the request, and Swift hears `E_SCREENS_INTERNAL` unless it was
    /// answered already.
    pub fn serve(
        &self,
        request: u64,
        bytes: impl FnOnce() -> Result<Vec<u8>, &'static str>,
        reply: R,
        send: impl Fn(R, u64, &[u8]),
        forward: impl FnOnce(Value) -> bool,
        direct: impl FnOnce(R, direct::Asked),
    ) {
        let answered = Cell::new(false);
        let answer = |reply: R, json: &[u8]| {
            answered.set(true);
            send(reply, request, json);
        };
        let caught = catch_unwind(AssertUnwindSafe(|| {
            let bytes = match bytes() {
                Ok(bytes) => bytes,
                Err(code) => {
                    log::warn!("W_SCREENS_REQUEST_REFUSED id={request} code={code}");
                    return answer(reply, &encoded(&Reply::refused(request, code)));
                }
            };
            match self.call(request, &bytes, reply) {
                Called::Answer(reply, json) => answer(reply, &json),
                Called::Forward(message) => {
                    if !forward(message)
                        && let Some((reply, json)) =
                            self.abandon(request, "E_SCREENS_PAGE_UNREACHABLE")
                    {
                        answer(reply, &json);
                    }
                }
                Called::Queued => {}
                Called::Direct(reply, asked) => {
                    direct(reply, asked);
                    answered.set(true);
                }
            }
        }));
        if caught.is_ok() {
            return;
        }
        log::error!("E_SCREENS_PANIC id={request}");
        if !answered.get() {
            let (reply, json) = self
                .abandon(request, INTERNAL)
                .unwrap_or_else(|| (reply, encoded(&Reply::refused(request, INTERNAL))));
            send(reply, request, &json);
        }
    }

    /// A forwarded request that never reached the page: Swift hears `code` instead.
    pub fn abandon(&self, id: u64, code: &str) -> Option<(R, Vec<u8>)> {
        let waiting = self.state().waiting.remove(&id)?;
        log::warn!("W_SCREENS_REQUEST_ABANDONED id={id} code={code}");
        Some((waiting.reply, encoded(&Reply::refused(id, code))))
    }

    /// The page listens from now on and takes what came before; without the screens it takes
    /// nothing and is never sent anything.
    pub fn take(&self) -> Taken {
        let mut state = self.state();
        if !state.installed {
            return Taken {
                installed: false,
                pending: Vec::new(),
            };
        }
        state.listening = true;
        for waiting in state.waiting.values_mut() {
            waiting.forwarded = true;
        }
        Taken {
            installed: true,
            pending: state.pending.drain(..).collect(),
        }
    }

    /// The page loads again: what it was handed is lost with it, so those requests are answered
    /// `E_SCREENS_PAGE_RELOADED`, and the rest wait for the new page to take them.
    pub fn page_started(&self) -> Vec<(R, u64, Vec<u8>)> {
        let mut state = self.state();
        state.listening = false;
        let lost: Vec<u64> = state
            .waiting
            .iter()
            .filter(|(_, waiting)| waiting.forwarded)
            .map(|(id, _)| *id)
            .collect();
        if !lost.is_empty() {
            log::warn!("W_SCREENS_PAGE_RELOADED lost={}", lost.len());
        }
        lost.into_iter()
            .filter_map(|id| {
                let waiting = state.waiting.remove(&id)?;
                let json = encoded(&Reply::refused(id, "E_SCREENS_PAGE_RELOADED"));
                Some((waiting.reply, id, json))
            })
            .collect()
    }

    pub fn post(&self, bytes: &[u8]) -> Result<Posted<R>, &'static str> {
        if !self.state().installed {
            return Err("E_SCREENS_NOT_INSTALLED");
        }
        match message::from_page(bytes)? {
            FromPage::Notice(notice) => Ok(Posted::Notice(
                serde_json::to_vec(&notice.to_value()).unwrap_or_default(),
            )),
            FromPage::Reply(reply) => {
                let mut state = self.state();
                match state.waiting.remove(&reply.id) {
                    Some(waiting) if waiting.forwarded => {
                        return Ok(Posted::Reply(waiting.reply, reply.id, encoded(&reply)));
                    }
                    Some(waiting) => {
                        state.waiting.insert(reply.id, waiting);
                    }
                    None => {}
                }
                Ok(Posted::Unmatched(reply.id))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOTE: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    fn bytes(value: Value) -> Vec<u8> {
        serde_json::to_vec(&value).unwrap()
    }

    fn ping(id: u64) -> Vec<u8> {
        bytes(json!({ "v": 1, "id": id, "op": "ping", "args": {} }))
    }

    fn ping_value(id: u64) -> Value {
        json!({ "v": 1, "id": id, "op": "ping", "args": {} })
    }

    fn ok(id: u64) -> Vec<u8> {
        bytes(json!({ "v": 1, "id": id, "ok": true, "result": {} }))
    }

    fn refusal(id: u64, code: &str) -> Vec<u8> {
        bytes(json!({ "v": 1, "id": id, "ok": false, "code": code }))
    }

    fn installed() -> Hub<char> {
        let hub = Hub::new();
        hub.set_installed(true);
        hub
    }

    #[test]
    fn holds_requests_until_the_page_takes_them_then_forwards_at_once() {
        let hub = installed();
        assert_eq!(hub.call(1, &ping(1), 'a'), Called::Queued);
        assert_eq!(hub.call(2, &ping(2), 'b'), Called::Queued);
        assert_eq!(
            hub.take(),
            Taken {
                installed: true,
                pending: vec![ping_value(1), ping_value(2)],
            }
        );
        assert_eq!(hub.take().pending, Vec::<Value>::new());
        assert_eq!(hub.call(3, &ping(3), 'c'), Called::Forward(ping_value(3)));
    }

    #[test]
    fn hands_each_reply_to_the_call_that_waits_for_it_once() {
        let hub = installed();
        hub.take();
        hub.call(1, &ping(1), 'a');
        hub.call(2, &ping(2), 'b');
        assert_eq!(hub.post(&ok(2)), Ok(Posted::Reply('b', 2, ok(2))));
        assert_eq!(hub.post(&ok(2)), Ok(Posted::Unmatched(2)));
        assert_eq!(hub.post(&ok(9)), Ok(Posted::Unmatched(9)));
        assert_eq!(hub.post(&ok(1)), Ok(Posted::Reply('a', 1, ok(1))));
    }

    #[test]
    fn drops_a_reply_to_a_request_the_page_was_never_handed() {
        let hub = installed();
        hub.call(1, &ping(1), 'a');
        assert_eq!(hub.post(&ok(1)), Ok(Posted::Unmatched(1)));
        hub.take();
        assert_eq!(hub.post(&ok(1)), Ok(Posted::Reply('a', 1, ok(1))));
    }

    #[test]
    fn answers_a_refused_request_at_once_with_its_code() {
        let hub = installed();
        let unknown = bytes(json!({ "v": 1, "id": 4, "op": "note.explode", "args": {} }));
        assert_eq!(
            hub.call(4, &unknown, 'a'),
            Called::Answer('a', refusal(4, "E_SCREENS_OP_UNKNOWN"))
        );
        hub.call(5, &ping(5), 'b');
        assert_eq!(
            hub.call(5, &ping(5), 'c'),
            Called::Answer('c', refusal(5, "E_SCREENS_ID_IN_USE"))
        );
    }

    #[test]
    fn stops_taking_requests_past_its_limit() {
        let hub = installed();
        for id in 0..MAX_WAITING as u64 {
            assert_eq!(hub.call(id, &ping(id), 'a'), Called::Queued);
        }
        let over = MAX_WAITING as u64;
        assert_eq!(
            hub.call(over, &ping(over), 'b'),
            Called::Answer('b', refusal(over, "E_SCREENS_BUSY"))
        );
    }

    #[test]
    fn without_the_screens_the_page_takes_nothing_and_every_message_is_refused() {
        let hub: Hub<char> = Hub::new();
        hub.set_installed(false);
        assert_eq!(
            hub.call(1, &ping(1), 'a'),
            Called::Answer('a', refusal(1, "E_SCREENS_NOT_INSTALLED"))
        );
        assert_eq!(
            hub.take(),
            Taken {
                installed: false,
                pending: Vec::new(),
            }
        );
        assert_eq!(hub.post(&ok(1)), Err("E_SCREENS_NOT_INSTALLED"));
    }

    #[test]
    fn a_reloaded_page_loses_what_it_was_handed_and_takes_what_still_waits() {
        let hub = installed();
        hub.take();
        hub.call(1, &ping(1), 'a');
        assert_eq!(
            hub.page_started(),
            vec![('a', 1, refusal(1, "E_SCREENS_PAGE_RELOADED"))]
        );
        assert_eq!(hub.call(2, &ping(2), 'b'), Called::Queued);
        assert_eq!(hub.page_started(), Vec::new());
        assert_eq!(hub.take().pending, vec![ping_value(2)]);
        assert_eq!(hub.post(&ok(1)), Ok(Posted::Unmatched(1)));
    }

    #[test]
    fn an_abandoned_request_is_answered_once() {
        let hub = installed();
        hub.take();
        hub.call(1, &ping(1), 'a');
        assert_eq!(
            hub.abandon(1, "E_SCREENS_PAGE_UNREACHABLE"),
            Some(('a', refusal(1, "E_SCREENS_PAGE_UNREACHABLE")))
        );
        assert_eq!(hub.abandon(1, "E_SCREENS_PAGE_UNREACHABLE"), None);
        assert_eq!(hub.post(&ok(1)), Ok(Posted::Unmatched(1)));
    }

    fn served(
        hub: &Hub<char>,
        id: u64,
        forward: impl FnOnce(Value) -> bool,
    ) -> Vec<(char, u64, Vec<u8>)> {
        let sent = std::cell::RefCell::new(Vec::new());
        hub.serve(
            id,
            || Ok(ping(id)),
            'a',
            |reply, id, json: &[u8]| sent.borrow_mut().push((reply, id, json.to_vec())),
            forward,
            |_, asked| panic!("{} went to Rust", asked.name),
        );
        sent.into_inner()
    }

    #[test]
    fn serves_a_call_by_forwarding_it_or_answering_its_refusal() {
        let hub = installed();
        hub.take();
        let mut forwarded = Vec::new();
        assert_eq!(
            served(&hub, 1, |message| {
                forwarded.push(message);
                true
            }),
            Vec::new()
        );
        assert_eq!(forwarded, vec![ping_value(1)]);
        assert_eq!(
            served(&hub, 2, |_| false),
            vec![('a', 2, refusal(2, "E_SCREENS_PAGE_UNREACHABLE"))]
        );
        assert_eq!(
            served(&hub, 1, |_| true),
            vec![('a', 1, refusal(1, "E_SCREENS_ID_IN_USE"))]
        );
        let sent = std::cell::RefCell::new(Vec::new());
        hub.serve(
            3,
            || Err("E_SCREENS_MESSAGE_TOO_LARGE"),
            'b',
            |reply, id, json: &[u8]| sent.borrow_mut().push((reply, id, json.to_vec())),
            |_| true,
            |_, _| {},
        );
        assert_eq!(
            sent.into_inner(),
            vec![('b', 3, refusal(3, "E_SCREENS_MESSAGE_TOO_LARGE"))]
        );
    }

    #[test]
    fn a_panic_on_the_way_answers_the_call_once_and_frees_its_place() {
        let hub = installed();
        hub.take();
        assert_eq!(
            served(&hub, 7, |_| panic!("forward")),
            vec![('a', 7, refusal(7, "E_SCREENS_INTERNAL"))]
        );
        assert_eq!(hub.post(&ok(7)), Ok(Posted::Unmatched(7)));
        assert_eq!(served(&hub, 7, |_| true), Vec::new());

        let sent = std::cell::RefCell::new(Vec::new());
        hub.serve(
            8,
            || panic!("copy"),
            'b',
            |reply, id, json: &[u8]| sent.borrow_mut().push((reply, id, json.to_vec())),
            |_| true,
            |_, _| {},
        );
        assert_eq!(
            sent.into_inner(),
            vec![('b', 8, refusal(8, "E_SCREENS_INTERNAL"))]
        );

        let sent = std::cell::RefCell::new(Vec::new());
        hub.serve(
            9,
            || Err("E_SCREENS_MESSAGE_INVALID"),
            'c',
            |reply, id, json: &[u8]| {
                sent.borrow_mut().push((reply, id, json.to_vec()));
                panic!("send");
            },
            |_| true,
            |_, _| {},
        );
        assert_eq!(
            sent.into_inner(),
            vec![('c', 9, refusal(9, "E_SCREENS_MESSAGE_INVALID"))]
        );
    }

    #[test]
    fn passes_a_notice_on_and_refuses_a_bad_one() {
        let hub = installed();
        let changed = json!({ "v": 1, "notice": "notes.changed", "rev": 3, "ids": [NOTE] });
        assert_eq!(
            hub.post(&bytes(changed.clone())),
            Ok(Posted::Notice(bytes(changed)))
        );
        let bad = json!({ "v": 1, "notice": "notes.changed", "rev": 3, "ids": ["x"] });
        assert_eq!(hub.post(&bytes(bad)), Err("E_SCREENS_NOTE_ID_INVALID"));
    }

    fn licence_get(id: u64) -> Vec<u8> {
        bytes(json!({ "v": 1, "id": id, "op": "direct.licence.get", "args": {} }))
    }

    #[test]
    fn rust_answers_a_direct_request_itself_and_never_hands_it_to_the_page() {
        let hub = installed();
        match hub.call(1, &licence_get(1), 'a') {
            Called::Direct('a', asked) => {
                assert_eq!((asked.id, asked.name), (1, "direct.licence.get"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(hub.take().pending, Vec::<Value>::new());
        assert_eq!(hub.post(&ok(1)), Ok(Posted::Unmatched(1)));
        assert!(matches!(
            hub.call(1, &licence_get(1), 'b'),
            Called::Direct('b', _)
        ));
        assert_eq!(
            Hub::<char>::new().call(2, &licence_get(2), 'c'),
            Called::Answer('c', refusal(2, "E_SCREENS_NOT_INSTALLED"))
        );
    }

    #[test]
    fn serves_a_direct_request_through_its_runner_and_answers_a_panic_there() {
        let hub = installed();
        let ran = std::cell::RefCell::new(Vec::new());
        let sent = std::cell::RefCell::new(Vec::new());
        let send = |reply, id, json: &[u8]| sent.borrow_mut().push((reply, id, json.to_vec()));
        hub.serve(
            3,
            || Ok(licence_get(3)),
            'a',
            send,
            |_| panic!("forwarded"),
            |reply, asked| ran.borrow_mut().push((reply, asked.id)),
        );
        assert_eq!(ran.into_inner(), vec![('a', 3)]);
        assert!(sent.borrow().is_empty());
        hub.serve(
            4,
            || Ok(licence_get(4)),
            'b',
            send,
            |_| panic!("forwarded"),
            |_, _| panic!("run"),
        );
        assert_eq!(
            sent.into_inner(),
            vec![('b', 4, refusal(4, "E_SCREENS_INTERNAL"))]
        );
    }
}
