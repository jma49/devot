//! Native crash reports: signals, aborts and crashes inside WebKit or AppKit,
//! which Rust's panic hook never sees. Only builds with a Sentry DSN start
//! any of this; other builds run no extra process and write no file.
//!
//! The app starts a second copy of its own binary as the crash reporter
//! (`devot --crash-reporter <service> <folder>`) and hands it a crash over
//! Mach IPC. The reporter writes a minidump of the crashed app into memory
//! and turns it into a stack trace of code addresses: module file names,
//! debug IDs, the exception code. That trace is scrubbed like every other
//! event and saved as JSON in `<app data>/crash-reports`. The minidump itself
//! holds the app's stack memory, which may contain note text, so it never
//! reaches the disk or the network. The next launch sends the saved reports
//! to Sentry and deletes each one Sentry has accepted.

use crate::atomic_file::{Place, TempFile};
use sentry::protocol::debugid::{CodeId, DebugId};
use sentry::protocol::{
    Addr, Context, DebugImage, DeviceContext, Event, Exception, Frame, Level, MachException,
    Mechanism, MechanismMeta, OsContext, PosixSignal, Stacktrace, SymbolicDebugImage, Thread,
    Values,
};
use std::path::{Path, PathBuf};

/// The first argument that starts the binary as the crash reporter.
pub const FLAG: &str = "--crash-reporter";
/// Saved reports, in the app data folder.
pub const DIR: &str = "crash-reports";
/// The Mach service the reporter registers; the app's process ID and a
/// random token follow.
pub const SERVICE_PREFIX: &str = "io.github.jma49.devot.crash-reporter.";
/// The code every native crash event carries as its value.
pub const CRASH_CODE: &str = "E_NATIVE_CRASH";
const SUFFIX: &str = ".json";
const PARTIAL_SUFFIX: &str = ".json.partial";
/// Reports sent per launch; any others are deleted unsent.
const MAX_SENT: usize = 5;
/// A report Sentry could not take (offline, rate limited) waits for a later
/// launch, but not longer than this.
const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
/// How long one report may take to send.
const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// A saved report is a few dozen KiB; anything far larger is not ours.
const MAX_REPORT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FRAMES: usize = 128;
const MAX_THREADS: usize = 64;
/// User-space code addresses on macOS fit in 47 bits; the bits above carry
/// pointer authentication codes on Apple silicon.
const ADDRESS_MASK: u64 = 0x0000_7fff_ffff_ffff;

/// A loaded binary (the app, a framework, a library).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Module {
    pub path: String,
    pub base: u64,
    pub size: u64,
    pub debug_id: Option<DebugId>,
    pub code_id: Option<String>,
}

/// One thread's return addresses, innermost (the current instruction) first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadStack {
    pub id: u32,
    pub frames: Vec<u64>,
}

/// What a report keeps from a minidump: code addresses and the binaries they
/// belong to, the exception, and system details. Nothing from memory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Crash {
    /// The exception as text, such as `EXC_BAD_ACCESS / KERN_INVALID_ADDRESS`.
    pub reason: String,
    /// The Mach exception type, code and subcode.
    pub mach: Option<(u32, u64, u64)>,
    /// The Unix signal behind an `EXC_SOFTWARE` exception (an abort).
    pub signal: Option<i32>,
    pub crashed_thread: Option<u32>,
    pub threads: Vec<ThreadStack>,
    pub modules: Vec<Module>,
    /// The app's own executable among `modules` (`app_module`): its frames
    /// are the in-app ones.
    pub app: Option<usize>,
    pub arch: String,
    pub os_version: Option<String>,
    pub os_build: Option<String>,
}

/// The last part of a path: a module's file name, never the folder it was
/// loaded from (which names the user for apps in a home folder).
pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Follows the frame-pointer chain from `pc` and `fp` through stack memory:
/// each frame record holds the caller's frame pointer and the return
/// address (the same layout on arm64 and x86-64, both of which keep frame
/// pointers on macOS). Stops at a null or misaligned record, when memory is
/// missing, or when the chain does not move up the stack.
pub fn walk_frames(pc: u64, fp: u64, read: impl Fn(u64) -> Option<u64>) -> Vec<u64> {
    let mut frames = vec![pc & ADDRESS_MASK];
    let mut fp = fp;
    while frames.len() < MAX_FRAMES && fp != 0 && fp.is_multiple_of(8) {
        let (Some(caller_fp), Some(ret)) = (read(fp), fp.checked_add(8).and_then(&read)) else {
            break;
        };
        let ret = ret & ADDRESS_MASK;
        if ret == 0 {
            break;
        }
        frames.push(ret);
        if caller_fp <= fp {
            break;
        }
        fp = caller_fp;
    }
    frames
}

/// Which module is the app's own executable: the one loaded from `app`
/// (the crashed process's executable), compared as written or with links
/// resolved. The minidump's own order is no guide: it puts first whichever
/// image has no dylib ID, and a plug-in bundle (as AppKit and WebKit load)
/// has none either.
pub fn app_module(modules: &[Module], app: &Path) -> Option<usize> {
    let name = app.file_name()?.to_str()?;
    let real = std::fs::canonicalize(app).ok();
    modules.iter().position(|m| {
        Path::new(&m.path) == app
            || (file_name(&m.path) == name
                && real.is_some()
                && std::fs::canonicalize(&m.path).ok() == real)
    })
}

/// The module an address falls in, by index.
fn module_of(modules: &[Module], address: u64) -> Option<usize> {
    modules
        .iter()
        .position(|m| address >= m.base && address - m.base < m.size)
}

/// On arm64 a leaf function (`objc_msgSend`, `memcpy`, a system call
/// wrapper) builds no frame record, so the frame-pointer chain skips its
/// caller, whose return address is still in the link register. The link
/// register is added as the second frame only when it points into another
/// binary than the current instruction: a function that has made calls of
/// its own leaves it pointing into itself, or holding some other value.
pub fn add_leaf_caller(frames: &mut Vec<u64>, lr: u64, modules: &[Module]) {
    let lr = lr & ADDRESS_MASK;
    let Some(&pc) = frames.first() else {
        return;
    };
    // A return address is an instruction address, which arm64 aligns to 4.
    if !lr.is_multiple_of(4) {
        return;
    }
    let Some(caller) = module_of(modules, lr) else {
        return;
    };
    if module_of(modules, pc) != Some(caller) && frames.get(1) != Some(&lr) {
        frames.insert(1, lr);
        frames.truncate(MAX_FRAMES);
    }
}

/// The module that holds the signal trampoline (`_sigtramp`) on macOS.
const SIGNAL_TRAMPOLINE: &str = "libsystem_platform.dylib";

/// An abort reaches the crash handler through a signal handler, so the
/// crashed thread's own registers point into the handler: innermost, the
/// system code it waits in, then the handler itself (in the app's binary,
/// `app`, which links the crash handler), then the signal trampoline. The
/// trace starts after the trampoline instead, at the code that raised the
/// signal. A trace of any other shape is kept as it is.
pub fn trim_signal_handler(frames: &mut Vec<u64>, modules: &[Module], app: Option<usize>) {
    let Some(app) = app else {
        return;
    };
    let in_app = |address: u64| module_of(modules, address) == Some(app);
    let waiting = frames.iter().take_while(|&&a| !in_app(a)).count();
    let handler = frames[waiting..].iter().take_while(|&&a| in_app(a)).count();
    let trampoline = waiting + handler;
    let is_trampoline = frames.get(trampoline).is_some_and(|&address| {
        module_of(modules, address)
            .is_some_and(|i| file_name(&modules[i].path) == SIGNAL_TRAMPOLINE)
    });
    if handler > 0 && is_trampoline && trampoline + 1 < frames.len() {
        frames.drain(..=trampoline);
    }
}

