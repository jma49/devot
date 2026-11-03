//! Settings > Integrations connecting MCP clients to the bridge in this app's own binary
//! (`devot --cli mcp`, ADR 0012). The page names a client, never a file: each client's
//! config path is fixed here, and only the `devot` entry in it is ever added, replaced or removed.
//! Another client's settings stay byte for byte: JSON through raw values in their order, TOML by
//! replacing only Devot's lines and parsing the result to prove nothing else changed. A file that
//! does not parse is refused, never overwritten.

use crate::atomic_file::{Folder, Place};
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const SERVER: &str = "devot";
const TOML_HEADER: &str = "[mcp_servers.devot]";
const BRIDGE_ARGS: [&str; 2] = ["--cli", "mcp"];
const BACKUP_SUFFIX: &str = ".devot-backup";
/// Far past any real config, so a stray huge file is refused rather than held in memory.
const MAX_CONFIG_BYTES: u64 = 64 * 1024 * 1024;
const NEW_FILE_MODE: u32 = 0o600;
const EXTENSION_FILE: &str = "Devot.mcpb";
const LAUNCHER_PATH: &str = "server/devot-mcp.sh";
const LAUNCHER: &str = include_str!("../mcp/devot-mcp.sh");
const TOOLS: &str = include_str!("../mcp/tools.json");

const INVALID_CLIENT: &str = "E_MCP_CLIENT_INVALID";
const NO_APP: &str = "E_MCP_APP_NOT_FOUND";
const TEMPORARY: &str = "E_MCP_APP_NOT_INSTALLED";
const UNPARSABLE: &str = "E_MCP_CONFIG_UNPARSABLE";
const TOO_LARGE: &str = "E_MCP_CONFIG_TOO_LARGE";
const UNREADABLE: &str = "E_MCP_CONFIG_UNREADABLE";
const CHANGED: &str = "E_MCP_CONFIG_CHANGED";
const WRITE_FAILED: &str = "E_MCP_CONFIG_WRITE_FAILED";
const NOT_CONNECTED: &str = "E_MCP_NOT_CONNECTED";
const DANGLING: &str = "E_MCP_CONFIG_LINK_DANGLING";
const BAD_REVISION: &str = "E_MCP_REVISION_INVALID";
const MISSING: &str = "missing";
const CLI_FAILED: &str = "E_MCP_CLI_FAILED";
const CLI_TIMEOUT: &str = "E_MCP_CLI_TIMEOUT";
/// `claude mcp` answers in a moment; a hung one is stopped rather than left holding Settings.
const CLI_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
/// Where Homebrew, npm and Claude Code's own installer put `claude`, which a GUI app's short PATH
/// leaves out; in the home folder, then anywhere.
const CLAUDE_IN_HOME: [&str; 5] = [
    ".local/bin/claude",
    ".claude/local/claude",
    ".npm-global/bin/claude",
    ".volta/bin/claude",
    ".bun/bin/claude",
];
const CLAUDE_ANYWHERE: [&str; 2] = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
/// What `claude`, a Node script when npm installed it, needs to find `node` from a GUI app.
const CLI_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/// Devot's own changes to client configs go one at a time.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());
const EXTENSION_FAILED: &str = "E_MCP_EXTENSION_FAILED";
const HOME_UNAVAILABLE: &str = "E_MCP_HOME_UNAVAILABLE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Client {
    ClaudeCode,
    Codex,
    ClaudeDesktop,
}

const CLIENTS: [Client; 3] = [Client::ClaudeCode, Client::Codex, Client::ClaudeDesktop];

impl Client {
    fn parse(id: &str) -> Result<Self, &'static str> {
        CLIENTS
            .into_iter()
            .find(|client| client.id() == id)
            .ok_or(INVALID_CLIENT)
    }

    fn id(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claudeCode",
            Client::Codex => "codex",
            Client::ClaudeDesktop => "claudeDesktop",
        }
    }

    /// As each client documents and its own `mcp add` writes; a folder variable counts only when
    /// absolute, as a relative one would name a different file from Devot than from the client.
    fn config_path(self, home: &Path, env: impl Fn(&str) -> Option<OsString>) -> PathBuf {
        let folder = |name: &str, default: PathBuf| {
            env(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or(default)
        };
        match self {
            Client::ClaudeCode => {
                folder("CLAUDE_CONFIG_DIR", home.to_path_buf()).join(".claude.json")
            }
            Client::Codex => folder("CODEX_HOME", home.join(".codex")).join("config.toml"),
            Client::ClaudeDesktop => home
                .join("Library/Application Support/Claude")
                .join("claude_desktop_config.json"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
}

/// A JSON object in file order, with its values exactly as written.
struct RawObject(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for RawObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries;
        impl<'de> Visitor<'de> for Entries {
            type Value = RawObject;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawObject, A::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(RawObject(entries))
            }
        }
        deserializer.deserialize_map(Entries)
    }
}

impl Serialize for RawObject {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl RawObject {
    fn parse(text: &str) -> Result<Self, &'static str> {
        if text.trim().is_empty() {
            return Ok(Self(Vec::new()));
        }
        serde_json::from_str(text).map_err(|_| UNPARSABLE)
    }

    fn get(&self, key: &str) -> Option<&RawValue> {
        self.0
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_ref())
    }

    /// Stays in place when the key is there, so the file changes as little as it can.
    fn set(&mut self, key: &str, value: Box<RawValue>) {
        if let Some(found) = self.0.iter_mut().rev().find(|(name, _)| name == key) {
            found.1 = value;
        } else {
            self.0.push((key.to_owned(), value));
        }
    }

    /// A file may repeat a key, and only the last one counts; one entry remains after a connect.
    fn remove_duplicates_of(&mut self, key: &str) {
        let last = self.0.iter().rposition(|(name, _)| name == key);
        let mut at = 0;
        self.0.retain(|(name, _)| {
            let keep = name != key || Some(at) == last;
            at += 1;
            keep
        });
    }

    fn remove(&mut self, key: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|(name, _)| name != key);
        self.0.len() != before
    }

    fn to_text(&self) -> Result<String, &'static str> {
        let mut text = serde_json::to_string_pretty(self).map_err(|_| WRITE_FAILED)?;
        text.push('\n');
        Ok(text)
    }
}

fn raw(text: String) -> Result<Box<RawValue>, &'static str> {
    RawValue::from_string(text).map_err(|_| WRITE_FAILED)
}

/// What each client's own `mcp add` writes for a server run over stdio, in its order.
#[derive(Serialize)]
struct JsonEntry<'a> {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    command: &'a str,
    args: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<serde_json::Map<String, serde_json::Value>>,
}

fn json_entry<'a>(client: Client, launch: &'a Launch) -> JsonEntry<'a> {
    let claude_code = client == Client::ClaudeCode;
    JsonEntry {
        kind: claude_code.then_some("stdio"),
        command: &launch.command,
        args: &launch.args,
        env: claude_code.then(serde_json::Map::new),
    }
}

