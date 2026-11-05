//! The `devot` command (docs/specs/command-line.md). The script in
//! the bundle (`cli/devot`) runs this binary with [`FLAG`]. Exit status: 0
//! done, 1 failed, 2 not understood.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::commands::notes::{MAX_TITLE_CHARS, valid_note_id};
use crate::single_instance::Answered;
use crate::{deep_link, import, single_instance, startup, strings};

pub const FLAG: &str = "--cli";
pub(crate) const OPEN_FLAG: &str = "--devot-open";
/// A hand-off of `devot append`, answered with its outcome (`cli_append`).
pub(crate) const APPEND_FLAG: &str = "--devot-append";
/// As the first argument: a launch the MCP bridge asked for (`background`).
pub(crate) const BACKGROUND_FLAG: &str = "--devot-background";
pub(crate) const MAX_OPEN_FILES: usize = 100;
const MAX_NOTEBOOK_CHARS: usize = 200;
/// MAX_HEADING_CHARS in `src/core/append.ts`.
const MAX_HEADING_CHARS: usize = 500;
/// Well within the socket's message limit (`single_instance::MAX_MESSAGE`).
pub(crate) const MAX_APPEND_BYTES: usize = 512 * 1024;
/// An append waits for a window to be ready and runs through it before it is answered
/// (`cli_append::ANSWER_TIMEOUT`, 30 s).
const APPEND_ANSWER_TIMEOUT: Duration = Duration::from_secs(35);

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

/// The note `devot append` names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    Id(String),
    Title(String),
    /// Today's note, made when missing, as Open Today's Note does.
    Today,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Position {
    Append,
    Prepend,
}

impl Position {
    pub fn as_str(self) -> &'static str {
        match self {
            Position::Append => "append",
            Position::Prepend => "prepend",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "append" => Some(Position::Append),
            "prepend" => Some(Position::Prepend),
            _ => None,
        }
    }
}

