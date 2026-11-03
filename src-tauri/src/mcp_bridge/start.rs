//! Finds the running Devot, or starts it in the background when the owner allows that (ADR 0012).
//! Only a tool call comes here: a client that merely starts its MCP servers starts nothing.

use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::http_api::mcp_access::{self, McpAccess};

/// A first launch can wait on the system checking the app; a client usually allows a minute.
const START_WAIT: Duration = Duration::from_secs(20);
/// Devot is up and has not opened the bridge's socket yet (a main window is still loading).
const READY_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    /// A Devot holds the data folder and takes calls on this socket.
    Ready(PathBuf),
    /// A Devot holds the data folder and takes no calls yet (or no longer: it is quitting).
    Starting,
    NotRunning,
}

/// The socket to call on: at once when Devot is ready, after a background start when that is
/// allowed. A Devot that goes away while this waits (a quit) may be started, once.
pub fn reach(
    access: impl FnOnce() -> McpAccess,
    mut find: impl FnMut() -> Found,
    mut launch: impl FnMut() -> Result<(), &'static str>,
    start_wait: Duration,
    ready_wait: Duration,
) -> Result<PathBuf, &'static str> {
    let mut found = find();
    if let Found::Ready(socket) = found {
        return Ok(socket);
    }
    let access = access();
    if !access.enabled {
        return Err("E_MCP_ACCESS_OFF");
    }
    let mut launched = false;
    let mut until = Instant::now() + ready_wait;
    loop {
        match found {
            Found::Ready(socket) => return Ok(socket),
            Found::NotRunning if !launched => {
                if !access.background_start {
                    return Err("E_MCP_BACKGROUND_START_OFF");
                }
                launch()?;
                launched = true;
                until = Instant::now() + start_wait;
                log::info!("I_MCP_BACKGROUND_START");
            }
            _ => {}
        }
        if Instant::now() >= until {
            return Err(if launched {
                "E_MCP_START_TIMEOUT"
            } else {
                "E_MCP_NOT_READY"
            });
        }
        std::thread::sleep(POLL);
        found = find();
    }
}

/// A socket of this user at `path`; nothing else is ever written to.
fn ours(path: &Path, uid: u32) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|meta| meta.file_type().is_socket() && meta.uid() == uid)
}

/// Ready only when a Devot holds the data folder and something listens on a socket of this user. A
/// socket nobody listens on is what a Devot that died without its exit left (a crash, a kill), and
/// the Devot that now holds the folder has not opened its own yet: it is starting.
fn found_at(data: &Path, socket: &Path) -> Found {
    if !crate::startup::folder_held(data) {
        return Found::NotRunning;
    }
    if !ours(socket, crate::atomic_file::effective_uid()) {
        return Found::Starting;
    }
    match std::os::unix::net::UnixStream::connect(socket) {
        Ok(_) => Found::Ready(socket.to_owned()),
        Err(_) => Found::Starting,
    }
}

/// This machine's Devot, as the data folder's lock and the bridge's socket say.
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
        match crate::http_api::bridge_socket(&self.identifier) {
            Some(socket) => found_at(&self.data, &socket),
            None if crate::startup::folder_held(&self.data) => Found::Starting,
            None => Found::NotRunning,
        }
    }

    /// Bridges that start at once take turns, so only the first starts Devot: a second `open` of a
    /// Devot that is starting would reach it as a reopen, which shows its window.
    fn turn(&self) -> Option<std::fs::File> {
        let dir = crate::single_instance::private_dir()?;
        let lock = dir.join(format!("{}.mcp-start.lock", self.identifier));
        let file = crate::atomic_file::open_lock_file(&lock).ok()?;
        file.lock().ok()?;
        Some(file)
    }

    pub fn reach(&self) -> Result<PathBuf, &'static str> {
        if let Found::Ready(socket) = self.found() {
            return Ok(socket);
        }
        let _turn = self.turn();
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
            || Found::Ready("/s".into()),
            never_launches,
            SOON,
            SOON,
        );
        assert_eq!(port, Ok(PathBuf::from("/s")));
    }

    #[test]
    fn starts_nothing_while_mcp_is_off() {
        for found in [Found::NotRunning, Found::Starting] {
            assert_eq!(
                reach(
                    || access(false, true),
                    || found.clone(),
                    never_launches,
                    SOON,
                    SOON
                ),
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
                    _ => Found::Ready("/s1".into()),
                }
            },
            || {
                launched.set(launched.get() + 1);
                Ok(())
            },
            Duration::from_secs(5),
            SOON,
        );
        assert_eq!(port, Ok(PathBuf::from("/s1")));
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

    #[test]
    fn a_devot_that_quits_while_it_waits_is_started_again_once() {
        let asked = Cell::new(0);
        let launched = Cell::new(0);
        let found = reach(
            || access(true, true),
            || {
                asked.set(asked.get() + 1);
                match asked.get() {
                    1 | 2 => Found::Starting,
                    3 | 4 => Found::NotRunning,
                    _ => Found::Ready("/again".into()),
                }
            },
            || {
                launched.set(launched.get() + 1);
                Ok(())
            },
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert_eq!(found, Ok(PathBuf::from("/again")));
        assert_eq!(launched.get(), 1);
    }

    #[test]
    fn only_a_socket_of_this_user_counts() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("s.sock");
        let file = dir.path().join("f");
        std::fs::write(&file, b"").unwrap();
        let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let me = crate::atomic_file::effective_uid();
        assert!(ours(&socket, me));
        assert!(!ours(&socket, me.wrapping_add(1)));
        assert!(!ours(&file, me));
        assert!(!ours(&dir.path().join("none"), me));
    }

    #[test]
    fn a_socket_a_dead_devot_left_reads_as_starting_until_the_new_one_listens() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let socket = dir.path().join("mcp.sock");
        assert_eq!(found_at(&data, &socket), Found::NotRunning);
        drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
        assert!(socket.exists(), "the leftover of a Devot that died");
        assert_eq!(found_at(&data, &socket), Found::NotRunning);
        let _held = crate::startup::take_folder(&data).unwrap();
        assert_eq!(found_at(&data, &socket), Found::Starting);

        let ready = socket.clone();
        let binds = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            std::fs::remove_file(&ready).unwrap();
            std::os::unix::net::UnixListener::bind(&ready).unwrap()
        });
        let launched = Cell::new(0);
        let found = reach(
            || access(true, true),
            || found_at(&data, &socket),
            || {
                launched.set(launched.get() + 1);
                Ok(())
            },
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        let _listener = binds.join().unwrap();
        assert_eq!(found, Ok(socket.clone()));
        assert_eq!(
            launched.get(),
            0,
            "a Devot holds the folder: nothing to start"
        );
    }
}