/// `mcpServers` at its place in a two-space file: entries already there keep their text as it is.
fn servers_text(
    servers: &RawObject,
    added: Option<(&str, String)>,
) -> Result<String, &'static str> {
    let mut lines = Vec::new();
    for (name, value) in &servers.0 {
        if added.as_ref().is_none_or(|(key, _)| key != name) {
            lines.push((name.as_str(), value.get().to_owned()));
        }
    }
    if let Some((key, text)) = added {
        let at = servers.0.iter().position(|(name, _)| name == key);
        let text = text.replace('\n', "\n    ");
        lines.insert(at.unwrap_or(lines.len()).min(lines.len()), (key, text));
    }
    if lines.is_empty() {
        return Ok(String::from("{}"));
    }
    let mut body = Vec::with_capacity(lines.len());
    for (name, value) in lines {
        let name = serde_json::to_string(name).map_err(|_| WRITE_FAILED)?;
        body.push(format!("    {name}: {value}"));
    }
    Ok(format!("{{\n{}\n  }}", body.join(",\n")))
}

fn toml_string(text: &str) -> String {
    toml::Value::String(text.to_owned()).to_string()
}

fn toml_entry(launch: &Launch) -> String {
    let args: Vec<String> = launch.args.iter().map(|arg| toml_string(arg)).collect();
    format!(
        "{TOML_HEADER}\ncommand = {}\nargs = [{}]\n",
        toml_string(&launch.command),
        args.join(", ")
    )
}

fn parse_toml(text: &str) -> Result<toml::Table, &'static str> {
    let table = text.parse::<toml::Table>().map_err(|_| UNPARSABLE)?;
    match table.get("mcp_servers") {
        Some(servers) if !servers.is_table() => Err(UNPARSABLE),
        _ => Ok(table),
    }
}

fn is_toml_header(line: &str) -> bool {
    line.trim_start().starts_with('[')
}

fn opens_devots_table(line: &str) -> bool {
    let line = line.trim();
    line == TOML_HEADER
        || line
            .strip_prefix("[mcp_servers.devot.")
            .is_some_and(|rest| rest.ends_with(']'))
}

/// `text` without the lines of Devot's table. Only a header at the start of a line counts, so an
/// array that spans lines may fool this; `without_toml_entry` refuses whatever that would change.
fn cut_toml_table(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        if is_toml_header(line) {
            inside = opens_devots_table(line);
        }
        if !inside {
            out.push_str(line);
        }
    }
    out
}

fn devot_removed(table: &toml::Table) -> toml::Table {
    let mut table = table.clone();
    let emptied = table
        .get_mut("mcp_servers")
        .and_then(toml::Value::as_table_mut)
        .is_some_and(|servers| {
            servers.remove(SERVER);
            servers.is_empty()
        });
    if emptied {
        table.remove("mcp_servers");
    }
    table
}

/// `text` with no Devot entry, proved by parsing: everything else means the same as before. An entry
/// written another way (dotted keys, an inline table) is left for the owner to edit.
fn without_toml_entry(text: &str) -> Result<String, &'static str> {
    let before = parse_toml(text)?;
    let cut = cut_toml_table(text);
    let after = parse_toml(&cut)?;
    let has_entry = after
        .get("mcp_servers")
        .and_then(toml::Value::as_table)
        .is_some_and(|servers| servers.contains_key(SERVER));
    if has_entry || devot_removed(&before) != devot_removed(&after) {
        return Err(UNPARSABLE);
    }
    let mut cut = cut;
    while cut.ends_with("\n\n") {
        cut.pop();
    }
    Ok(if cut.trim().is_empty() {
        String::new()
    } else {
        cut
    })
}

/// `text` with Devot's entry in it; `None` means the file is not there yet.
fn with_entry(client: Client, text: Option<&str>, launch: &Launch) -> Result<String, &'static str> {
    let text = text.unwrap_or("");
    if client == Client::Codex {
        let mut kept = without_toml_entry(text)?;
        if !kept.is_empty() {
            if !kept.ends_with('\n') {
                kept.push('\n');
            }
            kept.push('\n');
        }
        let merged = format!("{kept}{}", toml_entry(launch));
        let parsed = parse_toml(&merged).map_err(|_| UNPARSABLE)?;
        if devot_removed(&parsed) != devot_removed(&parse_toml(text)?) {
            return Err(UNPARSABLE);
        }
        return Ok(merged);
    }
    let mut top = RawObject::parse(text)?;
    let mut servers = match top.get("mcpServers") {
        Some(found) => RawObject::parse(found.get())?,
        None => RawObject(Vec::new()),
    };
    servers.remove_duplicates_of(SERVER);
    let entry =
        serde_json::to_string_pretty(&json_entry(client, launch)).map_err(|_| WRITE_FAILED)?;
    top.set(
        "mcpServers",
        raw(servers_text(&servers, Some((SERVER, entry)))?)?,
    );
    top.to_text()
}

/// `text` without Devot's entry, or `None` when it has none.
fn without_entry(client: Client, text: &str) -> Result<Option<String>, &'static str> {
    if client == Client::Codex {
        let has_entry = parse_toml(text)?
            .get("mcp_servers")
            .and_then(toml::Value::as_table)
            .is_some_and(|servers| servers.contains_key(SERVER));
        return if has_entry {
            without_toml_entry(text).map(Some)
        } else {
            Ok(None)
        };
    }
    let mut top = RawObject::parse(text)?;
    let Some(found) = top.get("mcpServers") else {
        return Ok(None);
    };
    let mut servers = RawObject::parse(found.get())?;
    if !servers.remove(SERVER) {
        return Ok(None);
    }
    top.set("mcpServers", raw(servers_text(&servers, None)?)?);
    top.to_text().map(Some)
}

/// What a client's config says about Devot; `None` for no entry, a launch with an empty command
/// for an entry that is not a command and arguments.
fn read_entry(client: Client, text: &str) -> Result<Option<Launch>, &'static str> {
    let strings = |values: Vec<Option<&str>>| {
        values
            .into_iter()
            .map(|value| value.map(String::from))
            .collect::<Option<Vec<_>>>()
            .unwrap_or_default()
    };
    if client == Client::Codex {
        let table = parse_toml(text)?;
        let Some(entry) = table
            .get("mcp_servers")
            .and_then(toml::Value::as_table)
            .and_then(|servers| servers.get(SERVER))
        else {
            return Ok(None);
        };
        let command = entry
            .get("command")
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .to_owned();
        let args = entry
            .get("args")
            .and_then(toml::Value::as_array)
            .map(|args| strings(args.iter().map(toml::Value::as_str).collect()))
            .unwrap_or_default();
        return Ok(Some(Launch { command, args }));
    }
    let top = RawObject::parse(text)?;
    let Some(found) = top.get("mcpServers") else {
        return Ok(None);
    };
    let servers = RawObject::parse(found.get())?;
    let Some(entry) = servers.get(SERVER) else {
        return Ok(None);
    };
    let entry: serde_json::Value = serde_json::from_str(entry.get()).map_err(|_| UNPARSABLE)?;
    let command = entry
        .get("command")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let args = entry
        .get("args")
        .and_then(serde_json::Value::as_array)
        .map(|args| strings(args.iter().map(serde_json::Value::as_str).collect()))
        .unwrap_or_default();
    Ok(Some(Launch { command, args }))
}

