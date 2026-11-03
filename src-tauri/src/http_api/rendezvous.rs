//! How the bridge finds the listener without trusting whoever holds the port (ADR 0012). Any local
//! user can bind 127.0.0.1:<port> while Devot is closed, and the bridge's first request carries its
//! token. So Devot says "I listen on this port" in a file in this user's private folder
//! (`single_instance`), once it holds the port and a main window can answer, and takes it back when
//! it stops. The bridge sends its token only when the file names a live process while the data
//! folder is locked: a port Devot holds cannot be held by anyone else.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const SUFFIX: &str = ".mcp-listener";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Listener {
    pid: u32,
    port: u16,
}

#[derive(Debug, Clone)]
pub struct Rendezvous {
    path: PathBuf,
}

impl Rendezvous {
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// In this user's private folder; none when that folder is another's.
    pub fn for_identifier(identifier: &str) -> Option<Self> {
        let dir = crate::single_instance::private_dir()?;
        Some(Self::at(dir.join(format!("{identifier}{SUFFIX}"))))
    }

    pub fn publish(&self, port: u16) -> Result<(), &'static str> {
        let listener = Listener {
            pid: std::process::id(),
            port,
        };
        let json = serde_json::to_vec(&listener).map_err(|_| "E_MCP_RENDEZVOUS_FAILED")?;
        crate::atomic_file::write_replacing(&self.path, &json)
            .map_err(|_| "E_MCP_RENDEZVOUS_FAILED")
    }

    pub fn withdraw(&self) {
        match std::fs::remove_file(&self.path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                log::warn!("W_MCP_RENDEZVOUS_REMOVE_FAILED");
            }
            _ => {}
        }
    }

    /// The port a live Devot says it holds; a file a dead one left names nothing.
    pub fn port(&self) -> Option<u16> {
        self.read_with(crate::atomic_file::process_alive)
    }

    fn read_with(&self, alive: impl Fn(u32) -> bool) -> Option<u16> {
        let bytes = std::fs::read(&self.path).ok()?;
        let listener: Listener = serde_json::from_slice(&bytes).ok()?;
        alive(listener.pid).then_some(listener.port)
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendezvous() -> (tempfile::TempDir, Rendezvous) {
        let dir = tempfile::tempdir().unwrap();
        let at = Rendezvous::at(dir.path().join("x.mcp-listener"));
        (dir, at)
    }

    #[test]
    fn names_the_port_only_after_it_is_published_and_until_it_is_withdrawn() {
        let (_dir, at) = rendezvous();
        assert_eq!(at.port(), None);
        at.publish(27_484).unwrap();
        assert_eq!(at.port(), Some(27_484));
        at.withdraw();
        assert_eq!(at.port(), None);
        at.withdraw();
    }

    #[test]
    fn a_file_a_dead_process_left_names_nothing() {
        let (_dir, at) = rendezvous();
        at.publish(27_484).unwrap();
        assert_eq!(at.read_with(|_| false), None);
        assert_eq!(at.read_with(|_| true), Some(27_484));
        std::fs::write(at.path(), r#"{"pid":999999999,"port":1}"#).unwrap();
        assert_eq!(at.port(), None);
    }

    #[test]
    fn a_damaged_file_names_nothing() {
        let (_dir, at) = rendezvous();
        for bad in ["", "{", r#"{"pid":1}"#, r#"{"pid":1,"port":70000}"#] {
            std::fs::write(at.path(), bad).unwrap();
            assert_eq!(at.read_with(|_| true), None, "{bad}");
        }
    }
}
