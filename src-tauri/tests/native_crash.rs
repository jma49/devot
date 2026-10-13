//! Native crash reports end to end: this binary plays the app (it starts the
//! crash reporter as a second copy of itself, puts note-like text in memory
//! and crashes) and checks what the reporter saved. Each scenario runs in a
//! child process, since a crash ends the process; no harness
//! (`harness = false` in Cargo.toml), so `main` can dispatch on arguments.
//! Nothing is sent anywhere: the app here never starts Sentry.

#[cfg(target_os = "macos")]
mod mac {
    use devot_lib::crash_reporter;
    use std::hint::black_box;
    use std::io::BufRead;
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Any DSN turns native crash reports on; this one is never contacted.
    const TEST_DSN: &str = "https://public@o0.ingest.us.sentry.io/0";
    const NOTE_TEXT: [&str; 3] = ["Grocery list", "buy oat milk", "Diary 2026"];
    /// Note text used as a pointer: where the `text-call` mode jumps.
    const TEXT_ADDRESS: u64 = u64::from_le_bytes(*b"Diary \0\0");
    /// The first bytes of a PNG attachment, and as base64.
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    const PNG_BASE64: &str = "iVBORw0KGgo";
    /// A system plug-in bundle that loads in any process.
    #[cfg(debug_assertions)]
    const BUNDLE: &str =
        "/System/Library/SystemConfiguration/IPConfiguration.bundle/Contents/MacOS/IPConfiguration";

