//! Finds the running Devot, or starts it in the background when the owner allows that (ADR 0012).
//! Only a tool call comes here: a client that merely starts its MCP servers starts nothing.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::http_api::mcp_access::{self, McpAccess};
use crate::http_api::rendezvous::Rendezvous;

/// A first launch can wait on the system checking the app; a client usually allows a minute.
const START_WAIT: Duration = Duration::from_secs(20);
/// Devot is up but cannot be told apart from one with its port taken until this has passed.
const READY_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Found {
    /// A Devot holds this port and takes calls on it.
    Ready(u16),
    /// A Devot holds the data folder, and has not said it takes calls.
    Starting,
    NotRunning,
}

/// The port to call on: at once when Devot is ready, after a background start when that is allowed.
pub fn reach(
    access: impl FnOnce() -> McpAccess,
    mut find: impl FnMut() -> Found,
    launch: impl FnOnce() -> Result<(), &'static str>,
    start_wait: Duration,
    ready_wait: Duration,
) -> Result<u16, &'static str> {
    let first = find();
    if let Found::Ready(port) = first {
        return Ok(port);
    }
    let access = access();
    if !access.enabled {
        return Err("E_MCP_ACCESS_OFF");
    }
    let (wait, timeout) = match first {
        Found::Ready(port) => return Ok(port),
        Found::Starting => (ready_wait, "E_MCP_NOT_READY"),
        Found::NotRunning => {
            if !access.background_start {
                return Err("E_MCP_BACKGROUND_START_OFF");
            }
            launch()?;
            log::info!("I_MCP_BACKGROUND_START");
            (start_wait, "E_MCP_START_TIMEOUT")
        }
    };
    let until = Instant::now() + wait;
    while Instant::now() < until {
        std::thread::sleep(POLL.min(wait));
        if let Found::Ready(port) = find() {
            return Ok(port);
        }
    }
    Err(timeout)
}

/// This machine's Devot, as the data folder's lock and the rendezvous file say.
pub struct Live {
    identifier: String,
    data: PathBuf,
}

impl Live {
    pub fn new(identifier: &str, data: PathBuf) -> Self {
        Self {
            identifier: identifier.to_owned(),
            data,
        }
    }

    fn found(&self) -> Found {
        if !crate::startup::folder_held(&self.data) {
            return Found::NotRunning;
        }
        Rendezvous::for_identifier(&self.identifier)
            .and_then(|rendezvous| rendezvous.port())
            .map_or(Found::Starting, Found::Ready)
    }

    pub fn reach(&self) -> Result<u16, &'static str> {
        reach(
            || McpAccess::read(&self.data.join(mcp_access::FILE)),
            || self.found(),
            crate::cli::launch_in_background,
            START_WAIT,
            READY_WAIT,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_api::token::Scope;
    use std::cell::Cell;

    const SOON: Duration = Duration::from_millis(400);

    fn access(enabled: bool, background_start: bool) -> McpAccess {
        McpAccess {
            enabled,
            scope: Scope::ReadWrite,
            background_start,
        }
    }

    fn never_launches() -> Result<(), &'static str> {
        panic!("must not start Devot")
    }

    #[test]
    fn a_ready_devot_is_called_without_reading_anything_else() {
        let port = reach(
            || panic!("needs no settings"),
            || Found::Ready(40_000),
            never_launches,
            SOON,
            SOON,
        );
        assert_eq!(port, Ok(40_000));
    }

    #[test]
    fn starts_nothing_while_mcp_is_off() {
        for found in [Found::NotRunning, Found::Starting] {
            assert_eq!(
                reach(|| access(false, true), || found, never_launches, SOON, SOON),
                Err("E_MCP_ACCESS_OFF")
            );
        }
    }

    #[test]
    fn with_the_switch_off_answers_a_code_and_does_not_start_devot() {
        assert_eq!(
            reach(
                || access(true, false),
                || Found::NotRunning,
                never_launches,
                SOON,
                SOON
            ),
            Err("E_MCP_BACKGROUND_START_OFF")
        );
    }

    #[test]
    fn starts_devot_once_and_answers_when_it_is_ready() {
        let launched = Cell::new(0);
        let asked = Cell::new(0);
        let port = reach(
            || access(true, true),
            || {
                asked.set(asked.get() + 1);
                match asked.get() {
                    1 | 2 => Found::NotRunning,
                    3 => Found::Starting,
                    _ => Found::Ready(40_001),
                }
            },
            || {
                launched.set(launched.get() + 1);
                Ok(())
            },
            Duration::from_secs(5),
            SOON,
        );
        assert_eq!(port, Ok(40_001));
        assert_eq!(launched.get(), 1);
    }

    #[test]
    fn a_launch_that_fails_or_never_gets_ready_answers_a_code() {
        assert_eq!(
            reach(
                || access(true, true),
                || Found::NotRunning,
                || Err("E_MCP_START_FAILED"),
                SOON,
                SOON
            ),
            Err("E_MCP_START_FAILED")
        );
        assert_eq!(
            reach(
                || access(true, true),
                || Found::NotRunning,
                || Ok(()),
                SOON,
                SOON
            ),
            Err("E_MCP_START_TIMEOUT")
        );
    }

    #[test]
    fn a_devot_that_runs_but_never_takes_calls_is_not_started_again() {
        assert_eq!(
            reach(
                || access(true, true),
                || Found::Starting,
                never_launches,
                SOON,
                SOON
            ),
            Err("E_MCP_NOT_READY")
        );
    }
}
