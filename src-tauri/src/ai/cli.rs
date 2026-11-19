//! Local Claude Code and Codex CLI discovery, auth probing and sandboxed generation.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::catalog::{self, CatalogModel};
use super::provider::{
    Completion, Message, Partial, Prepared, ProviderId, Role, Stop, Usage, status_error,
};
use super::transport::{MAX_EVENT_BYTES, MAX_RESPONSE_BYTES};

/// Where Homebrew, npm and installers put `claude` and `codex`, which a GUI app's short PATH leaves out.
const CLAUDE_IN_HOME: [&str; 5] = [
    ".local/bin/claude",
    ".claude/local/claude",
    ".npm-global/bin/claude",
    ".volta/bin/claude",
    ".bun/bin/claude",
];
const CLAUDE_ANYWHERE: [&str; 2] = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
const CODEX_IN_HOME: [&str; 5] = [
    ".local/bin/codex",
    ".npm-global/bin/codex",
    ".volta/bin/codex",
    ".bun/bin/codex",
    ".cargo/bin/codex",
];
const CODEX_ANYWHERE: [&str; 2] = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
/// What an npm-installed CLI needs to find `node` when launched from a GUI app.
const CLI_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
/// `claude auth status --json` takes ~5.5 s on macOS due to CLI startup; bound probes without
/// misclassifying a signed-in installation under normal load.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PROBE_BYTES: usize = 64 * 1024;
/// `codex debug models` prints each model's whole instructions, about 1 MB for a dozen models.
const MAX_CATALOG_BYTES: usize = 16 * 1024 * 1024;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_STDERR_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CliState {
    Ready,
    SignedOut,
    #[default]
    NotInstalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CliStates {
    pub claude_cli: CliState,
    pub codex_cli: CliState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliDone {
    pub model: String,
    pub completion: Completion,
}

/// The model and reasoning level a CLI request asks for; empty or None leaves each to the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliChoice<'a> {
    pub model: &'a str,
    pub reasoning: Option<&'a str>,
}

pub trait CliBackend: Send + Sync {
    fn probe(&self) -> CliStates;
    fn models(&self, id: ProviderId) -> Result<Vec<CatalogModel>, &'static str>;
    fn run(
        &self,
        id: ProviderId,
        choice: CliChoice<'_>,
        request: &Prepared<'_>,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
        on_text: &mut dyn FnMut(&str) -> bool,
    ) -> Result<CliDone, &'static str>;
}

#[derive(Default)]
pub struct SystemCli;

impl CliBackend for SystemCli {
    fn probe(&self) -> CliStates {
        let home = home_dir();
        let path_var = std::env::var_os("PATH");
        let claude = find_claude(path_var.as_deref(), home.as_deref(), is_executable);
        let codex = find_codex(path_var.as_deref(), home.as_deref(), is_executable);
        probe_paths(claude.as_deref(), codex.as_deref(), PROBE_TIMEOUT)
    }

    fn models(&self, id: ProviderId) -> Result<Vec<CatalogModel>, &'static str> {
        let home = home_dir();
        let path_var = std::env::var_os("PATH");
        match id {
            ProviderId::ClaudeCli => {
                find_claude(path_var.as_deref(), home.as_deref(), is_executable)
                    .ok_or("E_AI_CLI_MISSING")?;
                Ok(catalog::claude_code())
            }
            ProviderId::CodexCli => {
                let cli = find_codex(path_var.as_deref(), home.as_deref(), is_executable)
                    .ok_or("E_AI_CLI_MISSING")?;
                codex_models(&cli, CATALOG_TIMEOUT, MAX_CATALOG_BYTES)
            }
            ProviderId::Anthropic | ProviderId::Openai => Err("E_AI_PROVIDER_UNAVAILABLE"),
        }
    }

    fn run(
        &self,
        id: ProviderId,
        choice: CliChoice<'_>,
        request: &Prepared<'_>,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
        on_text: &mut dyn FnMut(&str) -> bool,
    ) -> Result<CliDone, &'static str> {
        let home = home_dir();
        let path_var = std::env::var_os("PATH");
        let cli = match id {
            ProviderId::ClaudeCli => {
                find_claude(path_var.as_deref(), home.as_deref(), is_executable)
            }
            ProviderId::CodexCli => find_codex(path_var.as_deref(), home.as_deref(), is_executable),
            ProviderId::Anthropic | ProviderId::Openai => return Err("E_AI_PROVIDER_UNAVAILABLE"),
        }
        .ok_or("E_AI_CLI_MISSING")?;
        run_cli_binary(&cli, id, choice, request, timeout, cancelled, on_text)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::home_dir().filter(|home| !home.as_os_str().is_empty())
}

pub(crate) fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
    }
}

fn find_cli(
    name: &str,
    anywhere: &[&str],
    in_home: &[&str],
    path_var: Option<&OsStr>,
    home: Option<&Path>,
    executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name));
    let known = anywhere.iter().map(PathBuf::from).chain(
        home.into_iter()
            .flat_map(|h| in_home.iter().map(move |rest| h.join(rest))),
    );
    on_path.chain(known).find(|path| executable(path))
}

pub(crate) fn find_claude(
    path_var: Option<&OsStr>,
    home: Option<&Path>,
    executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    find_cli(
        "claude",
        &CLAUDE_ANYWHERE,
        &CLAUDE_IN_HOME,
        path_var,
        home,
        executable,
    )
}

pub(crate) fn find_codex(
    path_var: Option<&OsStr>,
    home: Option<&Path>,
    executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    find_cli(
        "codex",
        &CODEX_ANYWHERE,
        &CODEX_IN_HOME,
        path_var,
        home,
        executable,
    )
}

