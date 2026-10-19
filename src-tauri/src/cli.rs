//! The `devot` command (docs/architecture.md, Command line). The script in
//! the bundle (`cli/devot`) runs this binary with [`FLAG`]. Exit status: 0
//! done, 1 failed, 2 not understood.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager, Runtime};

use crate::{deep_link, import, single_instance, startup, strings};

pub const FLAG: &str = "--cli";
pub(crate) const OPEN_FLAG: &str = "--devot-open";
pub(crate) const MAX_OPEN_FILES: usize = 100;
const MAX_NOTEBOOK_CHARS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Open {
    pub files: Vec<PathBuf>,
    pub notebook: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Input {
    Stdin,
    File(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Format {
    Html,
    Pdf,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Html => "html",
            Format::Pdf => "pdf",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Export {
    pub input: Input,
    pub output: PathBuf,
    pub format: Format,
    pub simple: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Request {
    Help,
    Launch,
    Open(Open),
    Export(Export),
}

/// Why the command was not understood (exit status 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Usage(pub String);

pub(crate) fn fill(template: &str, key: &str, value: &str) -> String {
    template.replace(&format!("{{{key}}}"), value)
}

fn usage(template: &str, key: &str, value: &str) -> Usage {
    Usage(fill(template, key, value))
}

fn notebook_name(name: &str) -> Option<String> {
    let name = name.trim();
    let chars = name.chars().count();
    ((1..=MAX_NOTEBOOK_CHARS).contains(&chars) && !name.chars().any(char::is_control))
        .then(|| name.to_owned())
}

/// `--opt VALUE` or `--opt=VALUE`; moves `at` past what it took.
fn option_value(args: &[String], at: &mut usize, option: &str) -> Result<Option<String>, Usage> {
    let arg = &args[*at];
    if let Some(value) = arg
        .strip_prefix(option)
        .and_then(|rest| rest.strip_prefix('='))
    {
        return Ok(Some(value.to_owned()));
    }
    if arg != option {
        return Ok(None);
    }
    *at += 1;
    args.get(*at)
        .cloned()
        .map(Some)
        .ok_or_else(|| usage(strings::CLI_MISSING_VALUE, "option", option))
}

pub(crate) fn parse(args: &[String], cwd: &Path) -> Result<Request, Usage> {
    let options = args.iter().take_while(|a| *a != "--");
    if options.into_iter().any(|a| a == "-h" || a == "--help") {
        return Ok(Request::Help);
    }
    match args.first().map(String::as_str) {
        None => Ok(Request::Launch),
        Some("export") => parse_export(&args[1..], cwd).map(Request::Export),
        Some(_) => parse_open(args, cwd).map(Request::Open),
    }
}

fn parse_open(args: &[String], cwd: &Path) -> Result<Open, Usage> {
    let mut files = Vec::new();
    let mut notebook = None;
    let mut at = 0;
    let mut options = true;
    while at < args.len() {
        let arg = &args[at];
        if options && arg == "--" {
            options = false;
        } else if options && let Some(name) = option_value(args, &mut at, "--notebook")? {
            notebook = Some(
                notebook_name(&name).ok_or_else(|| Usage(strings::CLI_NOTEBOOK_INVALID.into()))?,
            );
        } else if options && arg.starts_with('-') {
            return Err(usage(strings::CLI_UNKNOWN_OPTION, "option", arg));
        } else {
            files.push(cwd.join(arg));
        }
        at += 1;
    }
    if files.is_empty() {
        return Err(Usage(strings::CLI_OPEN_FILES.into()));
    }
    if files.len() > MAX_OPEN_FILES {
        return Err(usage(
            strings::CLI_TOO_MANY_FILES,
            "max",
            &MAX_OPEN_FILES.to_string(),
        ));
    }
    Ok(Open { files, notebook })
}

fn parse_export(args: &[String], cwd: &Path) -> Result<Export, Usage> {
    let mut inputs = Vec::new();
    let mut output = None;
    let mut simple = false;
    let mut at = 0;
    let mut options = true;
    while at < args.len() {
        let arg = &args[at];
        if options && arg == "--" {
            options = false;
        } else if options && arg == "--simple" {
            simple = true;
        } else if options && let Some(path) = option_value(args, &mut at, "--output")? {
            output = Some(path);
        } else if options && let Some(path) = option_value(args, &mut at, "-o")? {
            output = Some(path);
        } else if options && arg.starts_with('-') && arg != "-" {
            return Err(usage(strings::CLI_UNKNOWN_OPTION, "option", arg));
        } else if arg == "-" {
            inputs.push(Input::Stdin);
        } else {
            inputs.push(Input::File(cwd.join(arg)));
        }
        at += 1;
    }
    let [input] =
        <[Input; 1]>::try_from(inputs).map_err(|_| Usage(strings::CLI_EXPORT_INPUT.into()))?;
    let output = output
        .filter(|o| !o.is_empty())
        .ok_or_else(|| Usage(strings::CLI_EXPORT_OUTPUT.into()))?;
    let format = match Path::new(&output).extension().and_then(|e| e.to_str()) {
        Some(e) if e.eq_ignore_ascii_case("pdf") => Format::Pdf,
        Some(e) if e.eq_ignore_ascii_case("html") => Format::Html,
        _ => return Err(usage(strings::CLI_EXPORT_FORMAT, "path", &output)),
    };
    if simple && format != Format::Html {
        return Err(Usage(strings::CLI_SIMPLE_HTML_ONLY.into()));
    }
    Ok(Export {
        input,
        output: cwd.join(output),
        format,
        simple,
    })
}

fn check_open(open: &Open) -> Result<(), String> {
    for file in &open.files {
        let shown = file.display().to_string();
        if !file.is_file() {
            return Err(fill(strings::CLI_NO_SUCH_FILE, "path", &shown));
        }
        let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !import::is_markdown(name) {
            return Err(fill(strings::CLI_NOT_MARKDOWN, "path", &shown));
        }
    }
    Ok(())
}

pub(crate) fn handoff_args(open: &Open) -> Vec<String> {
    let mut args = vec![OPEN_FLAG.to_owned()];
    if let Some(name) = &open.notebook {
        args.extend(["--notebook".to_owned(), name.clone()]);
    }
    args.push("--".to_owned());
    args.extend(open.files.iter().map(|f| f.to_string_lossy().into_owned()));
    args
}

/// Exactly what [`handoff_args`] writes, after the binary's path; absolute paths only.
pub(crate) fn parse_handoff(args: &[String]) -> Option<Open> {
    let rest = args.get(1..)?.strip_prefix(&[OPEN_FLAG.to_owned()])?;
    let (notebook, rest) = match rest {
        [flag, name, rest @ ..] if flag == "--notebook" => (Some(notebook_name(name)?), rest),
        rest => (None, rest),
    };
    let files = rest.strip_prefix(&["--".to_owned()])?;
    if files.is_empty() || files.len() > MAX_OPEN_FILES {
        return None;
    }
    let files: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
    files
        .iter()
        .all(|f| f.is_absolute())
        .then_some(Open { files, notebook })
}

/// tauri-plugin-single-instance's wire format: `cwd\0\0argv joined by \0`.
fn handoff_message(cwd: &Path, exe: &Path, args: &[String]) -> String {
    let mut message = format!("{}\0\0{}", cwd.to_string_lossy(), exe.to_string_lossy());
    for arg in args {
        message.push('\0');
        message.push_str(arg);
    }
    message
}

fn bundle_of(exe: &Path) -> Option<&Path> {
    let macos = exe.parent().filter(|p| p.ends_with("Contents/MacOS"))?;
    macos
        .parent()?
        .parent()
        .filter(|app| app.extension().is_some_and(|e| e == "app"))
}

/// Writes to the socket ourselves instead of spawning a second instance. A running Devot that
/// does not answer there would ignore `open -a`'s arguments, so that fails instead.
fn hand_off(args: &[String]) -> Result<(), &'static str> {
    let exe = std::env::current_exe().map_err(|_| "E_CLI_APP_NOT_FOUND")?;
    let identifier = crate::data_folder::context().config().identifier.clone();
    let cwd = std::env::current_dir().unwrap_or_default();
    let message = handoff_message(&cwd, &exe, args);
    hand_off_with(
        single_instance::send(&identifier, message.as_bytes()),
        !args.is_empty(),
        || data_folder(&identifier).is_some_and(|dir| startup::folder_held(&dir)),
        || launch_command(&exe, args),
    )
}

fn hand_off_with(
    sent: Result<bool, &'static str>,
    has_args: bool,
    running: impl FnOnce() -> bool,
    launch: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    if sent? {
        return Ok(());
    }
    // With nothing to hand over, launching just brings a running Devot forward.
    if has_args && running() {
        return Err("E_CLI_HANDOFF_UNREACHABLE");
    }
    launch()
}

/// Where Tauri puts `app_data_dir` on macOS.
fn data_folder(identifier: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(
        Path::new(&home)
            .join("Library/Application Support")
            .join(identifier),
    )
}

/// A dev build has no bundle: its own process group keeps the terminal's signals away.
fn launch_command(exe: &Path, args: &[String]) -> Result<(), &'static str> {
    use std::os::unix::process::CommandExt;
    let mut command = match bundle_of(exe) {
        Some(bundle) => {
            let mut open = Command::new("/usr/bin/open");
            open.arg("-a").arg(bundle);
            if !args.is_empty() {
                open.arg("--args").args(args);
            }
            open
        }
        None => {
            let mut binary = Command::new(exe);
            binary.args(args).process_group(0);
            binary
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if bundle_of(exe).is_some() {
        let status = command.status().map_err(|_| "E_CLI_LAUNCH_FAILED")?;
        return status.success().then_some(()).ok_or("E_CLI_LAUNCH_FAILED");
    }
    command.spawn().map(drop).map_err(|_| "E_CLI_LAUNCH_FAILED")
}

pub fn main(args: &[OsString]) -> i32 {
    let args: Option<Vec<String>> = args.iter().map(|a| a.to_str().map(str::to_owned)).collect();
    let Some(args) = args else {
        return not_understood(&Usage(strings::CLI_NOT_UTF8.into()));
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    let request = match parse(&args, &cwd) {
        Ok(request) => request,
        Err(problem) => return not_understood(&problem),
    };
    let launched = match request {
        Request::Help => {
            print!("{}", strings::CLI_USAGE);
            return 0;
        }
        Request::Export(export) => return crate::cli_export::run(export),
        Request::Launch => hand_off(&[]),
        Request::Open(open) => {
            if let Err(message) = check_open(&open) {
                return failed(&message);
            }
            hand_off(&handoff_args(&open))
        }
    };
    launch_status(launched)
}

/// A running Devot that does not take the hand-off (quitting, or not answering) fails the command.
fn launch_status(launched: Result<(), &'static str>) -> i32 {
    match launched {
        Ok(()) => 0,
        Err(
            code @ ("E_CLI_HANDOFF_UNREACHABLE"
            | "E_CLI_HANDOFF_REFUSED"
            | "E_CLI_HANDOFF_UNANSWERED"),
        ) => failed(&fill(strings::CLI_HANDOFF_UNREACHABLE, "code", code)),
        Err(code) => failed(&fill(strings::CLI_LAUNCH_FAILED, "code", code)),
    }
}

pub(crate) fn failed(message: &str) -> i32 {
    eprintln!("devot: {message}");
    1
}

fn not_understood(problem: &Usage) -> i32 {
    eprintln!("devot: {}\n{}", problem.0, strings::CLI_HELP_HINT);
    2
}

/// The scan path of the first file named; `pick_found` makes its folder the first root.
fn first_picked(found: &import::Found, file: &Path) -> Option<String> {
    let real = std::fs::canonicalize(file).ok()?;
    let name = real.file_name()?.to_str()?;
    let root = found
        .roots
        .iter()
        .find(|r| Some(r.path.as_path()) == real.parent())?;
    let path = import::join(&root.prefix, name);
    found.files.iter().any(|f| f.path == path).then_some(path)
}

/// False when `args` are not a hand-off.
pub(crate) fn receive_open<R: Runtime>(app: &AppHandle<R>, args: &[String]) -> bool {
    if args.get(1).map(String::as_str) != Some(OPEN_FLAG) {
        return false;
    }
    let Some(open) = parse_handoff(args) else {
        log::warn!("W_CLI_OPEN_REFUSED");
        return true;
    };
    match import::pick_found(&open.files, false) {
        Ok(found) => {
            let first = first_picked(&found, &open.files[0]);
            let scan = app.state::<import::Imports>().start(found, None);
            log::info!(
                "I_CLI_OPEN {} files={} skipped={}",
                scan.id,
                scan.files.len(),
                scan.skipped.len()
            );
            deep_link::deliver(
                app,
                deep_link::Link::Import {
                    scan,
                    notebook: open.notebook,
                    first,
                },
            );
        }
        Err(code) => log::warn!("W_CLI_OPEN_FAILED {code}"),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    const CWD: &str = "/Users/me/notes";

    fn run(list: &[&str]) -> Result<Request, Usage> {
        parse(&args(list), Path::new(CWD))
    }

    #[test]
    fn no_arguments_launch_and_help_is_asked_anywhere() {
        assert_eq!(run(&[]), Ok(Request::Launch));
        assert_eq!(run(&["--help"]), Ok(Request::Help));
        assert_eq!(run(&["a.md", "-h"]), Ok(Request::Help));
        assert_eq!(run(&["export", "--help"]), Ok(Request::Help));
        assert!(matches!(run(&["--", "-h"]), Ok(Request::Open(_))));
    }

    #[test]
    fn opens_files_from_the_folder_the_command_ran_in() {
        assert_eq!(
            run(&["a.md", "sub/b.md", "/tmp/c.md", "--notebook", " Work "]),
            Ok(Request::Open(Open {
                files: vec![
                    PathBuf::from("/Users/me/notes/a.md"),
                    PathBuf::from("/Users/me/notes/sub/b.md"),
                    PathBuf::from("/tmp/c.md"),
                ],
                notebook: Some("Work".into()),
            }))
        );
        assert_eq!(
            run(&["--notebook=Inbox", "--", "-dash.md"]),
            Ok(Request::Open(Open {
                files: vec![PathBuf::from("/Users/me/notes/-dash.md")],
                notebook: Some("Inbox".into()),
            }))
        );
    }

    #[test]
    fn refuses_what_it_does_not_understand() {
        let refused = |list: &[&str]| run(list).unwrap_err().0;
        assert_eq!(refused(&["-x", "a.md"]), "unknown option -x");
        assert_eq!(refused(&["a.md", "--notebook"]), "--notebook needs a value");
        assert_eq!(refused(&["--notebook", "Work"]), strings::CLI_OPEN_FILES);
        assert_eq!(
            refused(&["a.md", "--notebook", " "]),
            strings::CLI_NOTEBOOK_INVALID
        );
        assert_eq!(
            refused(&["a.md", "--notebook=a\nb"]),
            strings::CLI_NOTEBOOK_INVALID
        );
        let many: Vec<String> = (0..=MAX_OPEN_FILES).map(|i| format!("{i}.md")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(refused(&many), "at most 100 files at a time");
    }

    #[test]
    fn reads_an_export() {
        assert_eq!(
            run(&["export", "a.md", "-o", "out/a.PDF"]),
            Ok(Request::Export(Export {
                input: Input::File(PathBuf::from("/Users/me/notes/a.md")),
                output: PathBuf::from("/Users/me/notes/out/a.PDF"),
                format: Format::Pdf,
                simple: false,
            }))
        );
        assert_eq!(
            run(&["export", "--simple", "-", "--output=/tmp/a.html"]),
            Ok(Request::Export(Export {
                input: Input::Stdin,
                output: PathBuf::from("/tmp/a.html"),
                format: Format::Html,
                simple: true,
            }))
        );
    }

    #[test]
    fn refuses_an_export_it_cannot_make() {
        let refused = |list: &[&str]| run(list).unwrap_err().0;
        assert_eq!(
            refused(&["export", "-o", "a.pdf"]),
            strings::CLI_EXPORT_INPUT
        );
        assert_eq!(
            refused(&["export", "a.md", "b.md", "-o", "a.pdf"]),
            strings::CLI_EXPORT_INPUT
        );
        assert_eq!(refused(&["export", "a.md"]), strings::CLI_EXPORT_OUTPUT);
        assert_eq!(refused(&["export", "a.md", "-o"]), "-o needs a value");
        assert_eq!(
            refused(&["export", "a.md", "-o", "a.docx"]),
            "the output must end in .pdf or .html: a.docx"
        );
        assert_eq!(
            refused(&["export", "a.md", "-o", "a.pdf", "--simple"]),
            strings::CLI_SIMPLE_HTML_ONLY
        );
        assert_eq!(
            refused(&["export", "a.md", "-o", "a.pdf", "--open"]),
            "unknown option --open"
        );
    }

    #[test]
    fn checks_that_the_files_are_markdown_files_there() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("a.md");
        let text = dir.path().join("a.txt");
        std::fs::write(&note, "# A").unwrap();
        std::fs::write(&text, "a").unwrap();
        let open = |files: Vec<PathBuf>| Open {
            files,
            notebook: None,
        };
        assert_eq!(check_open(&open(vec![note.clone()])), Ok(()));
        let missing = dir.path().join("b.md");
        assert_eq!(
            check_open(&open(vec![note.clone(), missing.clone()])),
            Err(format!("no such file: {}", missing.display()))
        );
        assert_eq!(
            check_open(&open(vec![text.clone()])),
            Err(format!(
                "not a Markdown file (.md or .markdown): {}",
                text.display()
            ))
        );
        assert!(check_open(&open(vec![dir.path().to_owned()])).is_err());
    }

    #[test]
    fn a_hand_off_reads_back_as_it_was_written() {
        let open = Open {
            files: vec![PathBuf::from("/a/x.md"), PathBuf::from("/b/-y.md")],
            notebook: Some("Work".into()),
        };
        let mut launch = vec!["/Applications/Devot.app/Contents/MacOS/devot".to_owned()];
        launch.extend(handoff_args(&open));
        assert_eq!(parse_handoff(&launch), Some(open.clone()));
        let plain = Open {
            notebook: None,
            ..open
        };
        let mut launch = vec!["devot".to_owned()];
        launch.extend(handoff_args(&plain));
        assert_eq!(parse_handoff(&launch), Some(plain));
    }

    #[test]
    fn a_hand_off_takes_absolute_paths_and_its_own_shape_only() {
        for list in [
            &["devot"][..],
            &["devot", OPEN_FLAG],
            &["devot", OPEN_FLAG, "--"],
            &["devot", OPEN_FLAG, "/a.md"],
            &["devot", OPEN_FLAG, "--", "a.md"],
            &["devot", OPEN_FLAG, "--notebook", "", "--", "/a.md"],
            &["devot", "devot-dev://note/x", OPEN_FLAG, "--", "/a.md"],
        ] {
            assert_eq!(parse_handoff(&args(list)), None, "{list:?}");
        }
        let mut many = args(&["devot", OPEN_FLAG, "--"]);
        many.extend((0..=MAX_OPEN_FILES).map(|i| format!("/{i}.md")));
        assert_eq!(parse_handoff(&many), None);
    }

    #[test]
    fn writes_a_hand_off_as_the_single_instance_plugin_reads_it() {
        let message = handoff_message(
            Path::new("/Users/me"),
            Path::new("/Applications/Devot.app/Contents/MacOS/devot"),
            &args(&[OPEN_FLAG, "--", "/a.md"]),
        );
        let (cwd, rest) = message.split_once("\0\0").unwrap();
        let read: Vec<&str> = rest.split('\0').collect();
        assert_eq!(cwd, "/Users/me");
        assert_eq!(
            read,
            [
                "/Applications/Devot.app/Contents/MacOS/devot",
                OPEN_FLAG,
                "--",
                "/a.md"
            ]
        );
    }

    #[test]
    fn a_running_devot_that_does_not_take_the_files_fails_the_command() {
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("io.github.jma49.devot.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        // Reads the hand-off as a Devot that is quitting does, and closes it unanswered.
        let reader = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut message = Vec::new();
            stream.read_to_end(&mut message).unwrap();
            message
        });
        let message = b"/w\0\0devot\0--devot-open\0--\0/a.md";
        let uid = crate::atomic_file::effective_uid();
        let sent = single_instance::send_to(&socket, message, uid);
        assert_eq!(reader.join().unwrap(), message);
        let launched = hand_off_with(sent, true, || unreachable!(), || unreachable!());
        assert_eq!(launched, Err("E_CLI_HANDOFF_REFUSED"));
        assert_eq!(launch_status(launched), 1);
        assert_eq!(launch_status(Ok(())), 0);
    }

    #[test]
    fn a_running_devot_that_does_not_answer_fails_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let foreign = dir.path().join("io.github.jma49.devot.sock");
        std::fs::write(&foreign, b"").unwrap();
        let uid = crate::atomic_file::effective_uid();
        let sent = single_instance::send_to(&foreign, b"/w\0\0devot", uid);
        assert_eq!(sent, Ok(false));
        assert_eq!(std::fs::read(&foreign).unwrap(), b"");
        let data = dir.path().join("data");
        let held = startup::take_folder(&data).unwrap();
        assert!(startup::folder_held(&data));
        let mut launched = false;
        assert_eq!(
            hand_off_with(
                sent,
                true,
                || startup::folder_held(&data),
                || {
                    launched = true;
                    Ok(())
                }
            ),
            Err("E_CLI_HANDOFF_UNREACHABLE")
        );
        assert!(!launched);
        drop(held);
        assert!(!startup::folder_held(&data));
        assert_eq!(
            hand_off_with(
                sent,
                true,
                || startup::folder_held(&data),
                || {
                    launched = true;
                    Ok(())
                }
            ),
            Ok(())
        );
        assert!(launched);
        assert_eq!(
            hand_off_with(Ok(true), true, || unreachable!(), || unreachable!()),
            Ok(())
        );
        let held = startup::take_folder(&data).unwrap();
        let mut launched = false;
        assert_eq!(
            hand_off_with(
                sent,
                false,
                || startup::folder_held(&data),
                || {
                    launched = true;
                    Ok(())
                }
            ),
            Ok(())
        );
        assert!(launched);
        drop(held);
        assert_eq!(
            data_folder("io.github.jma49.devot")
                .map(|d| d.ends_with("Library/Application Support/io.github.jma49.devot")),
            Some(true)
        );
    }

    #[test]
    fn finds_the_bundle_a_binary_is_in() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Devot.app/Contents/MacOS/devot")),
            Some(Path::new("/Applications/Devot.app"))
        );
        assert_eq!(
            bundle_of(Path::new("/repo/src-tauri/target/debug/devot")),
            None
        );
        assert_eq!(bundle_of(Path::new("/x/Contents/MacOS/devot")), None);
    }

    #[test]
    fn names_the_scan_path_of_the_first_file() {
        let dir = tempfile::tempdir().unwrap();
        let one = dir.path().join("one");
        let two = dir.path().join("two");
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&two).unwrap();
        for file in [one.join("b.md"), one.join("a.md"), two.join("c.md")] {
            std::fs::write(file, "# x").unwrap();
        }
        let files = [one.join("b.md"), two.join("c.md")];
        let found = import::pick_found(&files, false).unwrap();
        assert_eq!(first_picked(&found, &files[0]).as_deref(), Some("one/b.md"));
        let found = import::pick_found(&files[..1], false).unwrap();
        assert_eq!(first_picked(&found, &files[0]).as_deref(), Some("b.md"));
        // A file the scan left out is no first file.
        let hidden = one.join(".h.md");
        std::fs::write(&hidden, "# h").unwrap();
        let found = import::pick_found(std::slice::from_ref(&hidden), false).unwrap();
        assert_eq!(first_picked(&found, &hidden), None);
    }
}