    pub fn main() {
        let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
        if let Some(code) = crash_reporter::reporter_main(&args) {
            std::process::exit(code);
        }
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into()).collect();
        match args.get(1).map(String::as_str) {
            Some("app") => app(&args[2], Path::new(&args[3])),
            Some("measure") => measure(Path::new(&args[2])),
            _ => driver(),
        }
    }

    /// The app side of a scenario.
    fn app(mode: &str, dir: &Path) {
        // By hand, a DSN build of devot can play the reporter instead:
        // `DEVOT_TEST_REPORTER=<path to devot> cargo test --test native_crash`.
        let exe = std::env::var_os("DEVOT_TEST_REPORTER")
            .map_or_else(|| std::env::current_exe().unwrap(), PathBuf::from);
        if mode == "no-dsn" {
            assert!(crash_reporter::start(None, exe.clone(), dir.into()).is_none());
            assert!(crash_reporter::start(Some(""), exe, dir.into()).is_none());
            // Long enough for a reporter to show up, were one started.
            std::thread::sleep(Duration::from_millis(800));
            return;
        }
        let started = crash_reporter::start(Some(TEST_DSN), exe, dir.into()).expect("started");
        assert!(started.join().unwrap(), "the crash handler is attached");
        assert!(devot_lib::native::macos::crash_handler_attached());
        // A plug-in bundle loaded, as AppKit and WebKit load them: the
        // minidump then lists it before the app's own binary.
        #[cfg(debug_assertions)]
        if mode != "exit" {
            assert!(devot_lib::native::macos::load_bundle(Path::new(BUNDLE)));
        }
        println!("reporter {}", crash_reporter::reporter_pid().unwrap());
        if mode == "reporter-gone" {
            // The driver stops the reporter; the handler then lets go.
            let start = Instant::now();
            while devot_lib::native::macos::crash_handler_attached() {
                assert!(start.elapsed() < Duration::from_secs(10), "still attached");
                std::thread::sleep(Duration::from_millis(20));
            }
            println!("detached");
            std::process::abort();
        }
        // Note text and attachment bytes on the heap and on the stack when
        // the app crashes.
        let heap = black_box(format!("{}: {}", NOTE_TEXT[0], NOTE_TEXT[1]));
        let attachment = black_box(PNG.repeat(64));
        let mut stack = [0u8; 32];
        stack[..10].copy_from_slice(NOTE_TEXT[2].as_bytes());
        stack[16..24].copy_from_slice(&PNG);
        black_box(&stack);
        match mode {
            "abort" => std::process::abort(),
            #[cfg(debug_assertions)]
            "bad-access" => devot_lib::native::macos::crash_with_bad_access(),
            // A call through a pointer made of note text: the crash is at
            // that address, and the bad access is there too.
            #[cfg(debug_assertions)]
            "text-call" => {
                devot_lib::native::macos::crash_with_call_to(usize::try_from(TEXT_ADDRESS).unwrap())
            }
            "exit" => {}
            // Idles until a signal from outside ends it, as a running app
            // would; keeps idling if the signal does not.
            "idle" => {
                let start = Instant::now();
                while start.elapsed() < IDLE_LIMIT {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            other => panic!("unknown mode {other}"),
        }
        black_box(heap);
        black_box(attachment);
    }

    struct Run {
        status: std::process::ExitStatus,
        reporter: Option<u32>,
    }

    /// How the app is made to crash.
    #[derive(Clone, Copy)]
    enum Crash {
        /// From inside, by the app's own code (`mode`).
        Inside(&'static str),
        /// From outside: another process sends the idle app this signal.
        Signal(&'static str),
    }

    impl Crash {
        fn mode(self) -> &'static str {
            match self {
                Crash::Inside(mode) => mode,
                Crash::Signal(_) => "idle",
            }
        }

        fn name(self) -> String {
            match self {
                Crash::Inside(mode) => mode.into(),
                Crash::Signal(signal) => format!("kill -{signal}"),
            }
        }
    }

    /// An idle app ends well within this, unless a signal failed to end it.
    const IDLE_LIMIT: Duration = Duration::from_secs(30);

    fn run_app(mode: &'static str, dir: &Path) -> Run {
        run(Crash::Inside(mode), dir)
    }

    /// Starts the app, crashes it as `crash` says once its reporter runs,
    /// and waits for it to end (stopping it if it is still running after
    /// 10 s).
    fn run(crash: Crash, dir: &Path) -> Run {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["app", crash.mode()])
            .arg(dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
        let reporter = stdout
            .lines()
            .map_while(Result::ok)
            .find_map(|l| l.strip_prefix("reporter ").map(str::to_owned))
            .map(|pid| pid.trim().parse().unwrap());
        if let (Crash::Signal(signal), Some(_)) = (crash, reporter) {
            let sent = Command::new("kill")
                .arg(format!("-{signal}"))
                .arg(child.id().to_string())
                .status()
                .unwrap();
            assert!(sent.success(), "kill -{signal}");
        }
        let start = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if start.elapsed() > Duration::from_secs(10) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("{}: the app kept running after the crash", crash.name());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        Run { status, reporter }
    }

    fn alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let start = Instant::now();
        while !done() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "timed out: {what}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|d| d.map(|e| e.unwrap().path()).collect())
            .unwrap_or_default()
    }

    /// Crashes the app and checks the one report the reporter saved.
    fn crash_and_check(crash: Crash, signal: i32, reason: &str) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(crash_reporter::DIR);
        let run = run(crash, &dir);
        let mode = crash.name();
        // The app ends as it would without the handler: by the signal.
        assert_eq!(
            run.status.signal(),
            Some(signal),
            "{mode}: {:?}",
            run.status
        );
        let reporter = run.reporter.expect("the reporter's pid");
        wait_until("the reporter exits", || !alive(reporter));

        // Only the scrubbed report: no minidump, no partial file.
        let saved = files(&dir);
        assert_eq!(saved.len(), 1, "{saved:?}");
        assert_eq!(saved[0].extension().unwrap(), "json");
        let json = std::fs::read_to_string(&saved[0]).unwrap();
        let user = std::env::var("USER").unwrap_or_default();
        assert!(!json.contains("/Users/"), "a home path survived: {json}");
        assert!(
            user.is_empty() || !json.contains(&user),
            "the user name survived"
        );
        for text in NOTE_TEXT {
            assert!(!json.contains(text), "{text} survived");
        }
        // No address made of text, no attachment bytes: only code
        // addresses leave the reporter.
        let png_word = u64::from_le_bytes(PNG);
        for form in [
            format!("{TEXT_ADDRESS:x}"),
            TEXT_ADDRESS.to_string(),
            PNG_BASE64.to_string(),
            format!("{:x}", png_word & 0x0000_7fff_ffff_ffff),
            (png_word & 0x0000_7fff_ffff_ffff).to_string(),
        ] {
            assert!(!json.contains(&form), "{form} survived: {json}");
        }

        let reports = crash_reporter::pending(&dir);
        assert_eq!(reports.len(), 1);
        crash_reporter::remove(&[reports[0].path.clone()]);
        assert!(files(&dir).is_empty(), "sent reports are deleted");
        let event = &reports[0].event;
        assert_eq!(event.level, sentry::Level::Fatal);
        let exception = &event.exception.values[0];
        assert!(exception.ty.contains(reason), "{}", exception.ty);
        assert_eq!(exception.value.as_deref(), Some(crash_reporter::CRASH_CODE));
        let frames = &exception.stacktrace.as_ref().expect("a stack trace").frames;
        assert!(frames.len() >= 2, "{frames:?}");
        // Every frame is an address in a named binary, and some are the app's.
        assert!(frames.iter().all(|f| f.instruction_addr.is_some()));
        let this = std::env::current_exe().unwrap();
        let this = this.file_name().unwrap().to_str().unwrap();
        assert!(
            frames.iter().any(|f| f.package.as_deref() == Some(this)),
            "no frame in {this}: {frames:?}"
        );
        // The app's own frames, and only those, are in-app.
        for thread in std::iter::once(frames).chain(
            event
                .threads
                .values
                .iter()
                .filter_map(|t| t.stacktrace.as_ref().map(|s| &s.frames)),
        ) {
            for frame in thread {
                let in_app = frame.package.as_deref() == Some(this);
                assert_eq!(frame.in_app, Some(in_app), "{frame:?}");
            }
        }
        // The trace starts where the crash happened, not in the handler:
        // an abort in libc's abort, a signal from outside where it found
        // the app (waiting in the kernel), a bad access in the app's own
        // function (for a call to no code, the function that called).
        let innermost = frames.last().unwrap();
        let in_handler_wait = !matches!(mode.as_str(), "bad-access" | "text-call");
        assert_eq!(
            innermost.in_app,
            Some(!in_handler_wait),
            "innermost frame: {innermost:?}"
        );
        if in_handler_wait {
            // The handler of a SIGABRT waits in the kernel too, so the
            // innermost frame alone cannot tell a trimmed trace from one
            // that starts in the handler. Untrimmed, the trace holds the
            // signal trampoline and, innermost first, the handler's in-app
            // frames.
            assert!(
                frames
                    .iter()
                    .all(|f| f.package.as_deref() != Some("libsystem_platform.dylib")),
                "the signal trampoline is still in the trace: {frames:?}"
            );
        }
        if mode == "abort" {
            let before_abort: Vec<_> = frames
                .iter()
                .rev()
                .take_while(|f| f.package.as_deref() != Some("libsystem_c.dylib"))
                .collect();
            assert!(
                before_abort.len() < frames.len(),
                "no frame in libc's abort: {frames:?}"
            );
            assert!(
                before_abort.iter().all(|f| f.in_app == Some(false)),
                "handler frames above libc's abort: {frames:?}"
            );
        }
        assert!(event.debug_meta.images.iter().all(|image| match image {
            sentry::protocol::DebugImage::Symbolic(image) => !image.name.contains('/'),
            _ => false,
        }));
        println!(
            "native_crash: {mode} saved one scrubbed report ({} frames, {} bytes)",
            frames.len(),
            json.len()
        );
    }

    fn driver() {
        // Without a DSN nothing starts: no process, no folder.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(crash_reporter::DIR);
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["app", "no-dsn"])
            .arg(&dir)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let children = Command::new("pgrep")
            .args(["-P", &child.id().to_string()])
            .output()
            .unwrap();
        assert!(
            children.stdout.is_empty(),
            "a process started without a DSN"
        );
        assert!(child.wait_with_output().unwrap().status.success());
        assert!(!dir.exists(), "a folder was created without a DSN");
        println!("native_crash: no reporter process without a DSN");

        // A reporter that has gone leaves no handler behind: an abort then
        // takes the default course, with no report and no wait.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["app", "reporter-gone"])
            .arg(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
        let reporter = lines
            .find_map(|l| l.unwrap().strip_prefix("reporter ").map(str::to_owned))
            .expect("the reporter's pid");
        assert!(
            Command::new("kill")
                .args(["-KILL", &reporter])
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(
            lines.next().map(Result::unwrap).as_deref(),
            Some("detached")
        );
        let status = child.wait().unwrap();
        assert_eq!(status.signal(), Some(libc_signal("ABRT")), "{status:?}");
        assert!(files(&dir).is_empty(), "a report without a reporter");
        println!("native_crash: the handler detaches once the reporter has gone");

        // A normal exit ends the reporter and leaves no report.
        let run = run_app("exit", &dir);
        assert!(run.status.success());
        let reporter = run.reporter.expect("the reporter's pid");
        wait_until("the reporter exits with the app", || !alive(reporter));
        assert!(files(&dir).is_empty());
        println!("native_crash: the reporter exits with the app");

        crash_and_check(Crash::Inside("abort"), libc_signal("ABRT"), "SIGABRT");
        // A SIGABRT from another process ends the app too, once reported.
        crash_and_check(Crash::Signal("ABRT"), libc_signal("ABRT"), "SIGABRT");
        #[cfg(debug_assertions)]
        crash_and_check(
            Crash::Inside("bad-access"),
            libc_signal("SEGV"),
            "EXC_BAD_ACCESS",
        );
        #[cfg(debug_assertions)]
        crash_and_check(
            Crash::Inside("text-call"),
            libc_signal("SEGV"),
            "EXC_BAD_ACCESS",
        );
    }

    /// By hand, for docs/architecture.md: how long the reporter takes to be
    /// ready and what it costs while it waits, for a given app binary (built
    /// with a DSN, or it refuses to start as a reporter):
    /// `cargo test --test native_crash -- measure <path to devot>`.
    fn measure(exe: &Path) {
        let tmp = tempfile::tempdir().unwrap();
        let start = Instant::now();
        let started = crash_reporter::start(Some(TEST_DSN), exe.into(), tmp.path().join("r"));
        // What the app's launch waits for: the rest runs on that thread.
        let returned = start.elapsed();
        assert!(started.unwrap().join().unwrap(), "the reporter started");
        let ready = start.elapsed();
        let pid = crash_reporter::reporter_pid().unwrap().to_string();
        // Let it settle into its wait.
        std::thread::sleep(Duration::from_secs(2));
        let ps = Command::new("ps")
            .args(["-o", "rss=,%cpu=,time=", "-p", &pid])
            .output()
            .unwrap();
        let footprint = Command::new("footprint").arg(&pid).output().unwrap();
        let footprint = String::from_utf8_lossy(&footprint.stdout);
        let summary = footprint
            .lines()
            .find(|l| l.contains("Footprint:"))
            .unwrap_or("Footprint: unavailable");
        // Wakeups and CPU over five seconds of waiting (the second sample).
        let top = Command::new("top")
            .args([
                "-l",
                "2",
                "-s",
                "5",
                "-pid",
                &pid,
                "-stats",
                "pid,cpu,idlew,power",
            ])
            .output()
            .unwrap();
        let top = String::from_utf8_lossy(&top.stdout);
        let idle = top.lines().last().unwrap_or("").trim().to_string();
        println!("start returns in {} us", returned.as_micros());
        println!("ready in {} ms", ready.as_millis());
        println!("pid, cpu %, idle wakeups, power (top, 5 s): {idle}");
        println!(
            "rss KiB, cpu %, cpu time: {}",
            String::from_utf8_lossy(&ps.stdout).trim()
        );
        println!("{}", summary.trim());
    }

    /// Signal numbers on macOS, without a libc dependency in the tests.
    fn libc_signal(name: &str) -> i32 {
        match name {
            "ABRT" => 6,
            "SEGV" => 11,
            _ => unreachable!(),
        }
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    mac::main();
    #[cfg(not(target_os = "macos"))]
    println!("native_crash: skipped (native crash reports are macOS only)");
}
