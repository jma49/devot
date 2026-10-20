//! One running Devot per user and data folder: a second launch of the binary (or the `devot`
//! command) hands its arguments to the running Devot through a socket and quits. The socket lives
//! in a folder only this user can open, named after the folder identifier, so another user's file
//! can never take the arguments and a debug build never meets the release app.
//! The message is `cwd\0\0argv joined by \0`. The running Devot answers one byte once it has taken
//! the message, and takes none while it quits: only that answer completes a hand-off.
//! Only the process holding an exclusive `flock` on `<identifier>.lock` beside the socket (kept for
//! its life) removes or binds the socket, so of two launches at once, the one that goes on to fail
//! can never leave the other without a socket. A volume without locks goes without that guard.

use std::fs::{File, TryLockError};
use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Wry};

use crate::atomic_file::{effective_uid, open_lock_file};

const MAX_MESSAGE: u64 = 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
const TAKEN: u8 = 0x06;

struct Claimed {
    listener: UnixListener,
    socket: PathBuf,
    /// (device, inode): at exit only this socket is removed.
    bound: (u64, u64),
    lock: File,
}

struct Listening {
    socket: PathBuf,
    bound: (u64, u64),
    /// Let go at exit, so a Devot restarting into an update claims the socket at once.
    lock: Mutex<Option<File>>,
}

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

fn lock_in(dir: &Path, identifier: &str) -> PathBuf {
    dir.join(format!("{identifier}.lock"))
}

fn folder() -> Option<PathBuf> {
    let dir = private_folder(&user_temp_dir(), effective_uid());
    if dir.is_none() {
        log::warn!("W_SINGLE_INSTANCE_FOLDER_FOREIGN");
    }
    dir
}

/// None at the socket's place, or a socket of this user: anything else is never written to.
fn socket_trusted(found: Option<(bool, u32)>, uid: u32) -> bool {
    found.is_none_or(|(is_socket, owner)| is_socket && owner == uid)
}

/// True once a running Devot took the message (answered it); false when none listens there.
pub(crate) fn send_to(socket: &Path, message: &[u8], uid: u32) -> Result<bool, &'static str> {
    send_within(socket, message, uid, ANSWER_TIMEOUT)
}

fn send_within(
    socket: &Path,
    message: &[u8],
    uid: u32,
    wait: Duration,
) -> Result<bool, &'static str> {
    let found = match std::fs::symlink_metadata(socket) {
        Ok(meta) => Some((meta.file_type().is_socket(), meta.uid())),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(_) => Some((false, u32::MAX)),
    };
    if !socket_trusted(found, uid) {
        log::warn!("W_SINGLE_INSTANCE_SOCKET_FOREIGN");
        return Ok(false);
    }
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            return Ok(false);
        }
        Err(_) => return Err("E_CLI_HANDOFF_FAILED"),
    };
    // Before writing: macOS refuses the option once the other end has answered and closed.
    stream
        .set_read_timeout(Some(wait))
        .and_then(|()| stream.set_write_timeout(Some(wait)))
        .and_then(|()| stream.write_all(message))
        .and_then(|()| stream.shutdown(Shutdown::Write))
        .map_err(|_| "E_CLI_HANDOFF_FAILED")?;
    let mut answer = [0u8; 1];
    loop {
        return match stream.read(&mut answer) {
            Ok(1) if answer[0] == TAKEN => Ok(true),
            Ok(_) => Err("E_CLI_HANDOFF_REFUSED"),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => Err("E_CLI_HANDOFF_UNANSWERED"),
        };
    }
}

pub(crate) fn send(identifier: &str, message: &[u8]) -> Result<bool, &'static str> {
    match folder() {
        Some(dir) => send_to(&socket_in(&dir, identifier), message, effective_uid()),
        None => Ok(false),
    }
}

pub(crate) fn message(cwd: &Path, argv: &[String]) -> String {
    format!("{}\0\0{}", cwd.to_string_lossy(), argv.join("\0"))
}