/// A config that may hold a symbolic link is written at the file it names, so the link stays.
/// A link whose target is gone is refused rather than replaced by a file: the owner keeps the file
/// elsewhere on purpose (a dotfiles folder, say), and a new one here would part the two silently.
fn real_path(path: &Path) -> Result<PathBuf, &'static str> {
    match std::fs::canonicalize(path) {
        Ok(real) => Ok(real),
        Err(_) if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) => {
            Err(DANGLING)
        }
        Err(_) => Ok(path.to_path_buf()),
    }
}

/// What the file held when Settings showed it: `missing`, or its SHA-256.
fn revision_of(text: Option<&str>) -> String {
    use sha2::Digest as _;
    text.map_or_else(
        || MISSING.to_owned(),
        |text| {
            sha2::Sha256::digest(text.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        },
    )
}

fn check_revision(revision: &str) -> Result<(), &'static str> {
    let hex = revision.len() == 64
        && revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (hex || revision == MISSING)
        .then_some(())
        .ok_or(BAD_REVISION)
}

fn read_config(path: &Path) -> Result<Option<String>, &'static str> {
    let path = real_path(path)?;
    match std::fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UNREADABLE),
        Ok(found) if !found.is_file() => return Err(UNREADABLE),
        Ok(found) if found.len() > MAX_CONFIG_BYTES => return Err(TOO_LARGE),
        Ok(_) => {}
    }
    match std::fs::read(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(UNREADABLE),
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| UNPARSABLE),
    }
}

fn place_with_mode(folder: &Folder, name: &OsStr, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let mut temp = folder.temporary_file(crate::atomic_file::temporary_name())?;
    temp.set_mode(std::fs::Permissions::from_mode(mode))?;
    temp.write_all(bytes)?;
    temp.place(folder, name, Place::Replace)
}

fn resolved_folder(path: &Path) -> Result<(Folder, OsString), &'static str> {
    let name = path.file_name().ok_or(WRITE_FAILED)?.to_owned();
    let parent = path.parent().ok_or(WRITE_FAILED)?;
    std::fs::create_dir_all(parent).map_err(|_| WRITE_FAILED)?;
    let parent = std::fs::canonicalize(parent).map_err(|_| WRITE_FAILED)?;
    let folder = Folder::open_resolved(&parent).map_err(|_| WRITE_FAILED)?;
    Ok((folder, name))
}

/// Replaces `path`, which must still hold `expected`: a client that wrote it in between keeps its
/// change. The file it replaces stays beside it as a backup, both with the same permissions. The
/// file is read again just before the rename. No lock the clients honour exists, so a client that
/// writes in the instant after that read can still lose its change; the dialog asks to quit it.
fn write_config(path: &Path, expected: Option<&str>, text: &str) -> Result<(), &'static str> {
    write_config_checking(path, expected, text, || {})
}

fn write_config_checking(
    path: &Path,
    expected: Option<&str>,
    text: &str,
    before_rename: impl FnOnce(),
) -> Result<(), &'static str> {
    let _writing = WRITING.lock().map_err(|_| WRITE_FAILED)?;
    let path = real_path(path)?;
    let (folder, name) = resolved_folder(&path)?;
    if read_config(&path)?.as_deref() != expected {
        return Err(CHANGED);
    }
    let mode = std::fs::metadata(&path)
        .map(|found| found.permissions().mode() & 0o777)
        .unwrap_or(NEW_FILE_MODE);
    let mut temp = folder
        .temporary_file(crate::atomic_file::temporary_name())
        .map_err(|_| WRITE_FAILED)?;
    temp.set_mode(std::fs::Permissions::from_mode(mode))
        .and_then(|()| temp.write_all(text.as_bytes()))
        .map_err(|_| WRITE_FAILED)?;
    before_rename();
    if read_config(&path)?.as_deref() != expected {
        return Err(CHANGED);
    }
    if let Some(current) = expected {
        let mut backup = name.clone();
        backup.push(BACKUP_SUFFIX);
        place_with_mode(&folder, &backup, current.as_bytes(), mode).map_err(|_| WRITE_FAILED)?;
    }
    temp.place(&folder, &name, Place::Replace)
        .map_err(|_| WRITE_FAILED)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    NotConnected,
    Connected,
    /// Devot's entry names the bridge of an app that has moved or was replaced.
    Stale,
    /// A `devot` entry Devot did not write, such as one that runs a checkout with Node.
    Other,
    Unreadable,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    client: &'static str,
    path: String,
    backup: String,
    state: ConnectionState,
    /// Why the file cannot be used, when `state` is `unreadable`.
    code: Option<&'static str>,
    /// The file is not there yet; Connect makes it.
    missing: bool,
    /// The exact text Connect adds; none without an installed binary to point at.
    preview: Option<String>,
    /// The file as shown (`revision_of`): Connect and Disconnect refuse once it has changed.
    revision: String,
    /// How Connect and Disconnect change it.
    via: Via,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Via {
    /// Devot edits the file itself.
    File,
    /// Claude Code's own `claude mcp`, which merges with the file Claude Code keeps rewriting.
    ClaudeCli,
}

fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(BACKUP_SUFFIX);
    path.with_file_name(name)
}

/// An entry only this feature writes: some Devot's binary, told to be the bridge.
fn is_bridge(entry: &Launch) -> bool {
    entry.args == BRIDGE_ARGS && Path::new(&entry.command).file_name() == Some(OsStr::new("devot"))
}

fn status(client: Client, path: &Path, launch: Option<&Launch>) -> ClientStatus {
    let mut found = ClientStatus {
        client: client.id(),
        path: path.to_string_lossy().into_owned(),
        backup: backup_of(path).to_string_lossy().into_owned(),
        state: ConnectionState::NotConnected,
        code: None,
        missing: false,
        preview: launch.and_then(|launch| with_entry(client, None, launch).ok()),
        revision: String::new(),
        via: Via::File,
    };
    let read = read_config(path).and_then(|text| {
        found.revision = revision_of(text.as_deref());
        match text {
            None => {
                found.missing = true;
                Ok(None)
            }
            Some(text) => read_entry(client, &text),
        }
    });
    match read {
        Err(code) => {
            found.state = ConnectionState::Unreadable;
            found.code = Some(code);
        }
        Ok(None) => {}
        Ok(Some(entry)) if launch == Some(&entry) => found.state = ConnectionState::Connected,
        Ok(Some(entry)) if is_bridge(&entry) => found.state = ConnectionState::Stale,
        Ok(Some(_)) => found.state = ConnectionState::Other,
    }
    found
}

fn connect(
    client: Client,
    path: &Path,
    launch: &Launch,
    shown: &str,
) -> Result<ClientStatus, &'static str> {
    let current = read_config(path)?;
    if revision_of(current.as_deref()) != shown {
        return Err(CHANGED);
    }
    let text = with_entry(client, current.as_deref(), launch)?;
    write_config(path, current.as_deref(), &text)?;
    Ok(status(client, path, Some(launch)))
}

fn disconnect(
    client: Client,
    path: &Path,
    launch: Option<&Launch>,
    shown: &str,
) -> Result<ClientStatus, &'static str> {
    let current = read_config(path)?.ok_or(NOT_CONNECTED)?;
    if revision_of(Some(&current)) != shown {
        return Err(CHANGED);
    }
    let text = without_entry(client, &current)?.ok_or(NOT_CONNECTED)?;
    write_config(path, Some(&current), &text)?;
    Ok(status(client, path, launch))
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The `claude` on `path_var`'s PATH, else in the places installers put it.
fn find_claude(
    path_var: Option<&OsStr>,
    home: &Path,
    executable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("claude"));
    let known = CLAUDE_ANYWHERE
        .iter()
        .map(PathBuf::from)
        .chain(CLAUDE_IN_HOME.iter().map(|rest| home.join(rest)));
    on_path.chain(known).find(|path| executable(path))
}