/// What `devot append` hands over, its text read already.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Append {
    pub target: Target,
    pub heading: Option<String>,
    pub position: Position,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AppendText {
    Given(String),
    Stdin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppendCommand {
    pub target: Target,
    pub heading: Option<String>,
    pub position: Position,
    pub text: AppendText,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Request {
    Help,
    Launch,
    Open(Open),
    Export(Export),
    Append(AppendCommand),
    /// The MCP bridge over stdio (`mcp_bridge`).
    Mcp,
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

fn one_line(text: &str, max_chars: usize) -> Option<String> {
    let text = text.trim();
    let chars = text.chars().count();
    ((1..=max_chars).contains(&chars) && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

fn notebook_name(name: &str) -> Option<String> {
    one_line(name, MAX_NOTEBOOK_CHARS)
}

fn heading_text(heading: &str) -> Option<String> {
    one_line(heading, MAX_HEADING_CHARS)
}

fn title_text(title: &str) -> Option<String> {
    one_line(title, MAX_TITLE_CHARS)
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
        Some("append") => parse_append(&args[1..]).map(Request::Append),
        Some("mcp") if args.len() == 1 => Ok(Request::Mcp),
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

/// A list item's text (`- done`) or a lone `-` is text, not an option.
fn looks_like_option(arg: &str) -> bool {
    arg.starts_with('-') && arg.chars().nth(1).is_some_and(|c| !c.is_whitespace())
}

fn parse_append(args: &[String]) -> Result<AppendCommand, Usage> {
    let mut positional = Vec::new();
    let mut title = None;
    let mut today = false;
    let mut heading = None;
    let mut position = Position::Append;
    let mut stdin = false;
    let mut at = 0;
    let mut options = true;
    while at < args.len() {
        let arg = &args[at];
        if options && arg == "--" {
            options = false;
        } else if options && arg == "--prepend" {
            position = Position::Prepend;
        } else if options && arg == "--stdin" {
            stdin = true;
        } else if options && arg == "--today" {
            today = true;
        } else if options && let Some(text) = option_value(args, &mut at, "--title")? {
            title = Some(
                title_text(&text).ok_or_else(|| Usage(strings::CLI_APPEND_TITLE_INVALID.into()))?,
            );
        } else if options && let Some(text) = option_value(args, &mut at, "--heading")? {
            heading = Some(
                heading_text(&text)
                    .ok_or_else(|| Usage(strings::CLI_APPEND_HEADING_INVALID.into()))?,
            );
        } else if options && looks_like_option(arg) {
            return Err(usage(strings::CLI_UNKNOWN_OPTION, "option", arg));
        } else {
            positional.push(arg.clone());
        }
        at += 1;
    }
    let mut positional = positional.into_iter();
    let target = match (title, today) {
        (Some(_), true) => return Err(Usage(strings::CLI_APPEND_TARGET.into())),
        (Some(title), false) => Target::Title(title),
        (None, true) => Target::Today,
        (None, false) => {
            let id = positional
                .next()
                .ok_or_else(|| Usage(strings::CLI_APPEND_TARGET.into()))?;
            if !valid_note_id(&id) {
                return Err(usage(strings::CLI_APPEND_NOTE_ID, "id", &id));
            }
            Target::Id(id)
        }
    };
    let text = match (positional.next(), stdin) {
        (Some(text), false) => AppendText::Given(text),
        (None, true) => AppendText::Stdin,
        _ => return Err(Usage(strings::CLI_APPEND_TEXT.into())),
    };
    if positional.next().is_some() {
        return Err(Usage(strings::CLI_APPEND_TEXT.into()));
    }
    Ok(AppendCommand {
        target,
        heading,
        position,
        text,
    })
}

/// The text as it goes over the socket: not empty, within the limit, and without the byte that
/// ends an argument there.
fn check_append_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(strings::CLI_APPEND_TEXT_EMPTY.into());
    }
    if text.len() > MAX_APPEND_BYTES {
        return Err(strings::CLI_APPEND_TEXT_TOO_LARGE.into());
    }
    if text.contains('\0') {
        return Err(strings::CLI_APPEND_TEXT_NUL.into());
    }
    Ok(())
}

fn read_stdin() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_APPEND_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| strings::CLI_READ_STDIN_FAILED.to_owned())?;
    if bytes.len() > MAX_APPEND_BYTES {
        return Err(strings::CLI_APPEND_TEXT_TOO_LARGE.into());
    }
    String::from_utf8(bytes).map_err(|_| strings::CLI_APPEND_NOT_TEXT.to_owned())
}

pub(crate) fn append_handoff_args(append: &Append) -> Vec<String> {
    let mut args = vec![APPEND_FLAG.to_owned()];
    match &append.target {
        Target::Id(id) => args.extend(["--id".to_owned(), id.clone()]),
        Target::Title(title) => args.extend(["--title".to_owned(), title.clone()]),
        Target::Today => args.push("--today".to_owned()),
    }
    if let Some(heading) = &append.heading {
        args.extend(["--heading".to_owned(), heading.clone()]);
    }
    args.extend(["--position".to_owned(), append.position.as_str().to_owned()]);
    args.push("--".to_owned());
    args.push(append.text.clone());
    args
}

/// Exactly what [`append_handoff_args`] writes, after the binary's path.
pub(crate) fn parse_append_handoff(args: &[String]) -> Option<Append> {
    let rest = args.get(1..)?.strip_prefix(&[APPEND_FLAG.to_owned()])?;
    let (target, rest) = match rest {
        [flag, id, rest @ ..] if flag == "--id" && valid_note_id(id) => {
            (Target::Id(id.clone()), rest)
        }
        [flag, title, rest @ ..] if flag == "--title" => (Target::Title(title_text(title)?), rest),
        [flag, rest @ ..] if flag == "--today" => (Target::Today, rest),
        _ => return None,
    };
    let (heading, rest) = match rest {
        [flag, heading, rest @ ..] if flag == "--heading" => (Some(heading_text(heading)?), rest),
        rest => (None, rest),
    };
    let [flag, position, dash, text] = rest else {
        return None;
    };
    if flag != "--position" || dash != "--" {
        return None;
    }
    let position = Position::parse(position)?;
    check_append_text(text).ok()?;
    Some(Append {
        target,
        heading,
        position,
        text: text.clone(),
    })
}

/// False when `args` are not a hand-off of `devot append`.
pub(crate) fn hands_off_append(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some(APPEND_FLAG)
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

/// Why a hand-off did not go through: a code of this command's own, or the outcome the running
/// Devot answered a request with (`Answered::Refused`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Failure {
    Code(&'static str),
    Refused(String),
}

/// Writes to the socket ourselves instead of spawning a second instance. Devot ignores `open -a`'s
/// arguments while it runs, even while another call is still launching it, so the files always go
/// through the socket: a running Devot that does not answer there fails the command, and one this
/// call launches gets them once it listens.
fn hand_off(args: &[String]) -> Result<(), &'static str> {
    let exe = std::env::current_exe().map_err(|_| "E_CLI_APP_NOT_FOUND")?;
    let identifier = crate::data_folder::context().config().identifier.clone();
    let cwd = std::env::current_dir().unwrap_or_default();
    let message = handoff_message(&cwd, &exe, args);
    let send = || single_instance::send(&identifier, message.as_bytes());
    hand_off_with(
        send(),
        !args.is_empty(),
        || data_folder(&identifier).is_some_and(|dir| startup::folder_held(&dir)),
        || launch_command(&exe),
        send,
        LAUNCH_ANSWER_TIMEOUT,
    )
}

/// As `hand_off`, for a request the running Devot answers with its outcome.
fn hand_off_append(append: &Append) -> Result<(), Failure> {
    let exe = std::env::current_exe().map_err(|_| Failure::Code("E_CLI_APP_NOT_FOUND"))?;
    let identifier = crate::data_folder::context().config().identifier.clone();
    let cwd = std::env::current_dir().unwrap_or_default();
    let message = handoff_message(&cwd, &exe, &append_handoff_args(append));
    let send =
        || single_instance::send_answered(&identifier, message.as_bytes(), APPEND_ANSWER_TIMEOUT);
    hand_off_answered(
        send(),
        true,
        || data_folder(&identifier).is_some_and(|dir| startup::folder_held(&dir)),
        || launch_command(&exe),
        send,
        LAUNCH_ANSWER_TIMEOUT,
    )
}

/// A first launch can wait on the system checking the app before it runs.
const LAUNCH_ANSWER_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_POLL: Duration = Duration::from_millis(50);

fn hand_off_with(
    sent: Result<bool, &'static str>,
    has_args: bool,
    running: impl FnOnce() -> bool,
    launch: impl FnOnce() -> Result<(), &'static str>,
    mut send_again: impl FnMut() -> Result<bool, &'static str>,
    within: Duration,
) -> Result<(), &'static str> {
    let taken = |sent: bool| {
        if sent {
            Answered::Taken
        } else {
            Answered::NoListener
        }
    };
    match hand_off_answered(
        sent.map(taken),
        has_args,
        running,
        launch,
        || send_again().map(taken),
        within,
    ) {
        Ok(()) => Ok(()),
        Err(Failure::Code(code)) => Err(code),
        Err(Failure::Refused(_)) => Err("E_CLI_HANDOFF_REFUSED"),
    }
}

fn hand_off_answered(
    sent: Result<Answered, &'static str>,
    has_args: bool,
    running: impl FnOnce() -> bool,
    launch: impl FnOnce() -> Result<(), &'static str>,
    mut send_again: impl FnMut() -> Result<Answered, &'static str>,
    within: Duration,
) -> Result<(), Failure> {
    let outcome = |answered: Answered| match answered {
        Answered::NoListener => None,
        Answered::Taken => Some(Ok(())),
        Answered::Refused(code) => Some(Err(Failure::Refused(code))),
    };
    if let Some(done) = outcome(sent.map_err(Failure::Code)?) {
        return done;
    }
    // With nothing to hand over, launching just brings a running Devot forward.
    if !has_args {
        return launch().map_err(Failure::Code);
    }
    if running() {
        return Err(Failure::Code("E_CLI_HANDOFF_UNREACHABLE"));
    }
    launch().map_err(Failure::Code)?;
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        std::thread::sleep(LAUNCH_POLL);
        if let Some(done) = outcome(send_again().map_err(Failure::Code)?) {
            return done;
        }
    }
    Err(Failure::Code("E_CLI_LAUNCH_UNANSWERED"))
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
fn launch_command(exe: &Path) -> Result<(), &'static str> {
    use std::os::unix::process::CommandExt;
    let mut command = match bundle_of(exe) {
        Some(bundle) => {
            let mut open = Command::new("/usr/bin/open");
            open.arg("-a").arg(bundle);
            open
        }
        None => {
            let mut binary = Command::new(exe);
            binary.process_group(0);
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

/// Starts this Devot with no window and without taking the focus, for the MCP bridge. Launch
/// Services keeps it from being the client's child, so it outlives the client that asked.
#[cfg(desktop)]
pub(crate) fn launch_in_background() -> Result<(), &'static str> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|_| "E_MCP_START_FAILED")?;
    let mut command = match bundle_of(&exe) {
        Some(bundle) => {
            let mut open = Command::new("/usr/bin/open");
            open.arg("-g")
                .arg("-a")
                .arg(bundle)
                .arg("--args")
                .arg(BACKGROUND_FLAG);
            open
        }
        None => {
            let mut binary = Command::new(&exe);
            binary.arg(BACKGROUND_FLAG).process_group(0);
            binary
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if bundle_of(&exe).is_some() {
        let status = command.status().map_err(|_| "E_MCP_START_FAILED")?;
        return status.success().then_some(()).ok_or("E_MCP_START_FAILED");
    }
    command.spawn().map(drop).map_err(|_| "E_MCP_START_FAILED")
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
        #[cfg(desktop)]
        Request::Mcp => return crate::mcp_bridge::run(),
        #[cfg(mobile)]
        Request::Mcp => return not_understood(&Usage(strings::CLI_OPEN_FILES.into())),
        Request::Launch => hand_off(&[]),
        Request::Open(open) => {
            if let Err(message) = check_open(&open) {
                return failed(&message);
            }
            hand_off(&handoff_args(&open))
        }
        Request::Append(command) => {
            let text = match command.text {
                AppendText::Given(text) => text,
                AppendText::Stdin => match read_stdin() {
                    Ok(text) => text,
                    Err(message) => return failed(&message),
                },
            };
            if let Err(message) = check_append_text(&text) {
                return failed(&message);
            }
            let append = Append {
                target: command.target,
                heading: command.heading,
                position: command.position,
                text,
            };
            return append_status(hand_off_append(&append));
        }
    };
    launch_status(launched)
}

/// The outcome the running Devot answered, by its code; the hand-off's own codes as `launch_status`.
fn append_status(appended: Result<(), Failure>) -> i32 {
    match appended {
        Ok(()) => 0,
        Err(Failure::Code(code)) => launch_status(Err(code)),
        Err(Failure::Refused(code)) => failed(&append_message(&code)),
    }
}

fn append_message(code: &str) -> String {
    let template = match code {
        "E_HEADING_NOT_FOUND" => strings::CLI_APPEND_HEADING_NOT_FOUND,
        "E_NOTE_NOT_FOUND" => strings::CLI_APPEND_NOTE_NOT_FOUND,
        "E_NOTE_TITLE_AMBIGUOUS" => strings::CLI_APPEND_TITLE_AMBIGUOUS,
        "E_LICENCE_REQUIRED" => strings::CLI_APPEND_READ_ONLY,
        _ => strings::CLI_APPEND_FAILED,
    };
    fill(template, "code", code)
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
pub(crate) fn hands_off_files(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some(OPEN_FLAG)
}

pub(crate) fn receive_open<R: Runtime>(app: &AppHandle<R>, args: &[String]) -> bool {
    if !hands_off_files(args) {
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
    fn reads_the_mcp_bridge_and_nothing_after_it() {
        assert_eq!(run(&["mcp"]), Ok(Request::Mcp));
        assert_eq!(run(&["mcp", "--help"]), Ok(Request::Help));
        assert!(matches!(run(&["mcp", "x"]), Ok(Request::Open(_))));
    }

    #[test]
    fn a_background_launch_is_not_a_hand_off_of_files() {
        assert!(!hands_off_files(&args(&["devot", BACKGROUND_FLAG])));
        assert_eq!(parse_handoff(&args(&["devot", BACKGROUND_FLAG])), None);
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

    const NOTE_ID: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    #[test]
    fn reads_an_append() {
        assert_eq!(
            run(&["append", NOTE_ID, "--heading", "Log", "- done"]),
            Ok(Request::Append(AppendCommand {
                target: Target::Id(NOTE_ID.into()),
                heading: Some("Log".into()),
                position: Position::Append,
                text: AppendText::Given("- done".into()),
            }))
        );
        assert_eq!(
            run(&["append", "--title", " Day ", "--prepend", "--stdin"]),
            Ok(Request::Append(AppendCommand {
                target: Target::Title("Day".into()),
                heading: None,
                position: Position::Prepend,
                text: AppendText::Stdin,
            }))
        );
        assert_eq!(
            run(&["append", "--today", "--heading", "Log", "- done"]),
            Ok(Request::Append(AppendCommand {
                target: Target::Today,
                heading: Some("Log".into()),
                position: Position::Append,
                text: AppendText::Given("- done".into()),
            }))
        );
        assert_eq!(
            run(&["append", NOTE_ID, "-"]).map(|r| match r {
                Request::Append(a) => a.text,
                _ => unreachable!(),
            }),
            Ok(AppendText::Given("-".into()))
        );
        assert_eq!(
            run(&["append", "--heading=## Log", NOTE_ID, "--", "-dash"]),
            Ok(Request::Append(AppendCommand {
                target: Target::Id(NOTE_ID.into()),
                heading: Some("## Log".into()),
                position: Position::Append,
                text: AppendText::Given("-dash".into()),
            }))
        );
    }

    #[test]
    fn refuses_an_append_it_cannot_make() {
        let refused = |list: &[&str]| run(list).unwrap_err().0;
        assert_eq!(refused(&["append"]), strings::CLI_APPEND_TARGET);
        assert_eq!(refused(&["append", "nope", "x"]), "not a note ID: nope");
        assert_eq!(refused(&["append", NOTE_ID]), strings::CLI_APPEND_TEXT);
        assert_eq!(
            refused(&["append", NOTE_ID, "a", "b"]),
            strings::CLI_APPEND_TEXT
        );
        assert_eq!(
            refused(&["append", NOTE_ID, "--stdin", "a"]),
            strings::CLI_APPEND_TEXT
        );
        assert_eq!(
            refused(&["append", "--today", "--title", "Day", "a"]),
            strings::CLI_APPEND_TARGET
        );
        assert_eq!(
            refused(&["append", "--today", NOTE_ID, "a"]),
            strings::CLI_APPEND_TEXT
        );
        assert_eq!(
            refused(&["append", "--title", "", "a"]),
            strings::CLI_APPEND_TITLE_INVALID
        );
        assert_eq!(
            refused(&["append", NOTE_ID, "--heading", "a\nb", "x"]),
            strings::CLI_APPEND_HEADING_INVALID
        );
        assert_eq!(
            refused(&["append", NOTE_ID, "--heading"]),
            "--heading needs a value"
        );
        assert_eq!(
            refused(&["append", NOTE_ID, "-x", "a"]),
            "unknown option -x"
        );
        assert_eq!(
            check_append_text(" \n"),
            Err(strings::CLI_APPEND_TEXT_EMPTY.into())
        );
        assert_eq!(
            check_append_text(&"a".repeat(MAX_APPEND_BYTES + 1)),
            Err(strings::CLI_APPEND_TEXT_TOO_LARGE.into())
        );
        assert_eq!(
            check_append_text("a\0b"),
            Err(strings::CLI_APPEND_TEXT_NUL.into())
        );
        assert_eq!(check_append_text("- ok\n"), Ok(()));
    }

    #[test]
    fn an_append_hand_off_reads_back_as_it_was_written_and_takes_its_own_shape_only() {
        let append = Append {
            target: Target::Title("Day".into()),
            heading: Some("Log".into()),
            position: Position::Prepend,
            text: "- one\n- two".into(),
        };
        let mut launch = vec!["devot".to_owned()];
        launch.extend(append_handoff_args(&append));
        assert!(hands_off_append(&launch));
        assert!(!hands_off_files(&launch));
        assert_eq!(parse_append_handoff(&launch), Some(append));
        let plain = Append {
            target: Target::Id(NOTE_ID.into()),
            heading: None,
            position: Position::Append,
            text: "x".into(),
        };
        let mut launch = vec!["devot".to_owned()];
        launch.extend(append_handoff_args(&plain));
        assert_eq!(parse_append_handoff(&launch), Some(plain));
        let today = Append {
            target: Target::Today,
            heading: None,
            position: Position::Append,
            text: "x".into(),
        };
        let mut launch = vec!["devot".to_owned()];
        launch.extend(append_handoff_args(&today));
        assert_eq!(parse_append_handoff(&launch), Some(today));
        for list in [
            &["devot"][..],
            &["devot", APPEND_FLAG],
            &[
                "devot",
                APPEND_FLAG,
                "--id",
                "nope",
                "--position",
                "append",
                "--",
                "x",
            ],
            &[
                "devot",
                APPEND_FLAG,
                "--id",
                NOTE_ID,
                "--position",
                "middle",
                "--",
                "x",
            ],
            &[
                "devot",
                APPEND_FLAG,
                "--id",
                NOTE_ID,
                "--position",
                "append",
                "x",
            ],
            &[
                "devot",
                APPEND_FLAG,
                "--id",
                NOTE_ID,
                "--position",
                "append",
                "--",
                " ",
            ],
            &[
                "devot",
                APPEND_FLAG,
                "--title",
                "",
                "--position",
                "append",
                "--",
                "x",
            ],
            &[
                "devot",
                APPEND_FLAG,
                "--id",
                NOTE_ID,
                "--heading",
                "",
                "--position",
                "append",
                "--",
                "x",
            ],
            &[
                "devot",
                APPEND_FLAG,
                "--id",
                NOTE_ID,
                "--position",
                "append",
                "--",
                "x",
                "y",
            ],
        ] {
            assert_eq!(parse_append_handoff(&args(list)), None, "{list:?}");
        }
    }

    /// A Devot that runs the request and answers with its outcome, as the single-instance listener does.
    fn answering(socket: &Path, outcome: &'static [u8]) -> std::thread::JoinHandle<Vec<u8>> {
        use std::io::{Read, Write};
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut message = Vec::new();
            loop {
                let mut byte = [0u8; 1];
                match stream.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => {
                        message.push(byte[0]);
                        if message.ends_with(b"\0--\0- done") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            stream.write_all(outcome).unwrap();
            message
        })
    }

    #[test]
    fn an_append_goes_through_the_socket_and_fails_with_the_code_the_running_devot_answers() {
        let dir = tempfile::tempdir().unwrap();
        let uid = crate::atomic_file::effective_uid();
        let append = Append {
            target: Target::Id(NOTE_ID.into()),
            heading: Some("Log".into()),
            position: Position::Append,
            text: "- done".into(),
        };
        let message = handoff_message(
            Path::new("/w"),
            Path::new("/Applications/Devot.app/Contents/MacOS/devot"),
            &append_handoff_args(&append),
        );
        let send = |socket: &Path| {
            single_instance::send_answered_to(
                socket,
                message.as_bytes(),
                uid,
                Duration::from_secs(5),
            )
        };
        let refusing = dir.path().join("refusing.sock");
        let reader = answering(&refusing, b"\x15E_HEADING_NOT_FOUND");
        let sent = send(&refusing);
        let (_, argv) = String::from_utf8(reader.join().unwrap())
            .unwrap()
            .split_once("\0\0")
            .map(|(cwd, rest)| (cwd.to_owned(), rest.to_owned()))
            .unwrap();
        let read: Vec<String> = argv.split('\0').map(String::from).collect();
        assert_eq!(parse_append_handoff(&read), Some(append.clone()));
        let failed = hand_off_answered(
            sent,
            true,
            || unreachable!(),
            || unreachable!(),
            || unreachable!(),
            Duration::ZERO,
        );
        assert_eq!(failed, Err(Failure::Refused("E_HEADING_NOT_FOUND".into())));
        assert_eq!(append_status(failed), 1);
        assert_eq!(
            append_message("E_HEADING_NOT_FOUND"),
            "the note has no such heading (E_HEADING_NOT_FOUND)"
        );
        assert_eq!(append_message("E_ODD"), "append failed (E_ODD)");

        let taking = dir.path().join("taking.sock");
        let reader = answering(&taking, b"\x06");
        let done = hand_off_answered(
            send(&taking),
            true,
            || unreachable!(),
            || unreachable!(),
            || unreachable!(),
            Duration::ZERO,
        );
        reader.join().unwrap();
        assert_eq!(done, Ok(()));
        assert_eq!(append_status(done), 0);
        assert_eq!(
            append_status(Err(Failure::Code("E_CLI_HANDOFF_UNREACHABLE"))),
            1
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
        let launched = hand_off_with(
            sent,
            true,
            || unreachable!(),
            || unreachable!(),
            || unreachable!(),
            Duration::ZERO,
        );
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
                },
                || Ok(true),
                Duration::from_secs(1)
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
                },
                || Ok(true),
                Duration::from_secs(1)
            ),
            Ok(())
        );
        assert!(launched);
        assert_eq!(
            hand_off_with(
                Ok(true),
                true,
                || unreachable!(),
                || unreachable!(),
                || unreachable!(),
                Duration::ZERO
            ),
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
                },
                || Ok(true),
                Duration::from_secs(1)
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
    fn launches_devot_without_the_files_and_hands_them_over_once_it_listens() {
        use std::io::{Read, Write};
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("io.github.jma49.devot.sock");
        let uid = crate::atomic_file::effective_uid();
        let message = b"/w\0\0devot\0--devot-open\0--\0/b.md";
        let mut reader = None;
        // A Devot another call is still launching binds its socket only after a while.
        let launch = || {
            let socket = socket.clone();
            reader = Some(std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150));
                let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
                let (mut stream, _) = listener.accept().unwrap();
                let mut got = vec![0; message.len()];
                stream.read_exact(&mut got).unwrap();
                stream.write_all(&[0x06]).unwrap();
                got
            }));
            Ok(())
        };
        let launched = hand_off_with(
            Ok(false),
            true,
            || false,
            launch,
            || single_instance::send_to(&socket, message, uid),
            Duration::from_secs(5),
        );
        assert_eq!(launched, Ok(()));
        assert_eq!(reader.unwrap().join().unwrap(), message);
    }

    #[test]
    fn a_launched_devot_that_never_listens_fails_the_command() {
        let mut tries = 0;
        let launched = hand_off_with(
            Ok(false),
            true,
            || false,
            || Ok(()),
            || {
                tries += 1;
                Ok(false)
            },
            Duration::from_millis(200),
        );
        assert_eq!(launched, Err("E_CLI_LAUNCH_UNANSWERED"));
        assert!(tries > 1, "asks again while it waits");
        assert_eq!(launch_status(launched), 1);
        let mut asked = false;
        let plain = hand_off_with(
            Ok(false),
            false,
            || unreachable!(),
            || Ok(()),
            || {
                asked = true;
                Ok(false)
            },
            Duration::from_millis(200),
        );
        assert_eq!(plain, Ok(()));
        assert!(!asked, "with nothing to hand over it only launches");
        let refused = hand_off_with(
            Ok(false),
            true,
            || false,
            || Ok(()),
            || Err("E_CLI_HANDOFF_REFUSED"),
            Duration::from_millis(200),
        );
        assert_eq!(refused, Err("E_CLI_HANDOFF_REFUSED"));
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