/// A message over the limit is dropped whole: a cut one could name other files.
fn read_message(stream: &mut UnixStream) -> Option<(String, Vec<String>)> {
    // macOS refuses the option once the sender has closed, which is when no timeout is needed.
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let mut bytes = Vec::new();
    stream.take(MAX_MESSAGE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_MESSAGE {
        log::warn!("W_SINGLE_INSTANCE_MESSAGE_TOO_LONG");
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    let (cwd, args) = text.split_once("\0\0")?;
    Some((cwd.to_owned(), args.split('\0').map(String::from).collect()))
}

/// Answers a message `accept` takes before `run` handles it, since bringing Devot forward and
/// finding the files can take longer than a sender waits; one refused, or unreadable, is closed
/// unanswered.
fn serve(listener: &UnixListener, accept: impl Fn() -> bool, run: impl Fn(String, Vec<String>)) {
    for mut stream in listener.incoming().flatten() {
        let Some((cwd, args)) = read_message(&mut stream) else {
            continue;
        };
        if !accept() {
            continue;
        }
        let _ = stream.write_all(&[TAKEN]);
        drop(stream);
        run(cwd, args);
    }
}

/// Binds a new socket at `socket` once this process holds `lock`: None while another process holds
/// it, unless `wait`, which waits for it to let go. Without locks on the volume, it binds anyway.
fn claim(lock: &Path, socket: &Path, wait: bool) -> std::io::Result<Option<Claimed>> {
    let file = open_lock_file(lock)?;
    if wait {
        file.lock()?;
    } else {
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(_)) => log::warn!("W_SINGLE_INSTANCE_LOCK_FAILED"),
        }
    }
    match std::fs::remove_file(socket) {
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(socket)?;
    let meta = std::fs::symlink_metadata(socket)?;
    Ok(Some(Claimed {
        listener,
        socket: socket.to_owned(),
        bound: (meta.dev(), meta.ino()),
        lock: file,
    }))
}

fn remove_bound(socket: &Path, bound: (u64, u64)) {
    let ours =
        std::fs::symlink_metadata(socket).is_ok_and(|meta| (meta.dev(), meta.ino()) == bound);
    if ours {
        let _ = std::fs::remove_file(socket);
    }
}

fn listen(app: &AppHandle, claimed: Claimed) {
    let Claimed {
        listener,
        socket,
        bound,
        lock,
    } = claimed;
    app.manage(Listening {
        socket,
        bound,
        lock: Mutex::new(Some(lock)),
    });
    let app = app.clone();
    let started = std::thread::Builder::new()
        .name("devot-single-instance".into())
        .spawn(move || {
            serve(
                &listener,
                || {
                    let quitting = crate::exit::quitting(&app);
                    if quitting {
                        log::warn!("W_SINGLE_INSTANCE_QUITTING");
                    }
                    !quitting
                },
                |cwd, args| crate::deep_link::on_second_instance(&app, args, cwd),
            );
        });
    if started.is_err() {
        log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED");
    }
}

/// Claims the socket now, or once the Devot that holds it ends, should this one outlive it.
fn take_over(app: &AppHandle, dir: &Path, identifier: &str) {
    let (lock, socket) = (lock_in(dir, identifier), socket_in(dir, identifier));
    match claim(&lock, &socket, false) {
        Ok(Some(claimed)) => listen(app, claimed),
        Ok(None) => {
            let app = app.clone();
            let waiting = std::thread::Builder::new()
                .name("devot-single-instance-wait".into())
                .spawn(move || match claim(&lock, &socket, true) {
                    Ok(Some(claimed)) => listen(&app, claimed),
                    _ => log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED"),
                });
            if waiting.is_err() {
                log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED");
            }
        }
        Err(_) => log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED"),
    }
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
                Ok(false) => {}
                Err(code) => log::warn!("W_SINGLE_INSTANCE_SEND_FAILED {code}"),
            }
            match folder() {
                Some(dir) => take_over(app, &dir, &identifier),
                None => log::warn!("W_SINGLE_INSTANCE_LISTEN_FAILED"),
            }
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event
                && let Some(listening) = app.try_state::<Listening>()
            {
                remove_bound(&listening.socket, listening.bound);
                drop(
                    listening
                        .lock
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .take(),
                );
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

    type Taken = std::sync::mpsc::Receiver<(String, Vec<String>)>;

    /// Serves `listener` on a thread, taking every message or none (`take`), and passes on those taken.
    fn serving(listener: UnixListener, take: bool) -> Taken {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            serve(
                &listener,
                || take,
                |cwd, args| {
                    let _ = tx.send((cwd, args));
                },
            )
        });
        rx
    }

    #[test]
    fn hands_a_message_to_the_listener_and_nothing_to_a_foreign_file() {
        let dir = tempfile::tempdir().unwrap();
        let uid = effective_uid();
        let socket = dir.path().join("a.sock");
        assert_eq!(send_to(&socket, b"x", uid), Ok(false));
        let taken = serving(UnixListener::bind(&socket).unwrap(), true);
        let sent = message(Path::new("/w"), &["devot".into(), "a.md".into()]);
        assert_eq!(send_to(&socket, sent.as_bytes(), uid), Ok(true));
        assert_eq!(
            taken.recv().unwrap(),
            ("/w".into(), vec!["devot".into(), "a.md".into()])
        );
        assert_eq!(send_to(&socket, b"x", uid + 1), Ok(false));
        let planted = dir.path().join("b.sock");
        std::fs::write(&planted, b"").unwrap();
        assert_eq!(send_to(&planted, b"x", uid), Ok(false));
        assert_eq!(std::fs::read(&planted).unwrap(), b"");
        let gone = dir.path().join("c.sock");
        drop(UnixListener::bind(&gone).unwrap());
        assert_eq!(send_to(&gone, b"x", uid), Ok(false));
    }

    #[test]
    fn a_hand_off_the_running_devot_does_not_take_fails() {
        let dir = tempfile::tempdir().unwrap();
        let uid = effective_uid();
        let refusing = dir.path().join("quitting.sock");
        let taken = serving(UnixListener::bind(&refusing).unwrap(), false);
        assert_eq!(
            send_to(&refusing, b"/w\0\0devot", uid),
            Err("E_CLI_HANDOFF_REFUSED")
        );
        assert!(taken.recv_timeout(Duration::from_millis(200)).is_err());

        let silent = dir.path().join("silent.sock");
        let listener = UnixListener::bind(&silent).unwrap();
        let held = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let read = read_message(&mut stream);
            std::thread::sleep(Duration::from_millis(600));
            read
        });
        assert_eq!(
            send_within(&silent, b"/w\0\0devot", uid, Duration::from_millis(100)),
            Err("E_CLI_HANDOFF_UNANSWERED")
        );
        assert!(held.join().unwrap().is_some());
    }

    #[test]
    fn drops_a_message_over_the_limit_rather_than_cut_it() {
        let limit = MAX_MESSAGE as usize;
        for (len, read) in [(limit, true), (limit + 1, false)] {
            let (mut sender, mut receiver) = UnixStream::pair().unwrap();
            let text = format!("/w\0\0{}", "a".repeat(len - 4));
            let writer = std::thread::spawn(move || {
                let _ = sender.write_all(text.as_bytes());
            });
            assert_eq!(read_message(&mut receiver).is_some(), read, "{len}");
            drop(receiver);
            writer.join().unwrap();
        }
    }

    fn reaches(socket: &Path, claimed: &Claimed) -> bool {
        claimed.listener.set_nonblocking(true).unwrap();
        let connected = UnixStream::connect(socket).is_ok();
        let accepted = claimed.listener.accept().is_ok();
        claimed.listener.set_nonblocking(false).unwrap();
        connected && accepted
    }

    #[test]
    fn of_launches_claiming_at_once_one_binds_and_stays_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let (lock, socket) = (lock_in(dir.path(), "id"), socket_in(dir.path(), "id"));
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|_| {
                let (lock, socket, start) = (lock.clone(), socket.clone(), start.clone());
                std::thread::spawn(move || {
                    start.wait();
                    claim(&lock, &socket, false).unwrap()
                })
            })
            .collect();
        let mut claimed: Vec<Claimed> = launches
            .into_iter()
            .filter_map(|launch| launch.join().unwrap())
            .collect();
        assert_eq!(claimed.len(), 1);
        let winner = claimed.remove(0);
        // A launch that lost does not unbind it, whether it exits or claims again.
        assert!(claim(&lock, &socket, false).unwrap().is_none());
        assert!(reaches(&socket, &winner));
    }

    #[test]
    fn removes_at_exit_only_the_socket_it_bound() {
        let dir = tempfile::tempdir().unwrap();
        let (lock, socket) = (lock_in(dir.path(), "id"), socket_in(dir.path(), "id"));
        let claimed = claim(&lock, &socket, false).unwrap().unwrap();
        // A Devot that never took the lock (an older one) binds a socket of its own there.
        std::fs::remove_file(&socket).unwrap();
        let theirs = UnixListener::bind(&socket).unwrap();
        remove_bound(&socket, claimed.bound);
        assert!(socket.exists());
        drop(theirs);
        std::fs::remove_file(&socket).unwrap();
        let again = claim(&lock_in(dir.path(), "other"), &socket, false)
            .unwrap()
            .unwrap();
        remove_bound(&socket, again.bound);
        assert!(!socket.exists());
    }

    #[test]
    fn a_launch_left_waiting_claims_the_socket_once_the_holder_ends() {
        let dir = tempfile::tempdir().unwrap();
        let (lock, socket) = (lock_in(dir.path(), "id"), socket_in(dir.path(), "id"));
        let holder = claim(&lock, &socket, false).unwrap().unwrap();
        let waiting = {
            let (lock, socket) = (lock.clone(), socket.clone());
            std::thread::spawn(move || claim(&lock, &socket, true).unwrap().unwrap())
        };
        std::thread::sleep(Duration::from_millis(100));
        assert!(!waiting.is_finished());
        // Ends as a failed launch does: no cleanup, the socket file stays behind.
        drop(holder);
        let claimed = waiting.join().unwrap();
        assert!(reaches(&socket, &claimed));
    }
}