fn claude_cli(home: &Path) -> Option<PathBuf> {
    find_claude(std::env::var_os("PATH").as_deref(), home, is_executable)
}

fn add_args(launch: &Launch) -> Vec<String> {
    let mut args: Vec<String> = ["mcp", "add", "--scope", "user", SERVER, "--"]
        .map(String::from)
        .to_vec();
    args.push(launch.command.clone());
    args.extend(launch.args.iter().cloned());
    args
}

fn remove_args() -> Vec<String> {
    ["mcp", "remove", "--scope", "user", SERVER]
        .map(String::from)
        .to_vec()
}

/// A word as a POSIX shell would read it back: only for showing the command, never for running it.
fn shown_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@%+=:,./-_".contains(&b));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn shown_command(cli: &Path, args: &[String]) -> String {
    std::iter::once(cli.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|word| shown_word(&word))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The CLI's own folder first (a native install), then where `node` lives.
fn cli_path_for(cli: &Path) -> OsString {
    let mut path = OsString::new();
    if let Some(dir) = cli.parent() {
        path.push(dir);
        path.push(":");
    }
    if let Some(dir) = std::fs::canonicalize(cli)
        .ok()
        .as_deref()
        .and_then(Path::parent)
    {
        path.push(dir);
        path.push(":");
    }
    path.push(CLI_PATH);
    path
}

/// Runs `cli` with `args` as they are, no shell between; its output is the client's and is never
/// read or logged.
fn run_cli(cli: &Path, args: &[String], wait: std::time::Duration) -> Result<(), &'static str> {
    let mut child = std::process::Command::new(cli)
        .args(args)
        .env("PATH", cli_path_for(cli))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| CLI_FAILED)?;
    let until = std::time::Instant::now() + wait;
    loop {
        match child.try_wait() {
            Ok(Some(done)) if done.success() => return Ok(()),
            Ok(Some(_)) | Err(_) => return Err(CLI_FAILED),
            Ok(None) if std::time::Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CLI_TIMEOUT);
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// The status as `claude mcp` will change it, with the command it runs as the preview.
fn via_cli(mut found: ClientStatus, cli: &Path, launch: Option<&Launch>) -> ClientStatus {
    found.via = Via::ClaudeCli;
    found.preview = launch.map(|launch| shown_command(cli, &add_args(launch)));
    found
}

/// `claude mcp add` refuses a name that is taken, so an entry already there goes first.
fn connect_with_cli(
    cli: &Path,
    path: &Path,
    launch: &Launch,
    wait: std::time::Duration,
) -> Result<ClientStatus, &'static str> {
    let before = status(Client::ClaudeCode, path, Some(launch));
    if matches!(
        before.state,
        ConnectionState::Connected | ConnectionState::Stale | ConnectionState::Other
    ) {
        run_cli(cli, &remove_args(), wait)?;
    }
    run_cli(cli, &add_args(launch), wait)?;
    Ok(via_cli(
        status(Client::ClaudeCode, path, Some(launch)),
        cli,
        Some(launch),
    ))
}

fn disconnect_with_cli(
    cli: &Path,
    path: &Path,
    launch: Option<&Launch>,
    wait: std::time::Duration,
) -> Result<ClientStatus, &'static str> {
    run_cli(cli, &remove_args(), wait)?;
    Ok(via_cli(
        status(Client::ClaudeCode, path, launch),
        cli,
        launch,
    ))
}

/// Claude Code's status as Settings shows it: through its CLI when there is one.
fn shown_status(client: Client, path: &Path, launch: Option<&Launch>, home: &Path) -> ClientStatus {
    let found = status(client, path, launch);
    match (client, claude_cli(home)) {
        (Client::ClaudeCode, Some(cli)) => via_cli(found, &cli, launch),
        _ => found,
    }
}

/// The manifest of a Claude Desktop extension: a launcher, and nothing that runs a server itself,
/// so updates of the app reach it. It tries this copy of Devot first, then finds one that moved.
fn extension_manifest(bundle: &str, version: &str) -> Result<String, &'static str> {
    let tools: Vec<serde_json::Value> =
        serde_json::from_str(TOOLS).map_err(|_| EXTENSION_FAILED)?;
    let tools: Vec<serde_json::Value> = tools
        .iter()
        .map(|tool| serde_json::json!({ "name": tool["name"], "description": tool["title"] }))
        .collect();
    let manifest = serde_json::json!({
        "manifest_version": "0.3",
        "name": SERVER,
        "display_name": "Devot",
        "version": version,
        "description": "Search, read and edit Devot notes, only in notebooks that allow AI access. Needs Devot on this Mac.",
        "author": { "name": "Devot" },
        "icon": "icon.png",
        "server": {
            "type": "binary",
            "entry_point": LAUNCHER_PATH,
            "mcp_config": {
                "command": "/bin/sh",
                "args": [format!("${{__dirname}}/{LAUNCHER_PATH}"), bundle],
                "env": {},
            },
        },
        "tools": tools,
        "compatibility": { "platforms": ["darwin"] },
    });
    serde_json::to_string_pretty(&manifest).map_err(|_| EXTENSION_FAILED)
}

/// A `.mcpb` is a zip of the manifest and what it names: here the launcher and an icon, a few KB
/// beside the icon. The bridge stays in the app.
fn extension_bytes(bundle: &str, version: &str) -> Result<Vec<u8>, &'static str> {
    let manifest = extension_manifest(bundle, version)?;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in [
        ("manifest.json", manifest.as_bytes()),
        (LAUNCHER_PATH, LAUNCHER.as_bytes()),
        (
            "icon.png",
            include_bytes!("../icons/128x128@2x.png").as_slice(),
        ),
    ] {
        zip.start_file(name, options)
            .map_err(|_| EXTENSION_FAILED)?;
        zip.write_all(bytes).map_err(|_| EXTENSION_FAILED)?;
    }
    zip.finish()
        .map(std::io::Cursor::into_inner)
        .map_err(|_| EXTENSION_FAILED)
}

/// What Settings > Integrations shows and writes configs with.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetup {
    /// The binary whose bridge a client runs.
    command: Option<String>,
    args: Vec<String>,
    /// The app runs from a disk image or a translocated copy: Connect waits until it is installed.
    temporary: bool,
    clients: Vec<ClientStatus>,
}

fn launch_of(executable: &Path) -> Option<Launch> {
    Some(Launch {
        command: executable.to_str()?.to_owned(),
        args: BRIDGE_ARGS.map(String::from).to_vec(),
    })
}

fn current_launch() -> Option<Launch> {
    launch_of(&std::env::current_exe().ok()?)
}

fn home(app: &AppHandle) -> Result<PathBuf, &'static str> {
    app.path().home_dir().map_err(|_| HOME_UNAVAILABLE)
}

