//! One running Devot per user and data folder: a second launch of the binary (or the `devot`
//! command) hands its arguments to the running Devot through a socket and quits. The socket lives
//! in a folder only this user can open, named after the folder identifier, so another user's file
//! can never take the arguments and a debug build never meets the release app.
//! The message is `cwd\0\0argv joined by \0`.

use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Wry};

use crate::atomic_file::effective_uid;

const MAX_MESSAGE: u64 = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

struct Listening(PathBuf);

fn user_temp_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Some(dir) = crate::native::macos::user_temp_dir() {
        return dir;
    }
    PathBuf::from("/tmp")
}

/// `base/devot-<uid>`, made if missing and kept at mode 0700; None when the name is not this
/// user's own folder.
fn private_folder(base: &Path, uid: u32) -> Option<PathBuf> {
    let dir = base.join(format!("devot-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(_) => return None,
    }
    let meta = std::fs::symlink_metadata(&dir).ok()?;
    if !meta.is_dir() || meta.uid() != uid {
        return None;
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).ok()?;
    }
    Some(dir)
}

fn socket_in(dir: &Path, identifier: &str) -> PathBuf {
    dir.join(format!("{identifier}.sock"))
}

pub(crate) fn socket(identifier: &str) -> Option<PathBuf> {
    let dir = private_folder(&user_temp_dir(), effective_uid());
    if dir.is_none() {
        log::warn!("W_SINGLE_INSTANCE_FOLDER_FOREIGN");
    }
    Some(socket_in(&dir?, identifier))
}

/// None at the socket's place, or a socket of this user: anything else is never written to.
fn socket_trusted(found: Option<(bool, u32)>, uid: u32) -> bool {
    found.is_none_or(|(is_socket, owner)| is_socket && owner == uid)
}

/// True once a running Devot took the message; false when none listens there.
pub(crate) fn send_to(socket: &Path, message: &[u8], uid: u32) -> Result<bool, &'static str> {
    let found = match std::fs::symlink_metadata(socket) {
        Ok(meta) => Some((meta.file_type().is_socket(), meta.uid())),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(_) => Some((false, u32::MAX)),
    };
    if !socket_trusted(found, uid) {
        log::warn!("W_SINGLE_INSTANCE_SOCKET_FOREIGN");
        return Ok(false);
    }
    match UnixStream::connect(socket) {
        Ok(mut stream) => stream
            .write_all(message)
            .map(|()| true)
            .map_err(|_| "E_CLI_HANDOFF_FAILED"),
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            Ok(false)
        }
        Err(_) => Err("E_CLI_HANDOFF_FAILED"),
    }
}

pub(crate) fn send(identifier: &str, message: &[u8]) -> Result<bool, &'static str> {
    match socket(identifier) {
        Some(socket) => send_to(&socket, message, effective_uid()),
        None => Ok(false),
    }
}

pub(crate) fn message(cwd: &Path, argv: &[String]) -> String {
    format!("{}\0\0{}", cwd.to_string_lossy(), argv.join("\0"))
}

fn read_message(mut stream: UnixStream) -> Option<(String, Vec<String>)> {
    // macOS refuses the option once the sender has closed, which is when no timeout is needed.
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let mut text = String::new();
    (&mut stream)
        .take(MAX_MESSAGE)
        .read_to_string(&mut text)
        .ok()?;
    let (cwd, args) = text.split_once("\0\0")?;
    Some((cwd.to_owned(), args.split('\0').map(String::from).collect()))
}

fn listen(app: &AppHandle, socket: PathBuf) -> std::io::Result<()> {
    match std::fs::remove_file(&socket) {
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(&socket)?;
    app.manage(Listening(socket));
    let app = app.clone();
    std::thread::Builder::new()
        .name("devot-single-instance".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Some((cwd, args)) = read_message(stream) {
                    crate::deep_link::on_second_instance(&app, args, cwd);
                }
            }
        })
        .map(drop)
}

/// Runs first, so a second launch exits (status 0, no alert) before it opens the data folder.
/// When it cannot listen, the data-folder lock still keeps a second Devot out.
pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("devot-single-instance")
        .setup(|app, _| {
            let identifier = app.config().identifier.clone();
            let argv: Vec<String> = std::env::args_os()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            match send(&identifier, message(&cwd, &argv).as_bytes()) {
                Ok(true) => std::process::exit(0),
                Ok(false) => match socket(&identifier) {
                    Some(socket) => {
                        if listen(app, socket).is_err() {
                            log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED");
                        }
                    }
                    None => log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED"),
                },
                Err(code) => log::warn!("W_SINGLE_INSTANCE_SEND_FAILED {code}"),
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event
                && let Some(listening) = app.try_state::<Listening>()
            {
                let _ = std::fs::remove_file(&listening.0);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_socket_in_a_folder_of_this_users_own() {
        let base = tempfile::tempdir().unwrap();
        let uid = effective_uid();
        let dir = private_folder(base.path(), uid).unwrap();
        let meta = std::fs::metadata(&dir).unwrap();
        assert_eq!((meta.mode() & 0o777, meta.uid()), (0o700, uid));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(private_folder(base.path(), uid), Some(dir.clone()));
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(private_folder(base.path(), uid + 1), None);
        let other = tempfile::tempdir().unwrap();
        std::fs::remove_dir(&dir).unwrap();
        std::os::unix::fs::symlink(other.path(), &dir).unwrap();
        assert_eq!(private_folder(base.path(), uid), None);
        assert_eq!(
            socket_in(Path::new("/d"), "io.github.jma49.devot.dev"),
            PathBuf::from("/d/io.github.jma49.devot.dev.sock")
        );
    }

    #[test]
    fn trusts_no_socket_or_one_of_this_users_only() {
        assert!(socket_trusted(None, 501));
        assert!(socket_trusted(Some((true, 501)), 501));
        assert!(!socket_trusted(Some((true, 502)), 501));
        assert!(!socket_trusted(Some((false, 501)), 501));
    }

    #[test]
    fn hands_a_message_to_the_listener_and_nothing_to_a_foreign_file() {
        let dir = tempfile::tempdir().unwrap();
        let uid = effective_uid();
        let socket = dir.path().join("a.sock");
        assert_eq!(send_to(&socket, b"x", uid), Ok(false));
        let listener = UnixListener::bind(&socket).unwrap();
        let sent = message(Path::new("/w"), &["devot".into(), "a.md".into()]);
        assert_eq!(send_to(&socket, sent.as_bytes(), uid), Ok(true));
        let (stream, _) = listener.accept().unwrap();
        assert_eq!(
            read_message(stream),
            Some(("/w".into(), vec!["devot".into(), "a.md".into()]))
        );
        drop(listener);
        assert_eq!(send_to(&socket, b"x", uid), Ok(false));
        assert_eq!(send_to(&socket, b"x", uid + 1), Ok(false));
        let planted = dir.path().join("b.sock");
        std::fs::write(&planted, b"").unwrap();
        assert_eq!(send_to(&planted, b"x", uid), Ok(false));
        assert_eq!(std::fs::read(&planted).unwrap(), b"");
    }
}