/// The CLI's own folder first, then standard macOS tool folders and any absolute `PATH` entries.
pub(crate) fn cli_path_for(cli: &Path) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |dir: &Path| {
        if !dir.as_os_str().is_empty() && !dirs.iter().any(|existing| existing == dir) {
            dirs.push(dir.to_path_buf());
        }
    };
    if let Some(dir) = cli.parent() {
        push(dir);
    }
    if let Some(dir) = std::fs::canonicalize(cli)
        .ok()
        .as_deref()
        .and_then(Path::parent)
    {
        push(dir);
    }
    for base in CLI_PATH.split(':') {
        push(Path::new(base));
    }
    if let Some(existing) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&existing) {
            if dir.is_absolute() {
                push(&dir);
            }
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| OsString::from(CLI_PATH))
}

fn probe_paths(claude: Option<&Path>, codex: Option<&Path>, timeout: Duration) -> CliStates {
    std::thread::scope(|scope| {
        let claude_job = scope.spawn(|| match claude {
            Some(path) => probe_claude(path, timeout),
            None => CliState::NotInstalled,
        });
        let codex_job = scope.spawn(|| match codex {
            Some(path) => probe_codex(path, timeout),
            None => CliState::NotInstalled,
        });
        CliStates {
            claude_cli: claude_job.join().unwrap_or(CliState::SignedOut),
            codex_cli: codex_job.join().unwrap_or(CliState::SignedOut),
        }
    })
}

struct ProbeOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// A run that outlasts `timeout` is killed and answers `E_AI_TIMEOUT`; one that cannot start, `E_AI_FAILED`.
fn run_probe(
    cli: &Path,
    args: &[&str],
    timeout: Duration,
    max_stdout: usize,
) -> Result<ProbeOutput, &'static str> {
    let workdir = tempfile::tempdir().map_err(|_| "E_AI_FAILED")?;
    let mut child = Command::new(cli)
        .args(args)
        .current_dir(workdir.path())
        .env("PATH", cli_path_for(cli))
        .env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "E_AI_FAILED")?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("E_AI_FAILED");
    };
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let err_job = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.take(MAX_STDERR_BYTES as u64).read_to_end(&mut buf);
            buf
        });
        let mut out = Vec::new();
        let limit = u64::try_from(max_stdout)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let _ = stdout.take(limit).read_to_end(&mut out);
        let err = err_job.join().unwrap_or_default();
        let _ = tx.send((out, err));
    });
    let deadline = Instant::now() + timeout;
    let Ok((stdout, stderr)) = rx.recv_timeout(timeout) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("E_AI_TIMEOUT");
    };
    let status = wait_child_until(&mut child, deadline)?;
    Ok(ProbeOutput {
        status,
        stdout,
        stderr,
    })
}

fn probe_claude(cli: &Path, timeout: Duration) -> CliState {
    let Ok(out) = run_probe(cli, &["auth", "status", "--json"], timeout, MAX_PROBE_BYTES) else {
        return CliState::SignedOut;
    };
    if !out.status.success() {
        return CliState::SignedOut;
    }
    let parsed: Result<Value, _> = serde_json::from_slice(&out.stdout);
    match parsed {
        Ok(val) if val.get("loggedIn").and_then(Value::as_bool) == Some(true) => CliState::Ready,
        _ => CliState::SignedOut,
    }
}

fn probe_codex(cli: &Path, timeout: Duration) -> CliState {
    let Ok(out) = run_probe(cli, &["login", "status"], timeout, MAX_PROBE_BYTES) else {
        return CliState::SignedOut;
    };
    if !out.status.success() {
        return CliState::SignedOut;
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .to_ascii_lowercase();
    if combined.contains("not logged in") || combined.contains("logged out") {
        CliState::SignedOut
    } else {
        CliState::Ready
    }
}

/// Codex's own catalog; it needs no sign-in, so a signed-out Codex still lists its models.
pub(crate) fn codex_models(
    cli: &Path,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Vec<CatalogModel>, &'static str> {
    let out = run_probe(cli, &["debug", "models"], timeout, max_bytes)?;
    if out.stdout.len() > max_bytes {
        return Err("E_AI_RESPONSE_TOO_LARGE");
    }
    if !out.status.success() {
        return Err("E_AI_FAILED");
    }
    catalog::parse_codex(&out.stdout)
}

/// Never passes `--bare` (disables keychain/OAuth subscription auth) and never puts prompts in `argv`.
pub(crate) fn claude_args(
    stream: bool,
    system: Option<&str>,
    choice: CliChoice<'_>,
) -> Vec<String> {
    let mut args = vec![
        "-p".into(),
        "--safe-mode".into(),
        "--tools".into(),
        String::new(),
        "--strict-mcp-config".into(),
        "--no-session-persistence".into(),
        "--output-format".into(),
    ];
    if stream {
        args.extend([
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
        ]);
    } else {
        args.push("json".into());
    }
    if let Some(sys) = system {
        args.push(format!("--system-prompt={sys}"));
    }
    if !choice.model.is_empty() {
        args.push("--model".into());
        args.push(choice.model.to_string());
    }
    if let Some(effort) = choice.reasoning {
        args.push("--effort".into());
        args.push(effort.to_string());
    }
    args
}

/// Never puts prompt or system text in `argv`; passes `-` so `codex exec` reads `stdin`.
pub(crate) fn codex_args(choice: CliChoice<'_>) -> Vec<String> {
    let mut args = vec![
        "exec".into(),
        "--ephemeral".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        "--skip-git-repo-check".into(),
        "--sandbox".into(),
        "read-only".into(),
        "--color".into(),
        "never".into(),
        "--json".into(),
    ];
    if !choice.model.is_empty() {
        args.push("-m".into());
        args.push(choice.model.to_string());
    }
    if let Some(effort) = choice.reasoning {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    args.push("-".into());
    args
}

pub(crate) fn format_messages(messages: &[Message]) -> String {
    if messages.len() == 1 {
        return messages[0].content.clone();
    }
    messages
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
            };
            format!("{role}:\n{}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(crate) fn codex_stdin(system: Option<&str>, messages: &[Message]) -> String {
    let body = format_messages(messages);
    match system {
        Some(sys) => format!("<system_instructions>\n{sys}\n</system_instructions>\n\n{body}"),
        None => body,
    }
}

fn run_cli_binary(
    cli: &Path,
    id: ProviderId,
    choice: CliChoice<'_>,
    request: &Prepared<'_>,
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
    on_text: &mut dyn FnMut(&str) -> bool,
) -> Result<CliDone, &'static str> {
    if cancelled() {
        return Err("E_AI_CANCELLED");
    }
    let (args, stdin_text) = match id {
        ProviderId::ClaudeCli => (
            claude_args(request.stream, request.system, choice),
            format_messages(request.messages),
        ),
        ProviderId::CodexCli => (
            codex_args(choice),
            codex_stdin(request.system, request.messages),
        ),
        ProviderId::Anthropic | ProviderId::Openai => return Err("E_AI_PROVIDER_UNAVAILABLE"),
    };
    let workdir = tempfile::tempdir().map_err(|_| "E_AI_FAILED")?;
    let mut child = Command::new(cli)
        .args(&args)
        .current_dir(workdir.path())
        .env("PATH", cli_path_for(cli))
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "E_AI_FAILED")?;

    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(stdin_text.as_bytes());
        });
    }
    let rx_err = child.stderr.take().map(|stderr| {
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.take(MAX_STDERR_BYTES as u64).read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
        rx
    });
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "E_AI_FAILED"
    })?;
    let deadline = Instant::now() + timeout;
    let model_override = choice.model;

    if id == ProviderId::ClaudeCli && !request.stream {
        run_claude_single(child, stdout, rx_err, deadline, model_override)
    } else {
        let halt = Halt {
            deadline,
            cancelled,
        };
        run_jsonl_stream(child, stdout, rx_err, halt, id, model_override, on_text)
    }
}