fn client_path(client: Client, home: &Path) -> PathBuf {
    client.config_path(home, |name| std::env::var_os(name))
}

fn is_temporary(executable: &str) -> bool {
    crate::cli_tool::temporary_location(
        Path::new(executable),
        crate::atomic_file::on_read_only_volume,
    )
}

fn installed_launch() -> Result<Launch, &'static str> {
    let launch = current_launch().ok_or(NO_APP)?;
    if is_temporary(&launch.command) {
        return Err(TEMPORARY);
    }
    Ok(launch)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| String::from("E_MCP_TASK_FAILED"))?
        .map_err(String::from)
}

/// Takes no arguments: what it reads is fixed here.
#[tauri::command]
pub async fn settings_mcp_setup(app: AppHandle) -> Result<McpSetup, String> {
    blocking(move || {
        let home = home(&app)?;
        let launch = current_launch();
        Ok(McpSetup {
            command: launch.as_ref().map(|launch| launch.command.clone()),
            args: BRIDGE_ARGS.map(String::from).to_vec(),
            temporary: launch.as_ref().is_some_and(|l| is_temporary(&l.command)),
            clients: CLIENTS
                .into_iter()
                .map(|client| {
                    shown_status(client, &client_path(client, &home), launch.as_ref(), &home)
                })
                .collect(),
        })
    })
    .await
}

/// Writes the entry, and turns MCP on: a client connected to a closed door would only confuse.
#[tauri::command]
pub async fn settings_mcp_connect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    client: String,
    revision: String,
) -> Result<ClientStatus, String> {
    from_settings(&window)?;
    let client = Client::parse(&client).map_err(String::from)?;
    check_revision(&revision)?;
    blocking(move || {
        let launch = installed_launch()?;
        let home = home(&app)?;
        let path = client_path(client, &home);
        let cli = (client == Client::ClaudeCode)
            .then(|| claude_cli(&home))
            .flatten();
        let done = match &cli {
            Some(cli) => connect_with_cli(cli, &path, &launch, CLI_WAIT),
            None => connect(client, &path, &launch, &revision),
        };
        match &done {
            Ok(_) => {
                log::info!("I_MCP_CLIENT_CONNECTED {}", client.id());
                app.state::<Arc<crate::http_api::HttpApi>>().mcp_turn_on()?;
            }
            Err(code) => log::warn!("W_MCP_CLIENT_CONNECT_FAILED {} {code}", client.id()),
        }
        done
    })
    .await
}

#[tauri::command]
pub async fn settings_mcp_disconnect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    client: String,
    revision: String,
) -> Result<ClientStatus, String> {
    from_settings(&window)?;
    let client = Client::parse(&client).map_err(String::from)?;
    check_revision(&revision)?;
    blocking(move || {
        let launch = current_launch();
        let home = home(&app)?;
        let path = client_path(client, &home);
        let cli = (client == Client::ClaudeCode)
            .then(|| claude_cli(&home))
            .flatten();
        let done = match &cli {
            Some(cli) => disconnect_with_cli(cli, &path, launch.as_ref(), CLI_WAIT),
            None => disconnect(client, &path, launch.as_ref(), &revision),
        };
        match &done {
            Ok(_) => log::info!("I_MCP_CLIENT_DISCONNECTED {}", client.id()),
            Err(code) => log::warn!("W_MCP_CLIENT_DISCONNECT_FAILED {} {code}", client.id()),
        }
        done
    })
    .await
}

fn bundle_path(executable: &Path) -> Option<&str> {
    executable.parent()?.parent()?.parent()?.to_str()
}

/// Writes the extension to the app's cache and hands it to whichever app opens `.mcpb` files.
#[tauri::command]
pub async fn settings_mcp_open_extension(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    from_settings(&window)?;
    blocking(move || {
        let launch = installed_launch()?;
        let bundle = bundle_path(Path::new(&launch.command)).ok_or(NO_APP)?;
        let bytes = extension_bytes(bundle, &app.package_info().version.to_string())?;
        let cache = app.path().app_cache_dir().map_err(|_| EXTENSION_FAILED)?;
        let (folder, _) = resolved_folder(&cache.join(EXTENSION_FILE))?;
        place_with_mode(&folder, OsStr::new(EXTENSION_FILE), &bytes, NEW_FILE_MODE)
            .map_err(|_| EXTENSION_FAILED)?;
        app.state::<Arc<crate::http_api::HttpApi>>().mcp_turn_on()?;
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(cache.join(EXTENSION_FILE))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if opened.is_ok_and(|status| status.success()) {
            return Ok(());
        }
        log::warn!("W_MCP_EXTENSION_OPEN_FAILED");
        Err("E_MCP_EXTENSION_OPEN_FAILED")
    })
    .await
}