/// Whether a thread goes in a report: the crashed thread always, the others
/// up to `MAX_THREADS` in all (`others` counts those kept so far).
fn keep_thread(crashed: bool, others: &mut usize) -> bool {
    if crashed {
        return true;
    }
    if *others + 1 >= MAX_THREADS {
        return false;
    }
    *others += 1;
    true
}

/// A native crash event built only from code addresses, module file names,
/// debug IDs and the exception code; `crash_scrub::scrub_event` still runs on
/// it. A frame-pointer chain or a register can hold data rather than a code
/// address (note text, when data was used as a pointer), so an address
/// outside every module is never a frame, and a fault address is kept only
/// near null or inside a module.
pub fn event_from_crash(crash: &Crash, release: &str, environment: &str) -> Event<'static> {
    let mut used = vec![false; crash.modules.len()];
    let mut stacktrace = |addresses: &[u64]| {
        let frames: Vec<Frame> = addresses
            .iter()
            .rev()
            .filter_map(|&address| {
                let i = module_of(&crash.modules, address)?;
                used[i] = true;
                Some(Frame {
                    instruction_addr: Some(Addr(address)),
                    package: Some(file_name(&crash.modules[i].path).into()),
                    image_addr: Some(Addr(crash.modules[i].base)),
                    // Devot's own frames, so Sentry groups by them.
                    in_app: Some(crash.app == Some(i)),
                    ..Default::default()
                })
            })
            .collect();
        (!frames.is_empty()).then(|| Stacktrace {
            frames,
            ..Default::default()
        })
    };

    let mut crashed_stack = None;
    let mut threads = Vec::new();
    let mut others = 0;
    for thread in &crash.threads {
        let crashed = crash.crashed_thread == Some(thread.id);
        if !keep_thread(crashed, &mut others) {
            continue;
        }
        let stack = stacktrace(&thread.frames);
        threads.push(Thread {
            id: Some(thread.id.into()),
            crashed,
            current: crashed,
            // The crashed thread's trace is the exception's.
            stacktrace: if crashed { None } else { stack.clone() },
            ..Default::default()
        });
        if crashed {
            crashed_stack = stack;
        }
    }

    // A bad access's subcode is the address that faulted.
    let mach = crash.mach.filter(|&(_, _, subcode)| {
        subcode < crate::crash_scrub::NEAR_NULL
            || module_of(&crash.modules, subcode).is_some_and(|i| {
                used[i] = true;
                true
            })
    });
    let meta = MechanismMeta {
        mach_exception: mach.map(|(exception, code, subcode)| MachException {
            exception: i32::try_from(exception).unwrap_or(i32::MAX),
            code,
            subcode,
            name: None,
        }),
        signal: crash.signal.map(|number| PosixSignal {
            number,
            code: None,
            name: signal_name(number).map(Into::into),
            code_name: None,
        }),
        ..Default::default()
    };
    let exception = Exception {
        ty: crash.reason.clone(),
        value: Some(CRASH_CODE.into()),
        stacktrace: crashed_stack,
        thread_id: crash.crashed_thread.map(Into::into),
        mechanism: Some(Mechanism {
            ty: "minidump".into(),
            handled: Some(false),
            meta,
            ..Default::default()
        }),
        ..Default::default()
    };

    let images = crash
        .modules
        .iter()
        .zip(&used)
        .filter(|(_, used)| **used)
        .map(|(module, _)| {
            DebugImage::Symbolic(SymbolicDebugImage {
                name: file_name(&module.path).into(),
                arch: Some(crash.arch.clone()),
                image_addr: Addr(module.base),
                image_size: module.size,
                image_vmaddr: Addr(0),
                id: module.debug_id.unwrap_or_default(),
                code_id: module
                    .code_id
                    .as_deref()
                    .and_then(|c| c.parse::<CodeId>().ok()),
                debug_file: None,
            })
        })
        .collect();

    let mut event = Event {
        level: Level::Fatal,
        platform: "native".into(),
        release: Some(release.to_owned().into()),
        environment: Some(environment.to_owned().into()),
        exception: Values {
            values: vec![exception],
        },
        threads: Values { values: threads },
        ..Default::default()
    };
    event.debug_meta.to_mut().images = images;
    event.contexts.insert(
        "os".into(),
        Context::Os(Box::new(OsContext {
            name: Some("macOS".into()),
            version: crash.os_version.clone(),
            build: crash.os_build.clone(),
            ..Default::default()
        })),
    );
    event.contexts.insert(
        "device".into(),
        Context::Device(Box::new(DeviceContext {
            arch: Some(crash.arch.clone()),
            ..Default::default()
        })),
    );
    event
}

fn signal_name(number: i32) -> Option<&'static str> {
    Some(match number {
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        10 => "SIGBUS",
        11 => "SIGSEGV",
        _ => return None,
    })
}

/// Saves a report as `<event id>.json`; a partial file is renamed only once
/// it is complete, so an interrupted write never looks like a report. The
/// partial file is created new (its name is the random event ID), never
/// opened where a file or a link already is (see `atomic_file`).
pub fn save(dir: &Path, event: &Event<'static>) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let id = event.event_id.simple().to_string();
    let done = dir.join(format!("{id}{SUFFIX}"));
    let mut partial = TempFile::create(dir.join(format!("{id}{PARTIAL_SUFFIX}")))?;
    partial.write_all(&serde_json::to_vec(event)?)?;
    partial.persist(&done, Place::Replace)?;
    Ok(done)
}

/// A saved report, read back for sending.
pub struct Pending {
    pub path: PathBuf,
    pub event: Event<'static>,
}

/// The saved reports to send, newest first and at most `MAX_SENT`. Every
/// other file of ours in `dir` (older reports beyond that or past `MAX_AGE`,
/// unreadable ones, unfinished writes) is deleted now; the caller deletes
/// these once Sentry has them (`remove`).
pub fn pending(dir: &Path) -> Vec<Pending> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let now = std::time::SystemTime::now();
    let mut reports: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.ends_with(PARTIAL_SUFFIX) {
            // A write the reporter never finished.
            remove(&[path]);
        } else if name.ends_with(SUFFIX) {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if now.duration_since(modified).unwrap_or_default() > MAX_AGE {
                remove(&[path]);
            } else {
                reports.push((modified, path));
            }
        }
    }
    reports.sort_by_key(|r| std::cmp::Reverse(r.0));
    let mut kept = Vec::new();
    for (_, path) in reports {
        let report = (kept.len() < MAX_SENT)
            .then(|| read_report(&path))
            .flatten();
        match report {
            Some(event) => kept.push(Pending { path, event }),
            None => remove(&[path]),
        }
    }
    kept
}

/// Deletes report files.
pub fn remove(paths: &[PathBuf]) {
    for path in paths {
        if std::fs::remove_file(path).is_err() {
            log::warn!("W_CRASH_REPORT_DELETE_FAILED");
        }
    }
}

/// What Sentry's answer means for a saved report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Taken (2xx): delete it.
    Accepted,
    /// Refused for good (another 4xx, such as a malformed or oversized
    /// event): delete it, sending again would not help.
    Refused,
    /// Not delivered (no connection, 429 rate limit, 5xx): keep it for the
    /// next launch, and send nothing more now.
    Later,
}

pub fn delivery(status: Option<u16>) -> Delivery {
    match status {
        Some(200..=299) => Delivery::Accepted,
        Some(429) | Some(500..) | None => Delivery::Later,
        Some(_) => Delivery::Refused,
    }
}