fn wait_child_until(child: &mut Child, deadline: Instant) -> Result<ExitStatus, &'static str> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                let now = Instant::now();
                if now >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("E_AI_TIMEOUT");
                }
                let step = (deadline - now).min(Duration::from_millis(25));
                std::thread::sleep(step);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("E_AI_FAILED");
            }
        }
    }
}

fn read_stderr(rx_err: Option<mpsc::Receiver<Vec<u8>>>) -> String {
    rx_err
        .and_then(|rx| rx.recv_timeout(Duration::from_millis(50)).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn run_claude_single(
    mut child: Child,
    stdout: std::process::ChildStdout,
    rx_err: Option<mpsc::Receiver<Vec<u8>>>,
    deadline: Instant,
    model_override: &str,
) -> Result<CliDone, &'static str> {
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let limit = u64::try_from(MAX_RESPONSE_BYTES)
            .unwrap_or(u64::MAX)
            .saturating_add(1);
        let mut buf = Vec::new();
        let read = stdout.take(limit).read_to_end(&mut buf);
        let msg = match read {
            Ok(_) if buf.len() > MAX_RESPONSE_BYTES => Err("E_AI_RESPONSE_TOO_LARGE"),
            Ok(_) => Ok(buf),
            Err(_) => Err("E_AI_FAILED"),
        };
        let _ = tx.send(msg);
    });
    let remaining = deadline.saturating_duration_since(Instant::now());
    let out = match rx.recv_timeout(remaining) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(code)) => {
            kill_and_reap(&mut child);
            return Err(code);
        }
        Err(_) => {
            kill_and_reap(&mut child);
            return Err("E_AI_TIMEOUT");
        }
    };
    let status = wait_child_until(&mut child, deadline)?;
    let stderr = read_stderr(rx_err);
    parse_claude_json(&out, status, &stderr, model_override)
}

/// When a stream stops early: its deadline passes or the user cancels it.
struct Halt<'a> {
    deadline: Instant,
    cancelled: &'a dyn Fn() -> bool,
}

enum StreamMsg {
    Line(Vec<u8>),
    TooLarge,
    LineTooLarge,
    ReadFailed,
}