fn from_settings(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == crate::settings::LABEL {
        Ok(())
    } else {
        Err(String::from("E_MCP_WINDOW"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRIDGE: &str = "/Applications/My Apps/Devot.app/Contents/MacOS/devot";
    const OLD_BRIDGE: &str = "/Users/me/Downloads/Devot.app/Contents/MacOS/devot";

    fn args() -> Vec<String> {
        BRIDGE_ARGS.map(String::from).to_vec()
    }

    fn launch() -> Launch {
        Launch {
            command: BRIDGE.to_owned(),
            args: args(),
        }
    }

    fn shown(path: &Path) -> String {
        revision_of(read_config(path).unwrap().as_deref())
    }

    fn config_in(dir: &tempfile::TempDir, client: Client) -> PathBuf {
        client.config_path(dir.path(), |_| None)
    }

    const CLAUDE_JSON: &str = "{\n  \"zeta\": 1.0000000000000000001,\n  \"oauthAccount\": {\n    \"token\": \"keep\"\n  },\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    }\n  },\n  \"alpha\": [1, 2]\n}\n";

    const CODEX_TOML: &str = "# my comment\nmodel = \"gpt\"\n\n[mcp_servers.other]\n# keep me\ncommand = \"x\"\n\n[profiles.a]\nb = 1\n";

    #[test]
    fn paths_follow_each_client_and_only_an_absolute_folder_variable() {
        let home = Path::new("/Users/me");
        let none = |_: &str| None;
        assert_eq!(
            Client::ClaudeCode.config_path(home, none),
            Path::new("/Users/me/.claude.json"),
        );
        assert_eq!(
            Client::Codex.config_path(home, none),
            Path::new("/Users/me/.codex/config.toml"),
        );
        assert_eq!(
            Client::ClaudeDesktop.config_path(home, none),
            Path::new("/Users/me/Library/Application Support/Claude/claude_desktop_config.json"),
        );
        let set = |value: &'static str| move |_: &str| Some(OsString::from(value));
        assert_eq!(
            Client::Codex.config_path(home, set("/opt/codex")),
            Path::new("/opt/codex/config.toml"),
        );
        assert_eq!(
            Client::ClaudeCode.config_path(home, set("/opt/claude")),
            Path::new("/opt/claude/.claude.json"),
        );
        assert_eq!(
            Client::Codex.config_path(home, set("relative")),
            Path::new("/Users/me/.codex/config.toml"),
        );
    }

    #[test]
    fn refuses_any_client_it_does_not_know() {
        for bad in ["", "claude", "../etc/passwd", "CODEX", "claudeCode "] {
            assert_eq!(Client::parse(bad), Err(INVALID_CLIENT));
        }
        for client in CLIENTS {
            assert_eq!(Client::parse(client.id()), Ok(client));
        }
    }

    #[test]
    fn json_entries_match_what_each_clients_own_command_writes() {
        let text = with_entry(Client::ClaudeCode, None, &launch()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed["mcpServers"]["devot"],
            serde_json::json!({
                "type": "stdio",
                "command": BRIDGE,
                "args": ["--cli", "mcp"],
                "env": {},
            }),
        );
        let text = with_entry(Client::ClaudeDesktop, None, &launch()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed["mcpServers"]["devot"],
            serde_json::json!({ "command": BRIDGE, "args": ["--cli", "mcp"] }),
        );
    }

    #[test]
    fn toml_entry_matches_what_codex_writes() {
        assert_eq!(
            with_entry(Client::Codex, None, &launch()).unwrap(),
            format!("[mcp_servers.devot]\ncommand = \"{BRIDGE}\"\nargs = [\"--cli\", \"mcp\"]\n"),
        );
    }

    #[test]
    fn a_new_entry_is_laid_out_as_the_clients_write_it() {
        assert_eq!(
            with_entry(Client::ClaudeCode, None, &launch()).unwrap(),
            format!(
                "{{\n  \"mcpServers\": {{\n    \"devot\": {{\n      \"type\": \"stdio\",\n      \"command\": \"{BRIDGE}\",\n      \"args\": [\n        \"--cli\",\n        \"mcp\"\n      ],\n      \"env\": {{}}\n    }}\n  }}\n}}\n"
            ),
        );
    }

    #[test]
    fn the_preview_shows_each_line_the_merge_writes() {
        let launch = launch();
        for client in CLIENTS {
            let preview = status(client, Path::new("/nonexistent/x"), Some(&launch))
                .preview
                .unwrap();
            let merged = with_entry(
                client,
                Some(if client == Client::Codex {
                    CODEX_TOML
                } else {
                    CLAUDE_JSON
                }),
                &launch,
            )
            .unwrap();
            let entry: Vec<_> = preview
                .lines()
                .filter(|line| line.contains(BRIDGE) || line.contains("args"))
                .collect();
            assert!(!entry.is_empty());
            for line in entry {
                assert!(merged.contains(line), "{line}");
            }
        }
    }

    #[test]
    fn a_merged_file_changes_only_at_the_entry() {
        let merged = with_entry(Client::ClaudeDesktop, Some(CLAUDE_JSON), &launch()).unwrap();
        assert_eq!(
            merged,
            format!(
                "{{\n  \"zeta\": 1.0000000000000000001,\n  \"oauthAccount\": {{\n    \"token\": \"keep\"\n  }},\n  \"mcpServers\": {{\n    \"other\": {{\n      \"command\": \"x\"\n    }},\n    \"devot\": {{\n      \"command\": \"{BRIDGE}\",\n      \"args\": [\n        \"--cli\",\n        \"mcp\"\n      ]\n    }}\n  }},\n  \"alpha\": [1, 2]\n}}\n"
            ),
        );
        let back = without_entry(Client::ClaudeDesktop, &merged)
            .unwrap()
            .unwrap();
        assert_eq!(back, CLAUDE_JSON);
    }

    #[test]
    fn json_merge_keeps_every_other_key_value_and_order() {
        let text = with_entry(Client::ClaudeCode, Some(CLAUDE_JSON), &launch()).unwrap();
        assert!(text.contains("\"zeta\": 1.0000000000000000001"));
        assert!(text.contains("\"token\": \"keep\""));
        let order: Vec<usize> = [
            "\"zeta\"",
            "\"oauthAccount\"",
            "\"mcpServers\"",
            "\"alpha\"",
        ]
        .iter()
        .map(|key| text.find(key).unwrap())
        .collect();
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]));
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["mcpServers"]["other"]["command"], "x");
        assert_eq!(parsed["mcpServers"]["devot"]["command"], BRIDGE);
        assert_eq!(parsed["alpha"], serde_json::json!([1, 2]));
    }

    #[test]
    fn toml_merge_keeps_comments_and_other_tables() {
        let text = with_entry(Client::Codex, Some(CODEX_TOML), &launch()).unwrap();
        for kept in [
            "# my comment",
            "# keep me",
            "[mcp_servers.other]",
            "[profiles.a]",
        ] {
            assert!(text.contains(kept), "{kept} was lost");
        }
        assert_eq!(read_entry(Client::Codex, &text).unwrap(), Some(launch()),);
        assert!(text.contains("[mcp_servers.devot]"));
    }

    #[test]
    fn disconnect_removes_only_devots_entry() {
        let connected = with_entry(Client::ClaudeDesktop, Some(CLAUDE_JSON), &launch()).unwrap();
        let text = without_entry(Client::ClaudeDesktop, &connected)
            .unwrap()
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(parsed["mcpServers"].get("devot").is_none());
        assert_eq!(parsed["mcpServers"]["other"]["command"], "x");
        assert!(text.contains("\"token\": \"keep\""));

        let connected = with_entry(Client::Codex, Some(CODEX_TOML), &launch()).unwrap();
        let text = without_entry(Client::Codex, &connected).unwrap().unwrap();
        assert!(!text.contains("devot"));
        assert!(text.contains("# keep me") && text.contains("[mcp_servers.other]"));

        assert_eq!(without_entry(Client::Codex, CODEX_TOML).unwrap(), None);
        assert_eq!(without_entry(Client::ClaudeCode, "{}").unwrap(), None);
    }

    #[test]
    fn a_file_that_does_not_parse_or_has_the_wrong_shape_is_refused() {
        for bad in [
            "{ not json",
            "[1]",
            "{\"mcpServers\": []}",
            "{\"mcpServers\": 3}",
        ] {
            assert_eq!(
                with_entry(Client::ClaudeDesktop, Some(bad), &launch()),
                Err(UNPARSABLE),
                "{bad}",
            );
        }
        for bad in [
            "not toml = = 3",
            "mcp_servers = 3",
            "mcp_servers = { a = 1 }",
        ] {
            assert_eq!(
                with_entry(Client::Codex, Some(bad), &launch()),
                Err(UNPARSABLE),
                "{bad}",
            );
        }
    }

    #[test]
    fn connect_leaves_an_unparsable_file_exactly_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, "{ broken").unwrap();
        assert_eq!(
            connect(Client::ClaudeCode, &path, &launch(), &shown(&path)),
            Err(UNPARSABLE),
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
        assert!(!backup_of(&path).exists());
        let found = status(Client::ClaudeCode, &path, Some(&launch()));
        assert_eq!(found.state, ConnectionState::Unreadable);
        assert_eq!(found.code, Some(UNPARSABLE));
    }

    #[test]
    fn connect_writes_a_backup_keeps_permissions_and_is_then_connected() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, CLAUDE_JSON).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();

        let found = connect(Client::ClaudeCode, &path, &launch(), &shown(&path)).unwrap();
        assert_eq!(found.state, ConnectionState::Connected);
        assert_eq!(
            std::fs::read_to_string(backup_of(&path)).unwrap(),
            CLAUDE_JSON
        );
        for file in [&path, &backup_of(&path)] {
            let mode = std::fs::metadata(file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o640);
        }
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 2, "no temporary file stays behind");
    }

    #[test]
    fn connect_makes_a_missing_file_and_folder_readable_by_the_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        for client in CLIENTS {
            let path = config_in(&dir, client);
            assert!(status(client, &path, Some(&launch())).missing);
            let found = connect(client, &path, &launch(), &shown(&path)).unwrap();
            assert_eq!(found.state, ConnectionState::Connected);
            assert!(!found.missing);
            assert!(!backup_of(&path).exists());
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, NEW_FILE_MODE);
        }
    }

    #[test]
    fn a_config_that_changed_while_writing_keeps_the_clients_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, "{\"a\": 1}").unwrap();
        assert_eq!(
            write_config(&path, Some("{}"), "{\"overwritten\": true}"),
            Err(CHANGED),
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\": 1}");
    }

    #[test]
    fn a_symbolic_link_stays_and_the_file_it_names_changes() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("dotfiles/claude.json");
        std::fs::create_dir(dir.path().join("dotfiles")).unwrap();
        std::fs::write(&real, "{}").unwrap();
        let link = dir.path().join(".claude.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        connect(Client::ClaudeCode, &link, &launch(), &shown(&link)).unwrap();
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(std::fs::read_to_string(&real).unwrap().contains(BRIDGE));
    }

    #[test]
    fn tells_connected_from_a_moved_app_and_an_entry_devot_did_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeDesktop);
        let state = |path: &Path| status(Client::ClaudeDesktop, path, Some(&launch())).state;
        assert_eq!(state(&path), ConnectionState::NotConnected);

        connect(Client::ClaudeDesktop, &path, &launch(), &shown(&path)).unwrap();
        assert_eq!(state(&path), ConnectionState::Connected);

        let moved = Launch {
            command: OLD_BRIDGE.to_owned(),
            args: args(),
        };
        connect(Client::ClaudeDesktop, &path, &moved, &shown(&path)).unwrap();
        assert_eq!(state(&path), ConnectionState::Stale);

        let node = Launch {
            command: "node".to_owned(),
            args: vec!["/code/dist-mcp/devot-mcp.mjs".to_owned()],
        };
        connect(Client::ClaudeDesktop, &path, &node, &shown(&path)).unwrap();
        assert_eq!(state(&path), ConnectionState::Other);

        std::fs::write(&path, "{\"mcpServers\": {\"devot\": 3}}").unwrap();
        assert_eq!(state(&path), ConnectionState::Other);
    }

    #[test]
    fn connect_again_replaces_the_entry_and_disconnect_needs_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::Codex);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, CODEX_TOML).unwrap();
        let moved = Launch {
            command: OLD_BRIDGE.to_owned(),
            args: args(),
        };
        connect(Client::Codex, &path, &moved, &shown(&path)).unwrap();
        let found = connect(Client::Codex, &path, &launch(), &shown(&path)).unwrap();
        assert_eq!(found.state, ConnectionState::Connected);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(OLD_BRIDGE));
        assert_eq!(text.matches("[mcp_servers.devot]").count(), 1);

        let found = disconnect(Client::Codex, &path, Some(&launch()), &shown(&path)).unwrap();
        assert_eq!(found.state, ConnectionState::NotConnected);
        assert_eq!(
            disconnect(Client::Codex, &path, Some(&launch()), &shown(&path)),
            Err(NOT_CONNECTED),
        );
    }

    #[test]
    fn empty_files_count_as_empty_configs() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, "\n").unwrap();
        let found = connect(Client::ClaudeCode, &path, &launch(), &shown(&path)).unwrap();
        assert_eq!(found.state, ConnectionState::Connected);
    }

    #[test]
    fn runs_this_binary_as_the_bridge() {
        let launch = launch_of(Path::new(BRIDGE)).unwrap();
        assert_eq!(launch.command, BRIDGE);
        assert_eq!(launch.args, ["--cli", "mcp"]);
        assert_eq!(
            bundle_path(Path::new(BRIDGE)),
            Some("/Applications/My Apps/Devot.app")
        );
    }

    #[test]
    fn writes_no_token_into_any_client_config() {
        for client in CLIENTS {
            let text = with_entry(client, None, &launch()).unwrap();
            assert!(!text.contains("dvt_") && !text.to_lowercase().contains("token"));
            assert!(!text.contains("node"));
        }
    }

    #[test]
    fn toml_entries_written_another_way_are_left_for_the_owner() {
        for other in [
            "mcp_servers.devot.command = \"x\"\n",
            "[mcp_servers]\ndevot = { command = \"x\" }\n",
        ] {
            assert_eq!(
                with_entry(Client::Codex, Some(other), &launch()),
                Err(UNPARSABLE),
                "{other}"
            );
            assert_eq!(
                without_entry(Client::Codex, other),
                Err(UNPARSABLE),
                "{other}"
            );
        }
    }

    #[test]
    fn a_toml_entrys_sub_tables_go_with_it_and_other_tables_stay_exactly() {
        let text = "a = 1 # keep\n\n[mcp_servers.devot]\ncommand = \"x\"\n\n[mcp_servers.devot.env]\nA = \"b\"\n\n[mcp_servers.devotion]\ncommand = \"y\"\n";
        let back = without_entry(Client::Codex, text).unwrap().unwrap();
        assert_eq!(
            back,
            "a = 1 # keep\n\n[mcp_servers.devotion]\ncommand = \"y\"\n"
        );
    }

    #[test]
    fn a_header_lookalike_in_a_multi_line_array_never_loses_data() {
        let text =
            "[mcp_servers.devot]\nargs = [\n  \"x\",\n]\n\n[other]\nkeep = [\n  [1],\n  [2],\n]\n";
        let done = with_entry(Client::Codex, Some(text), &launch()).unwrap();
        let parsed = parse_toml(&done).unwrap();
        assert_eq!(parsed["other"], parse_toml(text).unwrap()["other"]);
        assert_eq!(read_entry(Client::Codex, &done).unwrap(), Some(launch()));
    }

    #[test]
    fn the_extension_is_a_zip_whose_manifest_runs_the_launcher_with_this_app() {
        let bytes = extension_bytes("/Applications/My Apps/Devot.app", "1.2.3").unwrap();
        assert!(bytes.len() < 256 * 1024, "{}", bytes.len());
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(archive.by_name("icon.png").is_ok());
        assert!(archive.by_name(LAUNCHER_PATH).is_ok());
        let manifest: serde_json::Value =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(manifest["manifest_version"], "0.3");
        assert_eq!(manifest["version"], "1.2.3");
        assert_eq!(manifest["server"]["type"], "binary");
        assert_eq!(manifest["server"]["entry_point"], LAUNCHER_PATH);
        let config = &manifest["server"]["mcp_config"];
        assert_eq!(config["command"], "/bin/sh");
        assert_eq!(config["args"][0], "${__dirname}/server/devot-mcp.sh");
        assert_eq!(config["args"][1], "/Applications/My Apps/Devot.app");
        assert_eq!(manifest["compatibility"]["platforms"][0], "darwin");
        assert_eq!(manifest["tools"].as_array().unwrap().len(), 8);
    }

    #[test]
    fn the_launcher_runs_the_bridge_and_keeps_stdout_for_mcp() {
        assert!(LAUNCHER.contains("--cli mcp"));
        assert!(LAUNCHER.contains("E_MCP_APP_NOT_FOUND"));
        assert!(
            !LAUNCHER
                .lines()
                .any(|line| line.trim_start().starts_with("echo ") && !line.contains(">&2"))
        );
    }

    #[test]
    fn refuses_a_file_that_changed_since_it_was_shown() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, CLAUDE_JSON).unwrap();
        let before = shown(&path);
        std::fs::write(&path, "{\"theirs\": 1}").unwrap();
        assert_eq!(
            connect(Client::ClaudeCode, &path, &launch(), &before),
            Err(CHANGED)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"theirs\": 1}");
        assert!(!backup_of(&path).exists());
        connect(Client::ClaudeCode, &path, &launch(), &shown(&path)).unwrap();
        let stale = revision_of(Some(CLAUDE_JSON));
        assert_eq!(
            disconnect(Client::ClaudeCode, &path, Some(&launch()), &stale),
            Err(CHANGED)
        );
    }

    #[test]
    fn a_client_that_saves_just_before_the_rename_keeps_its_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, "{}").unwrap();
        let theirs = "{\"saved\": \"by the client\"}";
        let done = write_config_checking(&path, Some("{}"), "{\"devot\": 1}", || {
            std::fs::write(&path, theirs).unwrap();
        });
        assert_eq!(done, Err(CHANGED));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), theirs);
        assert!(
            !backup_of(&path).exists(),
            "no backup of a change never made"
        );
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 1, "no temporary file stays behind");
    }

    #[test]
    fn a_link_whose_target_is_gone_is_refused_and_stays_a_link() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join(".claude.json");
        std::os::unix::fs::symlink(dir.path().join("dotfiles/gone.json"), &link).unwrap();
        let found = status(Client::ClaudeCode, &link, Some(&launch()));
        assert_eq!(found.state, ConnectionState::Unreadable);
        assert_eq!(found.code, Some(DANGLING));
        assert_eq!(write_config(&link, None, "{}"), Err(DANGLING));
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn a_revision_is_missing_or_a_sha256() {
        assert_eq!(check_revision(MISSING), Ok(()));
        assert_eq!(check_revision(&revision_of(Some("x"))), Ok(()));
        for bad in ["", "MISSING", &"A".repeat(64), &"a".repeat(63), "../x"] {
            assert_eq!(check_revision(bad), Err(BAD_REVISION), "{bad}");
        }
    }

    fn fake_claude(dir: &Path, exit: u8) -> (PathBuf, PathBuf) {
        let log = dir.join("calls");
        let cli = dir.join("bin/claude");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        let script = format!(
            "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '{}'; done\necho @@end >> '{}'\necho \"$PATH\" > '{}.path'\nexit {exit}\n",
            log.display(),
            log.display(),
            log.display()
        );
        std::fs::write(&cli, script).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        (cli, log)
    }

    fn calls(log: &Path) -> Vec<Vec<String>> {
        std::fs::read_to_string(log)
            .unwrap_or_default()
            .split("@@end\n")
            .filter(|call| !call.is_empty())
            .map(|call| call.lines().map(String::from).collect())
            .collect()
    }

    #[test]
    fn finds_claude_on_the_path_then_where_installers_put_it() {
        let home = Path::new("/Users/me");
        let only = |wanted: &'static str| move |path: &Path| path == Path::new(wanted);
        assert_eq!(
            find_claude(Some(OsStr::new("/a:relative:/b")), home, only("/b/claude")),
            Some(PathBuf::from("/b/claude"))
        );
        assert_eq!(
            find_claude(Some(OsStr::new("relative")), home, only("relative/claude")),
            None,
            "a relative PATH entry names a different file for Devot"
        );
        assert_eq!(
            find_claude(
                Some(OsStr::new("/usr/bin:/bin")),
                home,
                only("/opt/homebrew/bin/claude")
            ),
            Some(PathBuf::from("/opt/homebrew/bin/claude"))
        );
        assert_eq!(
            find_claude(None, home, only("/Users/me/.npm-global/bin/claude")),
            Some(PathBuf::from("/Users/me/.npm-global/bin/claude"))
        );
        assert_eq!(find_claude(None, home, |_| false), None);
    }

    #[test]
    fn connects_claude_code_through_its_cli_with_each_argument_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let (cli, log) = fake_claude(dir.path(), 0);
        let path = config_in(&dir, Client::ClaudeCode);
        let found = connect_with_cli(&cli, &path, &launch(), CLI_WAIT).unwrap();
        assert_eq!(
            calls(&log),
            [vec![
                "mcp", "add", "--scope", "user", "devot", "--", BRIDGE, "--cli", "mcp"
            ]]
        );
        assert!(!path.exists(), "the file is the CLI's to write");
        assert_eq!(found.via, Via::ClaudeCli);
        assert_eq!(
            found.preview.as_deref(),
            Some(
                format!(
                    "{} mcp add --scope user devot -- '{BRIDGE}' --cli mcp",
                    cli.display()
                )
                .as_str()
            )
        );
        let path_used = std::fs::read_to_string(format!("{}.path", log.display())).unwrap();
        assert!(path_used.starts_with(&format!("{}:", cli.parent().unwrap().display())));
        assert!(path_used.contains("/opt/homebrew/bin"));
    }

    #[test]
    fn replaces_an_entry_through_the_cli_by_removing_it_first() {
        let dir = tempfile::tempdir().unwrap();
        let (cli, log) = fake_claude(dir.path(), 0);
        let path = config_in(&dir, Client::ClaudeCode);
        let moved = Launch {
            command: OLD_BRIDGE.to_owned(),
            args: args(),
        };
        std::fs::write(&path, with_entry(Client::ClaudeCode, None, &moved).unwrap()).unwrap();
        connect_with_cli(&cli, &path, &launch(), CLI_WAIT).unwrap();
        let made = calls(&log);
        assert_eq!(made[0], ["mcp", "remove", "--scope", "user", "devot"]);
        assert_eq!(made[1][1], "add");
        disconnect_with_cli(&cli, &path, Some(&launch()), CLI_WAIT).unwrap();
        assert_eq!(
            calls(&log)[2],
            ["mcp", "remove", "--scope", "user", "devot"]
        );
    }

    #[test]
    fn a_cli_that_fails_or_hangs_answers_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let (cli, _) = fake_claude(dir.path(), 1);
        let path = config_in(&dir, Client::ClaudeCode);
        assert_eq!(
            connect_with_cli(&cli, &path, &launch(), CLI_WAIT).unwrap_err(),
            CLI_FAILED
        );
        let slow = dir.path().join("slow");
        std::fs::write(&slow, "#!/bin/sh\nsleep 5\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            run_cli(&slow, &remove_args(), std::time::Duration::from_millis(200)),
            Err(CLI_TIMEOUT)
        );
    }

    #[test]
    fn shows_the_command_as_a_shell_would_read_it() {
        assert_eq!(shown_word("/a/b-c_d"), "/a/b-c_d");
        assert_eq!(shown_word("/My Apps/x"), "'/My Apps/x'");
        assert_eq!(shown_word("it's"), "'it'\\''s'");
        assert_eq!(shown_word(""), "''");
    }
}