/// Sends the saved reports to Sentry, newest first, one request each, and
/// deletes each report once Sentry has answered for good. The answer is
/// read here rather than left to the SDK's background transport, which
/// would drop a report it failed to send. Returns how many were accepted.
pub fn send_pending(dir: &Path, dsn: &str) -> usize {
    let Ok(dsn) = dsn.parse::<sentry::types::Dsn>() else {
        log::warn!("W_CRASH_REPORT_DSN_INVALID");
        return 0;
    };
    let reports = pending(dir);
    if reports.is_empty() {
        return 0;
    }
    let user_agent = concat!("devot/", env!("CARGO_PKG_VERSION"));
    let auth = dsn.to_auth(Some(user_agent)).to_string();
    let url = dsn.envelope_api_url().to_string();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .build(),
        )
        .timeout_global(Some(SEND_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into();
    let mut accepted = 0;
    for report in reports {
        let mut body = Vec::new();
        let envelope = sentry::Envelope::from(crate::crash_scrub::scrub_event(report.event));
        if envelope.to_writer(&mut body).is_err() {
            remove(&[report.path]);
            continue;
        }
        let status = agent
            .post(&url)
            .header("X-Sentry-Auth", &auth)
            .header("Content-Type", "application/x-sentry-envelope")
            .send(&body[..])
            .ok()
            .map(|response| response.status().as_u16());
        match delivery(status) {
            Delivery::Accepted => {
                accepted += 1;
                remove(&[report.path]);
            }
            Delivery::Refused => {
                log::warn!("W_CRASH_REPORT_REFUSED");
                remove(&[report.path]);
            }
            Delivery::Later => {
                log::warn!("W_CRASH_REPORT_NOT_DELIVERED");
                break;
            }
        }
    }
    accepted
}

fn read_report(path: &Path) -> Option<Event<'static>> {
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_REPORT_BYTES {
        log::warn!("W_CRASH_REPORT_TOO_LARGE");
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let event = serde_json::from_slice(&bytes);
    if event.is_err() {
        log::warn!("W_CRASH_REPORT_UNREADABLE");
    }
    event.ok()
}

/// Starts native crash reports for this run on a background thread: the
/// reporter process, then the crash handler that hands it a crash. Without a
/// DSN nothing starts (no process, no folder). The thread's result says
/// whether the handler is attached.
pub fn start(
    dsn: Option<&str>,
    exe: PathBuf,
    dir: PathBuf,
) -> Option<std::thread::JoinHandle<bool>> {
    dsn.filter(|d| !d.is_empty())?;
    #[cfg(target_os = "macos")]
    {
        std::thread::Builder::new()
            .name("devot-crash-reporter".into())
            .spawn(move || mac::start(&exe, &dir))
            .ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (exe, dir);
        None
    }
}

/// The running reporter's process ID, once `start` has attached the handler.
pub fn reporter_pid() -> Option<u32> {
    #[cfg(target_os = "macos")]
    return mac::RUNNING.get().map(|r| r.pid);
    #[cfg(not(target_os = "macos"))]
    None
}

/// Runs the crash reporter when these are its arguments
/// (`<binary> --crash-reporter <service> <folder>`) and returns its exit
/// code; `None` for any other arguments.
pub fn reporter_main(args: &[std::ffi::OsString]) -> Option<i32> {
    if args.get(1)? != FLAG {
        return None;
    }
    #[cfg(target_os = "macos")]
    return Some(match args {
        [_, _, service, dir] => mac::run(service, dir),
        _ => 2,
    });
    #[cfg(not(target_os = "macos"))]
    Some(2)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crash_context::ipc;
    use std::ffi::{CString, OsStr};
    use std::io::{BufRead, Read, Write};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// What the reporter prints once it holds its Mach service.
    const READY: &str = "ready";
    /// The reporter is ready in tens of milliseconds, under a second from a
    /// cold disk; one that has not answered by then is stopped.
    const READY_TIMEOUT: Duration = Duration::from_secs(5);
    const SEND_TIMEOUT: Duration = Duration::from_secs(2);
    /// How long a crashing app waits for the reporter to read it.
    const ACK_TIMEOUT: Duration = Duration::from_secs(10);
    /// The reporter waits in the kernel; it wakes only for a crash.
    const RECEIVE_WAIT: Duration = Duration::from_secs(3600);

    /// Kept for the app's life: closing the pipe tells the reporter that
    /// the app has gone.
    pub(super) struct Running {
        _handler: crate::native::macos::CrashHandler,
        _pipe: ChildStdin,
        pub(super) pid: u32,
    }

    pub(super) static RUNNING: OnceLock<Running> = OnceLock::new();

    pub(super) fn start(exe: &Path, dir: &Path) -> bool {
        match try_start(exe, dir) {
            Ok(running) => {
                let started = RUNNING.set(running).is_ok();
                if started {
                    log::info!("I_CRASH_REPORTER_READY");
                }
                started
            }
            Err(code) => {
                log::warn!("{code}");
                false
            }
        }
    }

    fn try_start(exe: &Path, dir: &Path) -> Result<Running, &'static str> {
        std::fs::create_dir_all(dir).map_err(|_| "W_CRASH_REPORTER_DIR_FAILED")?;
        // Unguessable, so that no other process can take the name first.
        let service = format!(
            "{SERVICE_PREFIX}{}.{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        );
        let name = CString::new(service.clone()).map_err(|_| "W_CRASH_REPORTER_NAME_INVALID")?;
        let mut child = Command::new(exe)
            .arg(FLAG)
            .arg(&service)
            .arg(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "W_CRASH_REPORTER_SPAWN_FAILED")?;
        let pipe = child.stdin.take().ok_or("W_CRASH_REPORTER_PIPE_MISSING")?;
        // The child says when it holds the service; only then is the name
        // known to be its own (a name has one holder at a time), so the
        // crash handler never hands the app to another process.
        let (said, heard) = std::sync::mpsc::channel();
        let (attached, watch) = std::sync::mpsc::channel::<Child>();
        if let Some(out) = child.stdout.take() {
            // Killing a reporter that never answers closes its output, which
            // ends this thread too.
            let _ = std::thread::Builder::new()
                .name("devot-crash-reporter-out".into())
                .spawn(move || {
                    let mut out = std::io::BufReader::new(out);
                    let mut line = String::new();
                    let ok = out.read_line(&mut line).is_ok() && line.trim() == READY;
                    let _ = said.send(ok);
                    if let Ok(child) = watch.recv() {
                        watch_reporter(out, child);
                    }
                });
        }
        let ready = heard.recv_timeout(READY_TIMEOUT).unwrap_or(false);
        let client = ready.then(|| ipc::Client::create(&name).ok()).flatten();
        let Some(client) = client else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("W_CRASH_REPORTER_NOT_READY");
        };
        let handler = crate::native::macos::attach_crash_handler(move |context| {
            // Runs while the app is crashing: one Mach message and its reply,
            // no allocation, no lock and no logging.
            matches!(
                client.send_crash_context(context, Some(SEND_TIMEOUT), Some(ACK_TIMEOUT)),
                Ok(Some(1))
            )
        })
        .map_err(|_| "W_CRASH_HANDLER_ATTACH_FAILED")?;
        let pid = child.id();
        if let Err(std::sync::mpsc::SendError(mut child)) = attached.send(child) {
            // Nothing would notice the reporter go.
            crate::native::macos::detach_crash_handler();
            let _ = child.kill();
            let _ = child.wait();
            return Err("W_CRASH_REPORTER_UNWATCHED");
        }
        Ok(Running {
            _handler: handler,
            _pipe: pipe,
            pid,
        })
    }

    /// Waits for the reporter to end (its output closes) and then detaches
    /// the crash handler, which could no longer report: from then on a crash
    /// takes the system's default course. No new reporter is started: the
    /// reporter ends only after it has saved a crash (and the app is then
    /// ending too) or when something outside stops it, and another start
    /// could meet the same fate, over and over.
    fn watch_reporter(mut out: impl Read, mut child: Child) {
        let mut buf = [0u8; 64];
        while matches!(out.read(&mut buf), Ok(n) if n > 0) {}
        crate::native::macos::detach_crash_handler();
        let _ = child.wait();
        log::warn!("W_CRASH_REPORTER_GONE");
    }

    /// Set while a crash is being written, so that the app closing the pipe
    /// (it ends once the reporter has answered) does not cut the write short.
    static HANDLING: AtomicBool = AtomicBool::new(false);

    /// The reporter process: waits for one crash of the app that started it,
    /// saves its report and exits; exits as soon as the app has gone.
    pub(super) fn run(service: &OsStr, dir: &OsStr) -> i32 {
        let dir = Path::new(dir);
        let Some(service) = service.to_str() else {
            return 2;
        };
        let valid_service = service
            .strip_prefix(SERVICE_PREFIX)
            .and_then(|rest| rest.split_once('.'))
            .is_some_and(|(pid, token)| {
                pid.parse::<u32>().is_ok()
                    && token.len() == 32
                    && token.bytes().all(|b| b.is_ascii_hexdigit())
            });
        if !valid_service || !dir.is_absolute() {
            return 2;
        }
        let Ok(name) = CString::new(service) else {
            return 2;
        };
        let app = std::os::unix::process::parent_id();
        // The app's executable, whose frames are the in-app ones.
        let app_path = crate::native::macos::executable_of(app);
        let Ok(mut server) = ipc::Server::create(&name) else {
            return 1;
        };
        let mut out = std::io::stdout();
        if writeln!(out, "{READY}").and_then(|()| out.flush()).is_err() {
            return 1;
        }
        watch_app();
        loop {
            match server.try_recv_crash_context(Some(RECEIVE_WAIT)) {
                Ok(None) => {}
                // Only the app that started this reporter may hand it a crash.
                Ok(Some(mut received)) if received.pid != app => {
                    let _ = received.acker.send_ack(0, Some(SEND_TIMEOUT));
                }
                Ok(Some(mut received)) => {
                    HANDLING.store(true, Ordering::SeqCst);
                    let saved = report(&received.crash_context, app_path.as_deref(), dir).is_ok();
                    let _ = received
                        .acker
                        .send_ack(u32::from(saved), Some(SEND_TIMEOUT));
                    return i32::from(!saved);
                }
                Err(_) => return 1,
            }
        }
    }

    /// Exits once the app's end of the pipe closes (the app quit or died),
    /// unless a crash is being written.
    fn watch_app() {
        let spawned = std::thread::Builder::new()
            .name("devot-crash-reporter-watch".into())
            .spawn(|| {
                let mut buf = [0u8; 64];
                let mut stdin = std::io::stdin();
                while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
                if !HANDLING.load(Ordering::SeqCst) {
                    std::process::exit(0);
                }
            });
        if spawned.is_err() {
            std::process::exit(1);
        }
    }

    /// Writes a minidump of the crashed app into memory, keeps only its
    /// addresses, modules and exception, and saves the scrubbed report.
    /// A minidump that fails to write (rarely, when the system is busy) is
    /// tried again after a moment; if every try fails, or the dump cannot be
    /// read, the report still carries the exception.
    fn report(
        context: &crash_context::CrashContext,
        app: Option<&Path>,
        dir: &Path,
    ) -> Result<PathBuf, &'static str> {
        let mut dump = None;
        for attempt in 0..DUMP_ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(DUMP_RETRY_WAIT);
            }
            dump = write_minidump(context);
            if dump.is_some() {
                break;
            }
        }
        let crash = dump
            .and_then(|bytes| crash_from_minidump(&bytes, app).ok())
            .unwrap_or_else(|| crash_without_dump(context.exception));
        let event = event_from_crash(&crash, crate::crash::RELEASE, crate::crash::environment());
        save(dir, &crate::crash_scrub::scrub_event(event)).map_err(|_| "E_CRASH_REPORT_SAVE_FAILED")
    }

    const DUMP_ATTEMPTS: usize = 3;
    const DUMP_RETRY_WAIT: Duration = Duration::from_millis(100);

    /// The minidump, in memory only.
    fn write_minidump(context: &crash_context::CrashContext) -> Option<Vec<u8>> {
        let context = crash_context::CrashContext {
            task: context.task,
            thread: context.thread,
            handler_thread: context.handler_thread,
            exception: context.exception,
        };
        let mut sink = std::io::Cursor::new(Vec::new());
        let mut writer =
            minidump_writer::minidump_writer::MinidumpWriter::with_crash_context(context);
        writer.dump(&mut sink).ok()?;
        Some(sink.into_inner())
    }

    const EXC_BAD_ACCESS: u32 = 1;
    /// `EXC_SOFTWARE` with this code carries a Unix signal in its subcode.
    const EXC_SOFTWARE: u32 = 5;
    const EXC_SOFT_SIGNAL: u64 = 0x10003;
    const EXC_CRASH: u32 = 10;
    const EXC_RESOURCE: u32 = 11;
    const EXC_GUARD: u32 = 12;
    const EXC_CORPSE_NOTIFY: u32 = 13;

    /// The exception record minidump-writer would write for this exception
    /// (an `EXC_CRASH` unwrapped), so a report made without a minidump names
    /// the crash exactly as one made with it.
    pub(super) fn exception_record(
        exception: &crash_context::ExceptionInfo,
    ) -> minidump::format::MINIDUMP_EXCEPTION_STREAM {
        let wrapped = ((exception.code >> 20) & 0xf) as u32;
        let unwrap = exception.kind == EXC_CRASH
            && ![EXC_CRASH, EXC_RESOURCE, EXC_GUARD, EXC_CORPSE_NOTIFY].contains(&wrapped);
        let (kind, flags) = if unwrap {
            (wrapped, (exception.code & 0xfffff) as u32)
        } else if exception.kind == EXC_RESOURCE || exception.kind == EXC_GUARD {
            (exception.kind, (exception.code >> 32) as u32)
        } else {
            (exception.kind, exception.code as u32)
        };
        let mut record = minidump::format::MINIDUMP_EXCEPTION {
            exception_code: kind,
            exception_flags: flags,
            exception_address: exception
                .subcode
                .filter(|_| kind == EXC_BAD_ACCESS)
                .unwrap_or(0),
            number_parameters: if exception.subcode.is_some() { 3 } else { 2 },
            ..Default::default()
        };
        record.exception_information[0] = u64::from(kind);
        record.exception_information[1] = exception.code;
        record.exception_information[2] = exception.subcode.unwrap_or(0);
        minidump::format::MINIDUMP_EXCEPTION_STREAM {
            thread_id: 0,
            __align: 0,
            exception_record: record,
            thread_context: Default::default(),
        }
    }

    /// The Mach exception (type, code, subcode), the signal behind an abort
    /// and the exception as text, from an exception record.
    pub(super) fn describe(
        raw: &minidump::format::MINIDUMP_EXCEPTION_STREAM,
        cpu: minidump::system_info::Cpu,
    ) -> ((u32, u64, u64), Option<i32>, String) {
        let record = &raw.exception_record;
        let kind = record.exception_code;
        // EXC_RESOURCE and EXC_GUARD keep their full 64-bit code in the extra
        // information only; the others' (unwrapped) code is in the flags.
        let code = if kind == EXC_RESOURCE || kind == EXC_GUARD {
            record.exception_information[1]
        } else {
            u64::from(record.exception_flags)
        };
        let subcode = if record.number_parameters > 2 {
            record.exception_information[2]
        } else {
            0
        };
        let signal = (kind == EXC_SOFTWARE && code == EXC_SOFT_SIGNAL)
            .then(|| i32::try_from(subcode).ok())
            .flatten();
        // The parser names Mach exceptions but not the signal behind an
        // abort, which crash_handler reports as EXC_SOFTWARE.
        let reason = match signal {
            Some(number) => format!(
                "EXC_SOFTWARE / {}",
                signal_name(number).map_or_else(|| format!("signal {number}"), Into::into)
            ),
            None => minidump::CrashReason::from_mac_exception(raw, cpu)
                .map_or_else(|| "EXC_UNKNOWN".into(), |r| r.to_string()),
        };
        ((kind, code, subcode), signal, reason)
    }

    fn this_cpu() -> minidump::system_info::Cpu {
        if cfg!(target_arch = "aarch64") {
            minidump::system_info::Cpu::Arm64
        } else {
            minidump::system_info::Cpu::X86_64
        }
    }

    /// What a report says when no minidump could be written or read: the
    /// exception alone, with no threads or modules.
    pub(super) fn crash_without_dump(exception: Option<crash_context::ExceptionInfo>) -> Crash {
        let cpu = this_cpu();
        let (mach, signal, reason) = match exception {
            Some(e) => {
                let (mach, signal, reason) = describe(&exception_record(&e), cpu);
                (Some(mach), signal, reason)
            }
            None => (None, None, "EXC_UNKNOWN".into()),
        };
        Crash {
            reason,
            mach,
            signal,
            arch: if cpu == minidump::system_info::Cpu::Arm64 {
                "arm64"
            } else {
                "x86_64"
            }
            .into(),
            ..Crash::default()
        }
    }

    pub(super) fn crash_from_minidump(
        bytes: &[u8],
        app_path: Option<&Path>,
    ) -> Result<Crash, minidump::Error> {
        use minidump::system_info::Cpu;
        use minidump::{
            Minidump, MinidumpException, MinidumpMiscInfo, MinidumpModuleList, MinidumpSystemInfo,
            MinidumpThreadList, Module as _,
        };

        let dump = Minidump::read(bytes)?;
        let system: MinidumpSystemInfo = dump.get_stream()?;
        let misc = dump.get_stream::<MinidumpMiscInfo>().ok();
        let threads: MinidumpThreadList = dump.get_stream()?;
        let modules: MinidumpModuleList = dump.get_stream()?;
        let exception = dump.get_stream::<MinidumpException>().ok();
        let memory = dump.get_memory().unwrap_or_default();
        let (arch, frame_pointer) = match system.cpu {
            Cpu::Arm64 => ("arm64", "fp"),
            Cpu::X86_64 => ("x86_64", "rbp"),
            _ => return Err(minidump::Error::StreamNotFound),
        };

        let crashed_thread = exception
            .as_ref()
            .map(MinidumpException::get_crashing_thread_id);
        let (mach, signal, reason) = match &exception {
            Some(e) => {
                let (mach, signal, reason) = describe(&e.raw, system.cpu);
                (Some(mach), signal, reason)
            }
            None => (None, None, "EXC_UNKNOWN".into()),
        };
        let modules: Vec<Module> = modules
            .iter()
            .map(|m| Module {
                path: m.code_file().into_owned(),
                base: m.base_address(),
                size: m.size(),
                debug_id: m.debug_identifier(),
                code_id: m.code_identifier().map(|c| c.to_string()),
            })
            .collect();
        let app = app_path.and_then(|path| app_module(&modules, path));

        let mut stacks = Vec::new();
        let mut others = 0;
        for thread in &threads.threads {
            let id = thread.raw.thread_id;
            let crashed = crashed_thread == Some(id);
            if !keep_thread(crashed, &mut others) {
                continue;
            }
            // The crashed thread's registers at the crash, not in the handler.
            let context = exception
                .as_ref()
                .filter(|_| crashed)
                .and_then(|e| e.context(&system, misc.as_ref()))
                .or_else(|| thread.context(&system, misc.as_ref()));
            let Some(context) = context else {
                continue;
            };
            let stack = thread.stack_memory(&memory);
            let mut frames = walk_frames(
                context.get_instruction_pointer(),
                context.get_register_always(frame_pointer),
                |address| stack.as_ref()?.get_memory_at_address::<u64>(address),
            );
            if system.cpu == Cpu::Arm64 {
                add_leaf_caller(&mut frames, context.get_register_always("lr"), &modules);
            }
            if crashed && signal.is_some() {
                trim_signal_handler(&mut frames, &modules, app);
            }
            stacks.push(ThreadStack { id, frames });
        }

        let (os_version, os_build) = system.os_parts();
        Ok(Crash {
            reason,
            mach,
            signal,
            crashed_thread,
            threads: stacks,
            modules,
            app,
            arch: arch.into(),
            os_version: Some(os_version),
            os_build,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const APP: &str = "/Users/alice/Applications/Devot.app/Contents/MacOS/devot";
    const WEBKIT: &str = "/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit";
    const DEBUG_ID: &str = "4c4c4436-5555-3144-a1d2-7f8a9b0c1d2e";

    fn memory(words: &[(u64, u64)]) -> impl Fn(u64) -> Option<u64> {
        let map: HashMap<u64, u64> = words.iter().copied().collect();
        move |addr| map.get(&addr).copied()
    }

    #[test]
    fn walks_the_frame_pointer_chain_up_the_stack() {
        // Three frame records: [fp] = caller's fp, [fp + 8] = return address.
        let read = memory(&[
            (0x1000, 0x1040),
            (0x1008, 0x1_0000_2000),
            (0x1040, 0x1080),
            (0x1048, 0x1_0000_3000),
            (0x1080, 0),
            (0x1088, 0x1_0000_4000),
        ]);
        assert_eq!(
            walk_frames(0x1_0000_1000, 0x1000, read),
            vec![0x1_0000_1000, 0x1_0000_2000, 0x1_0000_3000, 0x1_0000_4000]
        );
    }

    #[test]
    fn stops_on_a_chain_that_loops_or_leaves_the_stack() {
        // The second record points back down the stack.
        let looping = memory(&[(0x2000, 0x1000), (0x2008, 0x1_0000_2000)]);
        assert_eq!(
            walk_frames(0x1_0000_1000, 0x2000, looping),
            vec![0x1_0000_1000, 0x1_0000_2000]
        );
        // Memory the minidump does not have.
        assert_eq!(
            walk_frames(0x1_0000_1000, 0x9000, memory(&[])),
            vec![0x1_0000_1000]
        );
        // A misaligned or null frame pointer.
        assert_eq!(
            walk_frames(0x1_0000_1000, 0x1003, memory(&[])),
            vec![0x1_0000_1000]
        );
        assert_eq!(
            walk_frames(0x1_0000_1000, 0, memory(&[])),
            vec![0x1_0000_1000]
        );
    }

    #[test]
    fn caps_the_frames_and_strips_pointer_authentication_bits() {
        let mut words = Vec::new();
        for i in 0..1000u64 {
            let fp = 0x10_0000 + i * 0x20;
            words.push((fp, fp + 0x20));
            // A signed return address: the top bits are an authentication code.
            words.push((fp + 8, 0x8f2a_0001_0000_0000 | (0x2000 + i)));
        }
        let frames = walk_frames(0x1_0000_1000, 0x10_0000, memory(&words));
        assert_eq!(frames.len(), MAX_FRAMES);
        assert_eq!(frames[1], 0x0001_0000_2000);
        assert!(frames.iter().all(|f| f & !ADDRESS_MASK == 0));
    }

    fn crash() -> Crash {
        Crash {
            reason: "EXC_BAD_ACCESS / KERN_INVALID_ADDRESS".into(),
            mach: Some((1, 1, 0x10)),
            signal: None,
            crashed_thread: Some(7),
            threads: vec![
                ThreadStack {
                    id: 7,
                    // Innermost first: WebKit, called from the app.
                    frames: vec![0x2_0000_0100, 0x1_0000_0200, 0x1_0000_0300],
                },
                ThreadStack {
                    id: 9,
                    frames: vec![0x1_0000_0400],
                },
            ],
            modules: vec![
                Module {
                    path: APP.into(),
                    base: 0x1_0000_0000,
                    size: 0x10_0000,
                    debug_id: Some(DEBUG_ID.parse().unwrap()),
                    code_id: Some("4C4C443655553144A1D27F8A9B0C1D2E".into()),
                },
                Module {
                    path: WEBKIT.into(),
                    base: 0x2_0000_0000,
                    size: 0x10_0000,
                    debug_id: None,
                    code_id: None,
                },
                Module {
                    path: "/Users/alice/Library/Input Methods/Diary 2026.app/x.dylib".into(),
                    base: 0x3_0000_0000,
                    size: 0x1000,
                    debug_id: None,
                    code_id: None,
                },
            ],
            app: Some(0),
            arch: "arm64".into(),
            os_version: Some("26.1.0".into()),
            os_build: Some("25B78".into()),
        }
    }

    fn frames(stack: Option<&Stacktrace>) -> Vec<(u64, Option<&str>, Option<bool>)> {
        stack
            .unwrap()
            .frames
            .iter()
            .map(|f| {
                (
                    f.instruction_addr.unwrap().0,
                    f.package.as_deref(),
                    f.in_app,
                )
            })
            .collect()
    }

    #[test]
    fn a_crash_becomes_a_native_event_of_addresses_and_module_names() {
        let event = event_from_crash(&crash(), "devot@1.2.3", "production");
        assert_eq!(event.level, Level::Fatal);
        assert_eq!(event.platform, "native");
        assert_eq!(event.release.as_deref(), Some("devot@1.2.3"));
        assert_eq!(event.environment.as_deref(), Some("production"));
        let exception = &event.exception.values[0];
        assert_eq!(exception.ty, "EXC_BAD_ACCESS / KERN_INVALID_ADDRESS");
        assert_eq!(exception.value.as_deref(), Some(CRASH_CODE));
        let mechanism = exception.mechanism.as_ref().unwrap();
        assert_eq!(mechanism.handled, Some(false));
        let mach = mechanism.meta.mach_exception.as_ref().unwrap();
        assert_eq!((mach.exception, mach.code, mach.subcode), (1, 1, 0x10));
        // Oldest frame first, the crashing instruction last.
        assert_eq!(
            frames(exception.stacktrace.as_ref()),
            vec![
                (0x1_0000_0300, Some("devot"), Some(true)),
                (0x1_0000_0200, Some("devot"), Some(true)),
                (0x2_0000_0100, Some("WebKit"), Some(false)),
            ]
        );
        assert_eq!(
            exception.thread_id.as_ref().map(ToString::to_string),
            Some("7".into())
        );
        let crashed = event.threads.values.iter().find(|t| t.crashed).unwrap();
        assert_eq!(
            crashed.id.as_ref().map(ToString::to_string),
            Some("7".into())
        );
        let other = event.threads.values.iter().find(|t| !t.crashed).unwrap();
        assert_eq!(
            frames(other.stacktrace.as_ref()),
            vec![(0x1_0000_0400, Some("devot"), Some(true))]
        );
        let Some(Context::Os(os)) = event.contexts.get("os") else {
            panic!("the OS context is set");
        };
        assert_eq!(os.version.as_deref(), Some("26.1.0"));
        let Some(Context::Device(device)) = event.contexts.get("device") else {
            panic!("the device context is set");
        };
        assert_eq!(device.arch.as_deref(), Some("arm64"));
    }

    /// A plug-in bundle loaded above the app comes first in a minidump's
    /// module list; the app's frames are still the in-app ones.
    #[test]
    fn only_the_app_s_own_frames_are_in_app_wherever_it_is_listed() {
        let mut crash = crash();
        let bundle = Module {
            path: "/System/Library/Bundles/Plugin.bundle/Contents/MacOS/Plugin".into(),
            base: 0x4_0000_0000,
            size: 0x1000,
            debug_id: None,
            code_id: None,
        };
        crash.modules.insert(0, bundle);
        crash.app = app_module(&crash.modules, Path::new(APP));
        assert_eq!(crash.app, Some(1));
        crash.threads[1].frames = vec![0x4_0000_0010, 0x1_0000_0400];
        let event = event_from_crash(&crash, "devot@1.2.3", "production");
        assert_eq!(
            frames(event.exception.values[0].stacktrace.as_ref()),
            vec![
                (0x1_0000_0300, Some("devot"), Some(true)),
                (0x1_0000_0200, Some("devot"), Some(true)),
                (0x2_0000_0100, Some("WebKit"), Some(false)),
            ]
        );
        let other = event.threads.values.iter().find(|t| !t.crashed).unwrap();
        assert_eq!(
            frames(other.stacktrace.as_ref()),
            vec![
                (0x1_0000_0400, Some("devot"), Some(true)),
                (0x4_0000_0010, Some("Plugin"), Some(false)),
            ]
        );
        // An app that is not among the modules has no in-app frames.
        crash.app = None;
        let event = event_from_crash(&crash, "devot@1.2.3", "production");
        let stack = event.exception.values[0].stacktrace.as_ref();
        assert!(frames(stack).iter().all(|f| f.2 == Some(false)));
    }

    #[test]
    fn the_app_module_is_found_by_its_path_or_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("devot");
        std::fs::write(&app, b"").unwrap();
        let link = dir.path().join("Devot.app");
        std::fs::create_dir(&link).unwrap();
        let linked = link.join("devot");
        std::os::unix::fs::symlink(&app, &linked).unwrap();
        let other = dir.path().join("other");
        std::fs::write(&other, b"").unwrap();
        let path = |p: &Path| p.to_str().unwrap().to_owned();
        let modules = [
            module("/usr/lib/libobjc.A.dylib", 0x2_0000_0000),
            module(&path(&other), 0x3_0000_0000),
            module(&path(&linked), 0x1_0000_0000),
        ];
        assert_eq!(app_module(&modules, &linked), Some(2));
        // Loaded through a link, known to the system by its real path.
        assert_eq!(app_module(&modules, &app), Some(2));
        assert_eq!(app_module(&modules, Path::new("/missing/devot")), None);
        assert_eq!(app_module(&modules[..2], &app), None);
    }

    #[test]
    fn lists_only_the_modules_a_frame_is_in_by_file_name() {
        let event = event_from_crash(&crash(), "devot@1.2.3", "production");
        let images: Vec<_> = event
            .debug_meta
            .images
            .iter()
            .map(|image| match image {
                DebugImage::Symbolic(image) => (image.name.as_str(), image.image_addr.0, image.id),
                other => panic!("unexpected image {other:?}"),
            })
            .collect();
        assert_eq!(
            images,
            vec![
                ("devot", 0x1_0000_0000, DEBUG_ID.parse().unwrap()),
                ("WebKit", 0x2_0000_0000, DebugId::nil()),
            ]
        );
        let json = serde_json::to_string(&event).unwrap();
        for secret in ["/Users/", "alice", "Diary 2026", "Applications"] {
            assert!(!json.contains(secret), "{secret} survived: {json}");
        }
    }

    /// Note text read as an address, as a stack word or a fault address is
    /// when data is used as a pointer.
    const TEXT_ADDRESS: u64 = u64::from_le_bytes(*b"Diary \0\0");

    fn assert_no_text_address(event: &Event<'static>) {
        let json = serde_json::to_string(event).unwrap();
        for form in [format!("{TEXT_ADDRESS:x}"), TEXT_ADDRESS.to_string()] {
            assert!(!json.contains(&form), "{form} survived: {json}");
        }
    }

    #[test]
    fn frames_outside_every_binary_are_left_out() {
        let mut crash = crash();
        // A jump through a pointer made of text, a null return address and
        // a corrupted chain, around the app's own frames.
        crash.threads[0].frames = vec![TEXT_ADDRESS, 0x2_0000_0100, 0, 0x1_0000_0200, TEXT_ADDRESS];
        crash.threads[1].frames = vec![TEXT_ADDRESS];
        let event = event_from_crash(&crash, "devot@1.2.3", "production");
        assert_eq!(
            frames(event.exception.values[0].stacktrace.as_ref()),
            vec![
                (0x1_0000_0200, Some("devot"), Some(true)),
                (0x2_0000_0100, Some("WebKit"), Some(false)),
            ]
        );
        // A thread with no frame in a binary has no stack trace.
        let other = event.threads.values.iter().find(|t| !t.crashed).unwrap();
        assert!(other.stacktrace.is_none());
        assert_no_text_address(&event);
        assert_no_text_address(&crate::crash_scrub::scrub_event(event));
    }

    #[test]
    fn a_fault_address_outside_every_binary_is_left_out() {
        let fault = |subcode| {
            let crash = Crash {
                mach: Some((1, 1, subcode)),
                ..crash()
            };
            let event = event_from_crash(&crash, "devot@1.2.3", "production");
            assert_no_text_address(&event);
            let mach = event.exception.values[0]
                .mechanism
                .as_ref()
                .unwrap()
                .meta
                .mach_exception
                .clone();
            let images = event.debug_meta.images.len();
            (mach.map(|m| m.subcode), images)
        };
        // A null pointer and an offset.
        assert_eq!(fault(0x10), (Some(0x10), 2));
        // Inside WebKit, which has a frame too.
        assert_eq!(fault(0x2_0000_0010), (Some(0x2_0000_0010), 2));
        // Inside a binary no frame is in: that binary is listed as well.
        assert_eq!(fault(0x3_0000_0010), (Some(0x3_0000_0010), 3));
        // Anywhere else: data used as a pointer.
        assert_eq!(fault(TEXT_ADDRESS), (None, 2));
    }

    #[test]
    fn an_abort_carries_its_signal() {
        let abort = Crash {
            reason: "EXC_SOFTWARE / SIGABRT".into(),
            mach: Some((5, 0x10003, 6)),
            signal: Some(6),
            ..crash()
        };
        let event = event_from_crash(&abort, "devot@1.2.3", "production");
        let meta = &event.exception.values[0].mechanism.as_ref().unwrap().meta;
        let signal = meta.signal.as_ref().unwrap();
        assert_eq!(signal.number, 6);
        assert_eq!(signal.name.as_deref(), Some("SIGABRT"));
    }

    #[test]
    fn saved_reports_are_read_once_newest_first_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let mut ids = Vec::new();
        for _ in 0..7 {
            let event = event_from_crash(&crash(), "devot@1.2.3", "production");
            ids.push(event.event_id);
            save(dir.path(), &event).unwrap();
            // Distinct modification times order the reports.
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        std::fs::write(dir.path().join("x.json.partial"), "{").unwrap();
        std::fs::write(dir.path().join("broken.json"), "not json").unwrap();
        std::fs::write(dir.path().join("keep.txt"), "not a report").unwrap();

        let left = || {
            let mut names: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            names.sort();
            names
        };
        let reports = pending(dir.path());
        let taken: Vec<_> = reports.iter().map(|r| r.event.event_id).collect();
        let newest: Vec<_> = ids.iter().rev().take(MAX_SENT).copied().collect();
        assert_eq!(taken, newest);
        assert_eq!(
            reports[0].event.exception.values[0].value.as_deref(),
            Some(CRASH_CODE)
        );
        // The older reports, the broken one and the partial write are gone;
        // the ones to send stay until they are sent.
        let mut expected: Vec<_> = reports
            .iter()
            .map(|r| r.path.file_name().unwrap().to_str().unwrap().to_string())
            .chain(["keep.txt".to_string()])
            .collect();
        expected.sort();
        assert_eq!(left(), expected);
        // Unsent (the launch ended first): the next launch reads them again.
        assert_eq!(pending(dir.path()).len(), MAX_SENT);
        remove(&reports.iter().map(|r| r.path.clone()).collect::<Vec<_>>());
        assert_eq!(left(), vec!["keep.txt".to_string()]);
        assert!(pending(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_report_is_never_written_through_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        std::fs::write(&theirs, b"theirs").unwrap();
        let event = event_from_crash(&crash(), "devot@1.2.3", "production");
        let id = event.event_id.simple().to_string();
        let partial = dir.path().join(format!("{id}{PARTIAL_SUFFIX}"));
        std::os::unix::fs::symlink(&theirs, &partial).unwrap();
        assert!(save(dir.path(), &event).is_err());
        assert_eq!(std::fs::read(&theirs).unwrap(), b"theirs");
        assert!(std::fs::symlink_metadata(&partial).unwrap().is_symlink());
        assert!(std::fs::symlink_metadata(dir.path().join(format!("{id}{SUFFIX}"))).is_err());
        // A report of its own is saved whole as before.
        let other = event_from_crash(&crash(), "devot@1.2.3", "production");
        let saved = save(dir.path(), &other).unwrap();
        assert!(std::fs::symlink_metadata(&saved).unwrap().is_file());
        assert_eq!(pending(dir.path()).len(), 1);
    }

    fn module(path: &str, base: u64) -> Module {
        Module {
            path: path.into(),
            base,
            size: 0x1000,
            debug_id: None,
            code_id: None,
        }
    }

    #[test]
    fn a_leaf_function_s_caller_comes_from_the_link_register() {
        let modules = [
            module(APP, 0x1_0000_0000),
            module("/usr/lib/libobjc.A.dylib", 0x2_0000_0000),
        ];
        // A crash in objc_msgSend (no frame record) called from the app.
        let mut frames = vec![0x2_0000_0010, 0x1_0000_0900];
        add_leaf_caller(&mut frames, 0x1_0000_0400, &modules);
        assert_eq!(frames, vec![0x2_0000_0010, 0x1_0000_0400, 0x1_0000_0900]);
        // A call through a bad function pointer: no module at all.
        let mut frames = vec![0x0, 0x1_0000_0900];
        add_leaf_caller(&mut frames, 0x1_0000_0400, &modules);
        assert_eq!(frames, vec![0x0, 0x1_0000_0400, 0x1_0000_0900]);
    }

    #[test]
    fn a_link_register_that_points_home_or_nowhere_is_left_out() {
        let modules = [
            module(APP, 0x1_0000_0000),
            module("/usr/lib/libobjc.A.dylib", 0x2_0000_0000),
        ];
        let chain = vec![0x1_0000_0010, 0x1_0000_0900];
        for lr in [
            // Into the crashing binary itself: a stale return address.
            0x1_0000_0400,
            // Not code at all.
            0x7_0000_0000,
            0,
        ] {
            let mut frames = chain.clone();
            add_leaf_caller(&mut frames, lr, &modules);
            assert_eq!(frames, chain, "lr {lr:#x}");
        }
        // Already the next frame.
        let mut frames = vec![0x2_0000_0010, 0x1_0000_0900];
        add_leaf_caller(&mut frames, 0x1_0000_0900, &modules);
        assert_eq!(frames, vec![0x2_0000_0010, 0x1_0000_0900]);
    }

    #[test]
    fn an_abort_trace_starts_where_the_signal_was_raised() {
        let modules = [
            module(APP, 0x1_0000_0000),
            module("/usr/lib/system/libsystem_kernel.dylib", 0x2_0000_0000),
            module("/usr/lib/system/libsystem_platform.dylib", 0x3_0000_0000),
            module("/usr/lib/system/libsystem_c.dylib", 0x4_0000_0000),
        ];
        // Innermost first: the handler waiting, its frames, the trampoline,
        // then abort and the app code that called it.
        let mut frames = vec![
            0x2_0000_0010,
            0x1_0000_0100,
            0x1_0000_0200,
            0x3_0000_0010,
            0x4_0000_0010,
            0x1_0000_0300,
        ];
        trim_signal_handler(&mut frames, &modules, Some(0));
        assert_eq!(frames, vec![0x4_0000_0010, 0x1_0000_0300]);
        // Caught inside a lock function of the trampoline's own library.
        let mut frames = vec![
            0x3_0000_0800,
            0x1_0000_0100,
            0x3_0000_0010,
            0x4_0000_0010,
            0x1_0000_0300,
        ];
        trim_signal_handler(&mut frames, &modules, Some(0));
        assert_eq!(frames, vec![0x4_0000_0010, 0x1_0000_0300]);
        // The handler's frames are the app's, wherever the app is listed.
        let mut listed_later = modules.to_vec();
        listed_later.rotate_left(1);
        let mut frames = vec![
            0x2_0000_0010,
            0x1_0000_0100,
            0x3_0000_0010,
            0x4_0000_0010,
            0x1_0000_0300,
        ];
        trim_signal_handler(&mut frames, &listed_later, Some(3));
        assert_eq!(frames, vec![0x4_0000_0010, 0x1_0000_0300]);
        // Without the app's module the handler's frames cannot be told apart.
        let mut kept = frames.clone();
        kept.insert(0, 0x3_0000_0010);
        kept.insert(0, 0x1_0000_0100);
        let before = kept.clone();
        trim_signal_handler(&mut kept, &modules, None);
        assert_eq!(kept, before);
        // No trampoline after the handler: nothing to trim.
        for kept in [
            vec![0x2_0000_0010, 0x1_0000_0100],
            vec![0x2_0000_0010, 0x1_0000_0100, 0x4_0000_0010, 0x3_0000_0010],
            vec![0x3_0000_0010, 0x4_0000_0010],
        ] {
            let mut frames = kept.clone();
            trim_signal_handler(&mut frames, &modules, Some(0));
            assert_eq!(frames, kept);
        }
    }

    #[test]
    fn the_crashed_thread_is_kept_however_many_threads_there_are() {
        let mut many = crash();
        many.threads = (0..100)
            .map(|id| ThreadStack {
                id,
                frames: vec![0x1_0000_0400],
            })
            .collect();
        many.crashed_thread = Some(99);
        let event = event_from_crash(&many, "devot@1.2.3", "production");
        assert_eq!(event.threads.values.len(), MAX_THREADS);
        assert!(event.threads.values.iter().any(|t| t.crashed));
        assert!(event.exception.values[0].stacktrace.is_some());
    }

    #[test]
    fn a_missing_folder_has_no_reports() {
        let dir = tempfile::tempdir().unwrap();
        assert!(pending(&dir.path().join("crash-reports")).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn without_a_minidump_the_report_names_the_exception_as_with_one() {
        use crash_context::ExceptionInfo;
        let without = |kind, code, subcode| {
            mac::crash_without_dump(Some(ExceptionInfo {
                kind,
                code,
                subcode,
            }))
        };
        let abort = without(5, 0x10003, Some(6));
        assert_eq!(abort.reason, "EXC_SOFTWARE / SIGABRT");
        assert_eq!(abort.signal, Some(6));
        // KERN_INVALID_ADDRESS, as the minidump path names it.
        let bad_access = without(1, 1, Some(0x10));
        assert_eq!(bad_access.reason, "EXC_BAD_ACCESS / KERN_INVALID_ADDRESS");
        assert_eq!(bad_access.mach, Some((1, 1, 0x10)));
        // An EXC_CRASH wrapping a bad access (signal 11) is unwrapped.
        let wrapped = without(10, (11 << 24) | (1 << 20) | 1, Some(0x10));
        assert_eq!(wrapped.reason, "EXC_BAD_ACCESS / KERN_INVALID_ADDRESS");
        assert_eq!(wrapped.mach.map(|m| m.0), Some(1));
        let event = event_from_crash(&bad_access, "devot@1.2.3", "production");
        let exception = &event.exception.values[0];
        assert_eq!(exception.value.as_deref(), Some(CRASH_CODE));
        assert!(exception.stacktrace.is_none());
        assert!(event.debug_meta.images.is_empty());
        assert_eq!(mac::crash_without_dump(None).mach, None);
    }

    #[test]
    fn a_misaligned_link_register_is_no_return_address() {
        let modules = [
            module(APP, 0x1_0000_0000),
            module("/usr/lib/libobjc.A.dylib", 0x2_0000_0000),
        ];
        let mut frames = vec![0x2_0000_0010, 0x1_0000_0900];
        add_leaf_caller(&mut frames, 0x1_0000_0402, &modules);
        assert_eq!(frames, vec![0x2_0000_0010, 0x1_0000_0900]);
    }

    #[test]
    fn reports_older_than_the_limit_are_dropped_unsent() {
        let dir = tempfile::tempdir().unwrap();
        let old = save(
            dir.path(),
            &event_from_crash(&crash(), "devot@1", "production"),
        )
        .unwrap();
        let month_ago = std::time::SystemTime::now() - MAX_AGE - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(month_ago)
            .unwrap();
        let new = save(
            dir.path(),
            &event_from_crash(&crash(), "devot@1", "production"),
        )
        .unwrap();
        let left: Vec<_> = pending(dir.path()).into_iter().map(|r| r.path).collect();
        assert_eq!(left, vec![new]);
        assert!(!old.exists());
    }

    /// A local HTTP server standing in for Sentry: it answers each request
    /// with the next status and passes on what it received.
    fn sentry_stand_in(statuses: Vec<u16>) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for status in statuses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let length = head
                    .lines()
                    .find_map(|l| {
                        let l = l.to_ascii_lowercase();
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                tx.send(format!("{head}\n{}", String::from_utf8_lossy(&body)))
                    .unwrap();
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                )
                .unwrap();
            }
        });
        (format!("http://public@127.0.0.1:{port}/42"), rx)
    }

    fn saved(dir: &Path, count: usize) -> Vec<sentry::types::Uuid> {
        (0..count)
            .map(|_| {
                let event = event_from_crash(&crash(), "devot@1.2.3", "production");
                save(dir, &event).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(15));
                event.event_id
            })
            .collect()
    }

    fn report_count(dir: &Path) -> usize {
        std::fs::read_dir(dir).unwrap().count()
    }

    #[test]
    fn reports_sentry_accepts_are_deleted_and_the_rest_wait() {
        let dir = tempfile::tempdir().unwrap();
        let ids = saved(dir.path(), 3);
        // The newest goes through; then Sentry is rate limited.
        let (dsn, requests) = sentry_stand_in(vec![200, 429]);
        assert_eq!(send_pending(dir.path(), &dsn), 1);
        let first = requests.recv().unwrap();
        assert!(
            first.starts_with("POST /api/42/envelope/ HTTP/1.1"),
            "{first}"
        );
        assert!(
            first
                .to_ascii_lowercase()
                .contains("x-sentry-auth: sentry sentry_key=public")
        );
        assert!(first.contains(&ids[2].simple().to_string()), "{first}");
        assert!(first.contains(CRASH_CODE));
        assert!(!first.contains("/Users/"), "{first}");
        requests.recv().unwrap();
        // Nothing more was tried after the 429; two wait for the next launch.
        assert_eq!(report_count(dir.path()), 2);
    }

    #[test]
    fn a_report_sentry_refuses_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        saved(dir.path(), 1);
        let (dsn, _requests) = sentry_stand_in(vec![400]);
        assert_eq!(send_pending(dir.path(), &dsn), 0);
        assert_eq!(report_count(dir.path()), 0);
    }

    #[test]
    fn without_a_connection_the_reports_wait() {
        let dir = tempfile::tempdir().unwrap();
        saved(dir.path(), 2);
        // A port nothing listens on.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let dsn = format!("http://public@127.0.0.1:{port}/42");
        assert_eq!(send_pending(dir.path(), &dsn), 0);
        assert_eq!(report_count(dir.path()), 2);
        assert_eq!(send_pending(dir.path(), "not a dsn"), 0);
        assert_eq!(report_count(dir.path()), 2);
    }

    #[test]
    fn answers_decide_what_happens_to_a_report() {
        assert_eq!(delivery(Some(200)), Delivery::Accepted);
        assert_eq!(delivery(Some(204)), Delivery::Accepted);
        assert_eq!(delivery(Some(400)), Delivery::Refused);
        assert_eq!(delivery(Some(413)), Delivery::Refused);
        assert_eq!(delivery(Some(429)), Delivery::Later);
        assert_eq!(delivery(Some(503)), Delivery::Later);
        assert_eq!(delivery(None), Delivery::Later);
    }

    #[test]
    fn file_names_drop_folders() {
        assert_eq!(file_name(APP), "devot");
        assert_eq!(file_name("devot"), "devot");
        assert_eq!(file_name(""), "");
    }
}