fn run_jsonl_stream(
    mut child: Child,
    stdout: std::process::ChildStdout,
    rx_err: Option<mpsc::Receiver<Vec<u8>>>,
    halt: Halt<'_>,
    id: ProviderId,
    model_override: &str,
    on_text: &mut dyn FnMut(&str) -> bool,
) -> Result<CliDone, &'static str> {
    let Halt {
        deadline,
        cancelled,
    } = halt;
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0usize;
        let mut line = Vec::new();
        let event_limit = u64::try_from(MAX_EVENT_BYTES + 1).unwrap_or(u64::MAX);
        loop {
            line.clear();
            match (&mut reader).take(event_limit).read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if total > MAX_RESPONSE_BYTES {
                        let _ = tx.send(StreamMsg::TooLarge);
                        break;
                    }
                    if n > MAX_EVENT_BYTES {
                        let _ = tx.send(StreamMsg::LineTooLarge);
                        break;
                    }
                    if tx.send(StreamMsg::Line(std::mem::take(&mut line))).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = tx.send(StreamMsg::ReadFailed);
                    break;
                }
            }
        }
    });

    let mut claude_state = ClaudeStreamState::default();
    let mut codex_state = CodexStreamState::default();

    loop {
        if cancelled() {
            kill_and_reap(&mut child);
            return Err("E_AI_CANCELLED");
        }
        let Some(remaining) = deadline
            .checked_duration_since(Instant::now())
            .filter(|r| !r.is_zero())
        else {
            kill_and_reap(&mut child);
            return Err("E_AI_TIMEOUT");
        };
        match rx.recv_timeout(remaining.min(Duration::from_millis(40))) {
            Ok(StreamMsg::TooLarge) => {
                kill_and_reap(&mut child);
                return Err("E_AI_RESPONSE_TOO_LARGE");
            }
            Ok(StreamMsg::LineTooLarge | StreamMsg::ReadFailed) => {
                kill_and_reap(&mut child);
                return Err("E_AI_RESPONSE_INVALID");
            }
            Ok(StreamMsg::Line(bytes)) => {
                let Ok(text) = std::str::from_utf8(&bytes) else {
                    kill_and_reap(&mut child);
                    return Err("E_AI_RESPONSE_INVALID");
                };
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let res = match id {
                    ProviderId::ClaudeCli => claude_state.push_line(trimmed, on_text),
                    ProviderId::CodexCli => codex_state.push_line(trimmed, on_text),
                    ProviderId::Anthropic | ProviderId::Openai => Err("E_AI_PROVIDER_UNAVAILABLE"),
                };
                if let Err(code) = res {
                    kill_and_reap(&mut child);
                    return Err(code);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if cancelled() {
        kill_and_reap(&mut child);
        return Err("E_AI_CANCELLED");
    }
    let status = wait_child_until(&mut child, deadline)?;
    let stderr = read_stderr(rx_err);
    match id {
        ProviderId::ClaudeCli => claude_state.finish(status, &stderr, model_override),
        ProviderId::CodexCli => codex_state.finish(status, &stderr, model_override),
        ProviderId::Anthropic | ProviderId::Openai => Err("E_AI_PROVIDER_UNAVAILABLE"),
    }
}

fn claude_stop(reason: &str) -> Result<Stop, &'static str> {
    match reason {
        "end_turn" | "stop_sequence" => Ok(Stop::End),
        "max_tokens" => Ok(Stop::MaxTokens),
        "refusal" => Err("E_AI_REFUSED"),
        _ => Ok(Stop::Other),
    }
}

fn first_model_usage_key(val: &Value) -> Option<String> {
    val.get("modelUsage")
        .and_then(Value::as_object)
        .and_then(|map| map.keys().next().cloned())
}

fn parse_claude_usage(val: &Value) -> (Option<u64>, Option<u64>) {
    let Some(u) = val.get("usage") else {
        return (None, None);
    };
    (
        u.get("input_tokens").and_then(Value::as_u64),
        u.get("output_tokens").and_then(Value::as_u64),
    )
}

fn classify_error_text(text: &str) -> &'static str {
    let lower = text.to_ascii_lowercase();
    if lower.contains("not logged in")
        || lower.contains("logged out")
        || lower.contains("please run /login")
        || lower.contains("codex login")
        || lower.contains("unauthorized")
        || lower.contains("invalid api key")
        || lower.contains("authentication")
        || lower.contains("auth failed")
        || lower.contains("401")
        || lower.contains("403")
    {
        return "E_AI_AUTH_FAILED";
    }
    if lower.contains("rate limit")
        || lower.contains("rate_limit")
        || lower.contains("too many requests")
        || lower.contains("quota")
        || lower.contains("usage limit")
        || lower.contains("429")
    {
        return "E_AI_RATE_LIMITED";
    }
    if lower.contains("unrecognized_model")
        || lower.contains("model_not_found")
        || lower.contains("not found")
        || lower.contains("does not exist")
        || lower.contains("404")
    {
        return "E_AI_NOT_FOUND";
    }
    if lower.contains("not supported")
        || lower.contains("invalid model")
        || lower.contains("unsupported")
        || lower.contains("400")
        || lower.contains("413")
        || lower.contains("422")
    {
        return "E_AI_REQUEST_REJECTED";
    }
    if lower.contains("overloaded")
        || lower.contains("service unavailable")
        || lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("529")
    {
        return "E_AI_PROVIDER_UNAVAILABLE";
    }
    if lower.contains("refus") || lower.contains("content_filter") || lower.contains("safety") {
        return "E_AI_REFUSED";
    }
    "E_AI_FAILED"
}

fn classify_claude_error(val: &Value, stderr: &str) -> &'static str {
    if let Some(code) = val
        .get("api_error_status")
        .and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
    {
        return status_error(code);
    }
    let mut detail = String::new();
    if let Some(msg) = val.get("result").and_then(Value::as_str) {
        detail.push_str(msg);
        detail.push('\n');
    }
    if let Some(api_type) = val.get("api_error_type").and_then(Value::as_str) {
        detail.push_str(api_type);
        detail.push('\n');
    }
    if let Some(errors) = val.get("errors").and_then(Value::as_array) {
        for err in errors {
            if let Some(s) = err
                .as_str()
                .or_else(|| err.get("message").and_then(Value::as_str))
            {
                detail.push_str(s);
                detail.push('\n');
            }
        }
    }
    detail.push_str(stderr);
    classify_error_text(&detail)
}

pub(crate) fn parse_claude_json(
    stdout: &[u8],
    status: ExitStatus,
    stderr: &str,
    model_override: &str,
) -> Result<CliDone, &'static str> {
    let parsed: Value = match serde_json::from_slice(stdout) {
        Ok(v) => v,
        Err(_) if !status.success() => return Err(classify_error_text(stderr)),
        Err(_) => return Err("E_AI_RESPONSE_INVALID"),
    };
    let obj = match &parsed {
        Value::Object(_) => &parsed,
        Value::Array(items) => items
            .iter()
            .rev()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("result"))
            .or_else(|| items.last())
            .ok_or("E_AI_RESPONSE_INVALID")?,
        _ => return Err("E_AI_RESPONSE_INVALID"),
    };

    let subtype = obj.get("subtype").and_then(Value::as_str);
    let is_error = obj
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || subtype.is_some_and(|s| s.starts_with("error"));
    if is_error || !status.success() {
        return Err(classify_claude_error(obj, stderr));
    }

    let stop = match obj.get("stop_reason").and_then(Value::as_str) {
        Some(reason) => claude_stop(reason)?,
        None if subtype == Some("success") => Stop::End,
        None => return Err("E_AI_RESPONSE_INVALID"),
    };
    let text = obj
        .get("result")
        .and_then(Value::as_str)
        .ok_or("E_AI_RESPONSE_INVALID")?
        .to_string();
    let (input_tokens, output_tokens) = parse_claude_usage(obj);
    let usage = match (input_tokens, output_tokens) {
        (Some(input_tokens), Some(output_tokens)) => Some(Usage {
            input_tokens,
            output_tokens,
        }),
        _ => None,
    };
    let model = if !model_override.is_empty() {
        model_override.to_string()
    } else {
        first_model_usage_key(obj).unwrap_or_else(|| "claude".to_string())
    };
    Ok(CliDone {
        model,
        completion: Completion { text, stop, usage },
    })
}

#[derive(Default)]
pub(crate) struct ClaudeStreamState {
    partial: Partial,
    model: Option<String>,
    saw_delta: bool,
    result_error: Option<&'static str>,
}

impl ClaudeStreamState {
    pub(crate) fn push_line(
        &mut self,
        line: &str,
        on_text: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), &'static str> {
        let val: Value = serde_json::from_str(line).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        let kind = val.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "system" => {
                if self.model.is_none()
                    && let Some(m) = val.get("model").and_then(Value::as_str)
                    && m != "<synthetic>"
                {
                    self.model = Some(m.to_string());
                }
            }
            "stream_event" => {
                let Some(event) = val.get("event") else {
                    return Ok(());
                };
                match event.get("type").and_then(Value::as_str).unwrap_or("") {
                    "message_start" => {
                        if let Some(msg) = event.get("message") {
                            if self.model.is_none()
                                && let Some(m) = msg.get("model").and_then(Value::as_str)
                                && m != "<synthetic>"
                            {
                                self.model = Some(m.to_string());
                            }
                            if let Some(input) = msg
                                .get("usage")
                                .and_then(|u| u.get("input_tokens"))
                                .and_then(Value::as_u64)
                            {
                                self.partial.input_tokens = Some(input);
                            }
                        }
                    }
                    "content_block_delta" => {
                        if let Some(delta) = event.get("delta")
                            && delta.get("type").and_then(Value::as_str) == Some("text_delta")
                            && let Some(text) = delta.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            self.saw_delta = true;
                            self.partial.text.push_str(text);
                            if !on_text(text) {
                                return Err("E_AI_CANCELLED");
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(reason) = event
                            .get("delta")
                            .and_then(|d| d.get("stop_reason"))
                            .and_then(Value::as_str)
                        {
                            self.partial.stop = Some(claude_stop(reason)?);
                        }
                        if let Some(u) = event.get("usage") {
                            if let Some(output) = u.get("output_tokens").and_then(Value::as_u64) {
                                self.partial.output_tokens = Some(output);
                            }
                            if let Some(input) = u.get("input_tokens").and_then(Value::as_u64) {
                                self.partial.input_tokens = Some(input);
                            }
                        }
                    }
                    "message_stop" => {
                        self.partial.ended = true;
                    }
                    "error" => {
                        let err_kind = event
                            .get("error")
                            .and_then(|e| e.get("type"))
                            .and_then(Value::as_str);
                        return Err(match err_kind {
                            Some("overloaded_error" | "api_error") => "E_AI_PROVIDER_UNAVAILABLE",
                            Some("rate_limit_error") => "E_AI_RATE_LIMITED",
                            Some("authentication_error" | "permission_error") => "E_AI_AUTH_FAILED",
                            _ => "E_AI_FAILED",
                        });
                    }
                    _ => {}
                }
            }
            "assistant" => {
                if self.model.is_none()
                    && let Some(m) = val
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(Value::as_str)
                    && m != "<synthetic>"
                {
                    self.model = Some(m.to_string());
                }
            }
            "result" => {
                let subtype = val.get("subtype").and_then(Value::as_str);
                let is_error = val
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || subtype.is_some_and(|s| s.starts_with("error"));
                if is_error {
                    self.result_error = Some(classify_claude_error(&val, ""));
                    return Ok(());
                }
                if self.model.is_none() {
                    self.model = first_model_usage_key(&val);
                }
                let (input, output) = parse_claude_usage(&val);
                if input.is_some() {
                    self.partial.input_tokens = input;
                }
                if output.is_some() {
                    self.partial.output_tokens = output;
                }
                if self.partial.stop.is_none() {
                    self.partial.stop = match val.get("stop_reason").and_then(Value::as_str) {
                        Some(reason) => Some(claude_stop(reason)?),
                        None if subtype == Some("success") => Some(Stop::End),
                        None => None,
                    };
                }
                if !self.saw_delta
                    && let Some(text) = val.get("result").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    self.partial.text.push_str(text);
                    if !on_text(text) {
                        return Err("E_AI_CANCELLED");
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn finish(
        mut self,
        status: ExitStatus,
        stderr: &str,
        model_override: &str,
    ) -> Result<CliDone, &'static str> {
        if let Some(code) = self.result_error {
            if code == "E_AI_FAILED" && !stderr.trim().is_empty() {
                return Err(classify_error_text(stderr));
            }
            return Err(code);
        }
        if !status.success() {
            return Err(classify_error_text(stderr));
        }
        let stop = self.partial.stop.ok_or("E_AI_RESPONSE_INVALID")?;
        let usage = self.partial.usage();
        let text = std::mem::take(&mut self.partial.text);
        let model = if !model_override.is_empty() {
            model_override.to_string()
        } else {
            self.model.unwrap_or_else(|| "claude".to_string())
        };
        Ok(CliDone {
            model,
            completion: Completion { text, stop, usage },
        })
    }
}

#[derive(Default)]
pub(crate) struct CodexStreamState {
    partial: Partial,
    item_text: HashMap<String, String>,
    last_error: Option<String>,
    failed: bool,
}

impl CodexStreamState {
    pub(crate) fn push_line(
        &mut self,
        line: &str,
        on_text: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), &'static str> {
        let val: Value = serde_json::from_str(line).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        match val.get("type").and_then(Value::as_str).unwrap_or("") {
            "item.started" | "item.updated" | "item.completed" => {
                let Some(item) = val.get("item") else {
                    return Ok(());
                };
                if item.get("type").and_then(Value::as_str) != Some("agent_message") {
                    return Ok(());
                }
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                let had_item_text = self.item_text.get(&id).is_some_and(|prev| !prev.is_empty());
                if !had_item_text
                    && !self.partial.text.is_empty()
                    && !self.partial.text.ends_with('\n')
                    && !text.is_empty()
                {
                    self.partial.text.push_str("\n\n");
                    if !on_text("\n\n") {
                        return Err("E_AI_CANCELLED");
                    }
                }
                let delta = match self.item_text.get(&id) {
                    Some(prev) => text.strip_prefix(prev.as_str()).unwrap_or(""),
                    None => text,
                };
                if !delta.is_empty() {
                    self.partial.text.push_str(delta);
                    if !on_text(delta) {
                        return Err("E_AI_CANCELLED");
                    }
                }
                self.item_text.insert(id, text.to_string());
            }
            "turn.completed" => {
                self.partial.stop = Some(Stop::End);
                self.partial.ended = true;
                if let Some(u) = val.get("usage") {
                    self.partial.input_tokens = u.get("input_tokens").and_then(Value::as_u64);
                    self.partial.output_tokens = u.get("output_tokens").and_then(Value::as_u64);
                }
            }
            "error" => {
                if let Some(msg) = val.get("message").and_then(Value::as_str) {
                    self.last_error = Some(msg.to_string());
                }
            }
            "turn.failed" => {
                self.failed = true;
                if let Some(msg) = val
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                {
                    self.last_error = Some(msg.to_string());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn finish(
        mut self,
        status: ExitStatus,
        stderr: &str,
        model_override: &str,
    ) -> Result<CliDone, &'static str> {
        if self.failed || !status.success() {
            let mut detail = self.last_error.unwrap_or_default();
            if !detail.is_empty() && !stderr.is_empty() {
                detail.push('\n');
            }
            detail.push_str(stderr);
            return Err(classify_error_text(&detail));
        }
        let stop = self.partial.stop.ok_or("E_AI_RESPONSE_INVALID")?;
        let usage = self.partial.usage();
        let text = std::mem::take(&mut self.partial.text);
        let model = if !model_override.is_empty() {
            model_override.to_string()
        } else {
            "codex".to_string()
        };
        Ok(CliDone {
            model,
            completion: Completion { text, stop, usage },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::ExitStatus;

    #[cfg(unix)]
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn status_code(code: i32) -> ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    }

    #[test]
    fn finds_claude_and_codex_on_path_then_known_install_locations() {
        let home = Path::new("/Users/me");
        let only = |wanted: &'static str| move |path: &Path| path == Path::new(wanted);
        assert_eq!(
            find_claude(
                Some(OsStr::new("/a:relative:/b")),
                Some(home),
                only("/b/claude")
            ),
            Some(PathBuf::from("/b/claude"))
        );
        assert_eq!(
            find_claude(
                Some(OsStr::new("relative")),
                Some(home),
                only("relative/claude")
            ),
            None
        );
        assert_eq!(
            find_claude(None, Some(home), only("/Users/me/.claude/local/claude")),
            Some(PathBuf::from("/Users/me/.claude/local/claude"))
        );
        assert_eq!(
            find_codex(
                Some(OsStr::new("/usr/bin")),
                Some(home),
                only("/opt/homebrew/bin/codex")
            ),
            Some(PathBuf::from("/opt/homebrew/bin/codex"))
        );
        assert_eq!(
            find_codex(None, Some(home), only("/Users/me/.cargo/bin/codex")),
            Some(PathBuf::from("/Users/me/.cargo/bin/codex"))
        );
        assert_eq!(find_codex(None, Some(home), |_| false), None);
    }

    fn pick(model: &'static str, reasoning: Option<&'static str>) -> CliChoice<'static> {
        CliChoice { model, reasoning }
    }

    #[test]
    fn claude_and_codex_arguments_stay_sandboxed_and_never_pass_bare_or_prompts() {
        let claude_gen = claude_args(false, Some("Be brief."), pick("sonnet", Some("high")));
        assert!(!claude_gen.iter().any(|a| a == "--bare"));
        assert_eq!(
            claude_gen,
            [
                "-p",
                "--safe-mode",
                "--tools",
                "",
                "--strict-mcp-config",
                "--no-session-persistence",
                "--output-format",
                "json",
                "--system-prompt=Be brief.",
                "--model",
                "sonnet",
                "--effort",
                "high",
            ]
        );
        let dash_sys = claude_args(false, Some("- bullet"), pick("", None));
        assert!(dash_sys.contains(&"--system-prompt=- bullet".to_string()));
        let claude_stream = claude_args(true, None, pick("", None));
        assert!(!claude_stream.iter().any(|a| a == "--bare"));
        assert!(claude_stream.contains(&"stream-json".to_string()));
        assert!(claude_stream.contains(&"--verbose".to_string()));
        assert!(claude_stream.contains(&"--include-partial-messages".to_string()));
        assert!(!claude_stream.contains(&"--model".to_string()));
        assert!(!claude_stream.contains(&"--effort".to_string()));

        let codex = codex_args(pick("gpt-5.4", Some("xhigh")));
        assert_eq!(
            codex,
            [
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--color",
                "never",
                "--json",
                "-m",
                "gpt-5.4",
                "-c",
                "model_reasoning_effort=\"xhigh\"",
                "-",
            ]
        );
        let plain = codex_args(pick("", None));
        assert_eq!(plain.last().map(String::as_str), Some("-"));
        assert!(!plain.contains(&"-c".to_string()));
    }

    #[test]
    fn codex_stdin_frames_system_instructions_above_formatted_messages() {
        let messages = vec![
            Message {
                role: Role::User,
                content: "First?".into(),
            },
            Message {
                role: Role::Assistant,
                content: "Second.".into(),
            },
            Message {
                role: Role::User,
                content: "Third?".into(),
            },
        ];
        assert_eq!(
            codex_stdin(Some("Be brief."), &messages),
            "<system_instructions>\nBe brief.\n</system_instructions>\n\nUser:\nFirst?\n\nAssistant:\nSecond.\n\nUser:\nThird?"
        );
        assert_eq!(codex_stdin(None, &[messages[0].clone()]), "First?");
    }

    #[cfg(unix)]
    #[test]
    fn probes_auth_status_and_times_out_hanging_scripts() {
        let dir = tempfile::tempdir().unwrap();
        let claude_ok = write_script(
            dir.path(),
            "claude-ok",
            r#"printf '{"loggedIn":true,"email":"u@example.test"}\n'"#,
        );
        let claude_out = write_script(dir.path(), "claude-out", r#"printf '{"loggedIn":false}\n'"#);
        let codex_ok = write_script(dir.path(), "codex-ok", r#"echo "Logged in using ChatGPT""#);
        let codex_out = write_script(dir.path(), "codex-out", r#"echo "Not logged in"; exit 1"#);
        let hang = write_script(dir.path(), "hang", r#"exec sleep 5"#);

        let states = probe_paths(Some(&claude_ok), Some(&codex_ok), Duration::from_secs(2));
        assert_eq!(states.claude_cli, CliState::Ready);
        assert_eq!(states.codex_cli, CliState::Ready);

        let states = probe_paths(Some(&claude_out), Some(&codex_out), Duration::from_secs(2));
        assert_eq!(states.claude_cli, CliState::SignedOut);
        assert_eq!(states.codex_cli, CliState::SignedOut);

        let states = probe_paths(None, None, Duration::from_secs(2));
        assert_eq!(states.claude_cli, CliState::NotInstalled);
        assert_eq!(states.codex_cli, CliState::NotInstalled);

        let started = Instant::now();
        let timed_out = probe_paths(Some(&hang), Some(&hang), Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(timed_out.claude_cli, CliState::SignedOut);
        assert_eq!(timed_out.codex_cli, CliState::SignedOut);
    }

    #[cfg(unix)]
    #[test]
    fn parses_real_claude_and_codex_shapes_and_maps_failures() {
        let ok_json = br#"{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn","result":"OK","usage":{"input_tokens":2,"output_tokens":4},"modelUsage":{"claude-sonnet-5-5":{"inputTokens":2,"outputTokens":4}}}"#;
        let done = parse_claude_json(ok_json, status_code(0), "", "").unwrap();
        assert_eq!(done.model, "claude-sonnet-5-5");
        assert_eq!(done.completion.text, "OK");
        assert_eq!(done.completion.stop, Stop::End);
        assert_eq!(
            done.completion.usage,
            Some(Usage {
                input_tokens: 2,
                output_tokens: 4
            })
        );

        let err_json = br#"{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"missing model"}"#;
        assert_eq!(
            parse_claude_json(err_json, status_code(1), "", "").unwrap_err(),
            "E_AI_NOT_FOUND"
        );
        let subtype_err_json = r#"{"type":"result","subtype":"error_during_execution","is_error":false,"errors":[{"message":"Invalid API key · Please run /login"}]}"#.as_bytes();
        assert_eq!(
            parse_claude_json(subtype_err_json, status_code(0), "", "").unwrap_err(),
            "E_AI_AUTH_FAILED"
        );

        let mut claude_err_stream = ClaudeStreamState::default();
        claude_err_stream
            .push_line(
                r#"{"type":"result","subtype":"error_max_turns","is_error":false,"errors":[{"message":"Invalid API key"}]}"#,
                &mut |_| true,
            )
            .unwrap();
        assert_eq!(
            claude_err_stream
                .finish(status_code(0), "", "")
                .unwrap_err(),
            "E_AI_AUTH_FAILED"
        );

        let mut claude_stream = ClaudeStreamState::default();
        let mut streamed = Vec::new();
        for line in [
            r#"{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}"#,
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":5}}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
            r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Hello","stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":3}}"#,
        ] {
            claude_stream
                .push_line(line, &mut |piece| {
                    streamed.push(piece.to_string());
                    true
                })
                .unwrap();
        }
        assert_eq!(streamed, ["Hel", "lo"]);
        let claude_done = claude_stream.finish(status_code(0), "", "").unwrap();
        assert_eq!(claude_done.completion.text, "Hello");
        assert_eq!(claude_done.completion.stop, Stop::End);

        let mut codex = CodexStreamState::default();
        let mut codex_streamed = Vec::new();
        for line in [
            r#"{"type":"thread.started","thread_id":"t1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"item_0","type":"agent_message","text":""}}"#,
            r#"{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"Hel"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello world."}}"#,
            r#"{"type":"item.started","item":{"id":"item_1","type":"agent_message","text":""}}"#,
            r#"{"type":"item.updated","item":{"id":"item_1","type":"agent_message","text":"Second"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Second item."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}"#,
        ] {
            codex
                .push_line(line, &mut |piece| {
                    codex_streamed.push(piece.to_string());
                    true
                })
                .unwrap();
        }
        assert_eq!(
            codex_streamed,
            ["Hel", "lo world.", "\n\n", "Second", " item."]
        );
        let codex_done = codex.finish(status_code(0), "", "").unwrap();
        assert_eq!(codex_done.completion.text, "Hello world.\n\nSecond item.");
        assert_eq!(
            codex_done.completion.usage,
            Some(Usage {
                input_tokens: 11,
                output_tokens: 7
            })
        );

        let mut codex_err = CodexStreamState::default();
        codex_err
            .push_line(
                r#"{"type":"turn.failed","error":{"message":"Not logged in; run codex login"}}"#,
                &mut |_| true,
            )
            .unwrap();
        assert_eq!(
            codex_err.finish(status_code(1), "", "").unwrap_err(),
            "E_AI_AUTH_FAILED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_mock_cli_in_empty_tempdir_passes_prompt_only_on_stdin_and_cleans_up_cancel_and_timeout()
    {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("seen.txt");
        let canary = "SECRET-CANARY-991";
        let script = write_script(
            dir.path(),
            "mock-claude",
            &format!(
                r#"
printf "CWD=%s\n" "$(pwd)" > "{m}"
printf "ARGS=%s\n" "$*" >> "{m}"
cat >> "{m}"
printf '{{"type":"stream_event","event":{{"type":"content_block_delta","index":1,"delta":{{"type":"text_delta","text":"one"}}}}}}\n'
printf '{{"type":"stream_event","event":{{"type":"content_block_delta","index":1,"delta":{{"type":"text_delta","text":"two"}}}}}}\n'
printf '{{"type":"result","subtype":"success","is_error":false,"result":"onetwo","stop_reason":"end_turn"}}\n'
"#,
                m = marker.display()
            ),
        );
        let msgs = [Message {
            role: Role::User,
            content: format!("Summarise {canary}"),
        }];
        let req = Prepared {
            system: Some("Be brief."),
            messages: &msgs,
            max_tokens: 256,
            stream: true,
        };
        let mut pieces = Vec::new();
        let done = run_cli_binary(
            &script,
            ProviderId::ClaudeCli,
            pick("sonnet", Some("max")),
            &req,
            Duration::from_secs(5),
            &|| false,
            &mut |text| {
                pieces.push(text.to_string());
                true
            },
        )
        .unwrap();
        assert_eq!(pieces, ["one", "two"]);
        assert_eq!(done.completion.text, "onetwo");
        assert_eq!(done.model, "sonnet");

        let seen = std::fs::read_to_string(&marker).unwrap();
        let mut lines = seen.lines();
        let cwd = lines.next().unwrap().strip_prefix("CWD=").unwrap();
        let args = lines.next().unwrap().strip_prefix("ARGS=").unwrap();
        assert_ne!(Path::new(cwd), dir.path());
        assert!(!Path::new(cwd).exists(), "working dir removed on drop");
        assert!(!args.contains(canary), "prompt must never reach argv");
        assert!(!args.contains("--bare"));
        assert!(args.contains("--effort max"), "{args}");
        assert!(seen.contains(canary), "prompt must arrive on stdin");

        // Cancelling stops streaming immediately.
        let mut heard = 0;
        let cancelled = run_cli_binary(
            &script,
            ProviderId::ClaudeCli,
            pick("", None),
            &req,
            Duration::from_secs(5),
            &|| false,
            &mut |_| {
                heard += 1;
                false
            },
        )
        .unwrap_err();
        assert_eq!(cancelled, "E_AI_CANCELLED");
        assert_eq!(heard, 1);

        // An external cancel signal kills a slow CLI script promptly.
        let slow = write_script(dir.path(), "slow-cli", "exec sleep 5\n");
        let abort = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let abort_trigger = std::sync::Arc::clone(&abort);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            abort_trigger.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let started_cancel = Instant::now();
        let externally_cancelled = run_cli_binary(
            &slow,
            ProviderId::CodexCli,
            pick("", None),
            &req,
            Duration::from_secs(5),
            &|| abort.load(std::sync::atomic::Ordering::SeqCst),
            &mut |_| true,
        )
        .unwrap_err();
        assert_eq!(externally_cancelled, "E_AI_CANCELLED");
        assert!(started_cancel.elapsed() < Duration::from_secs(2));

        // Timeout kills and reaps a slow CLI script promptly.
        let started = Instant::now();
        let timed_out = run_cli_binary(
            &slow,
            ProviderId::CodexCli,
            pick("", None),
            &req,
            Duration::from_millis(150),
            &|| false,
            &mut |_| true,
        )
        .unwrap_err();
        assert_eq!(timed_out, "E_AI_TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn codex_lists_its_catalog_and_a_failure_is_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let listing = write_script(
            dir.path(),
            "codex",
            r#"[ "$1 $2" = "debug models" ] || exit 3
printf '%s' '{"models":[{"slug":"gpt-a","display_name":"GPT A","visibility":"list","priority":1}]}'
"#,
        );
        let models = codex_models(&listing, Duration::from_secs(5), MAX_CATALOG_BYTES).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "GPT A");
        let failing = write_script(dir.path(), "codex-fails", "exit 1\n");
        assert_eq!(
            codex_models(&failing, Duration::from_secs(5), MAX_CATALOG_BYTES),
            Err("E_AI_FAILED")
        );
        let garbled = write_script(dir.path(), "codex-garbled", "echo nope\n");
        assert_eq!(
            codex_models(&garbled, Duration::from_secs(5), MAX_CATALOG_BYTES),
            Err("E_AI_RESPONSE_INVALID")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_codex_catalog_past_its_cap_or_its_time_is_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let listing = r#"{"models":[{"slug":"gpt-a","visibility":"list"}]}"#;
        let fits = write_script(
            dir.path(),
            "codex-fits",
            &format!("printf '%s' '{listing}'\n"),
        );
        assert!(codex_models(&fits, Duration::from_secs(5), listing.len()).is_ok());
        assert_eq!(
            codex_models(&fits, Duration::from_secs(5), listing.len() - 1),
            Err("E_AI_RESPONSE_TOO_LARGE")
        );
        let endless = write_script(dir.path(), "codex-endless", "exec yes\n");
        assert_eq!(
            codex_models(&endless, Duration::from_secs(5), 4096),
            Err("E_AI_RESPONSE_TOO_LARGE")
        );

        let hung = write_script(dir.path(), "codex-hung", "exec sleep 5\n");
        let started = Instant::now();
        assert_eq!(
            codex_models(&hung, Duration::from_millis(200), MAX_CATALOG_BYTES),
            Err("E_AI_TIMEOUT")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let silent = write_script(dir.path(), "codex-silent", "exec 1>&- 2>&-\nexec sleep 5\n");
        assert_eq!(
            codex_models(&silent, Duration::from_millis(200), MAX_CATALOG_BYTES),
            Err("E_AI_TIMEOUT"),
            "output closed but still running"
        );
    }
}
