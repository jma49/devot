//! Settings > Integrations connecting MCP clients to the helper inside Devot.app
//! (docs/architecture.md, Setup helper). The page names a client, never a file: each client's
//! config path is fixed here, and only the `devot` entry in it is ever added, replaced or removed.
//! Another client's settings stay byte for byte: JSON through raw values in their order, TOML
//! through a format-keeping parser. A file that does not parse is refused, never overwritten.

use crate::atomic_file::{Folder, Place};
use serde::de::{MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

const SERVER: &str = "devot";
const HELPER_FOLDER: &str = "Helpers";
const HELPER_FILE: &str = "devot-mcp";
const BACKUP_SUFFIX: &str = ".devot-backup";
/// Far past any real config, so a stray huge file is refused rather than held in memory.
const MAX_CONFIG_BYTES: u64 = 64 * 1024 * 1024;
const NEW_FILE_MODE: u32 = 0o600;

const INVALID_CLIENT: &str = "E_MCP_CLIENT_INVALID";
const NO_HELPER: &str = "E_MCP_HELPER_NOT_FOUND";
const TEMPORARY: &str = "E_MCP_APP_NOT_INSTALLED";
const UNPARSABLE: &str = "E_MCP_CONFIG_UNPARSABLE";
const TOO_LARGE: &str = "E_MCP_CONFIG_TOO_LARGE";
const UNREADABLE: &str = "E_MCP_CONFIG_UNREADABLE";
const CHANGED: &str = "E_MCP_CONFIG_CHANGED";
const WRITE_FAILED: &str = "E_MCP_CONFIG_WRITE_FAILED";
const NOT_CONNECTED: &str = "E_MCP_NOT_CONNECTED";
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

fn toml_entry(launch: &Launch) -> toml_edit::Table {
    let mut args = toml_edit::Array::new();
    for arg in &launch.args {
        args.push(arg.as_str());
    }
    let mut entry = toml_edit::Table::new();
    entry["command"] = toml_edit::value(launch.command.as_str());
    entry["args"] = toml_edit::value(args);
    entry
}

fn parse_toml(text: &str) -> Result<toml_edit::DocumentMut, &'static str> {
    let document = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| UNPARSABLE)?;
    match document.get("mcp_servers") {
        // An inline table cannot hold a `[mcp_servers.devot]` table; left for the owner to edit.
        Some(item) if !item.is_table() => Err(UNPARSABLE),
        _ => Ok(document),
    }
}

/// `text` with Devot's entry in it; `None` means the file is not there yet.
fn with_entry(client: Client, text: Option<&str>, launch: &Launch) -> Result<String, &'static str> {
    let text = text.unwrap_or("");
    if client == Client::Codex {
        let mut document = parse_toml(text)?;
        if document.get("mcp_servers").is_none() {
            let mut servers = toml_edit::Table::new();
            servers.set_implicit(true);
            document.insert("mcp_servers", toml_edit::Item::Table(servers));
        }
        let servers = document["mcp_servers"].as_table_mut().ok_or(UNPARSABLE)?;
        servers.insert(SERVER, toml_edit::Item::Table(toml_entry(launch)));
        return Ok(document.to_string());
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
        let mut document = parse_toml(text)?;
        let removed = document
            .get_mut("mcp_servers")
            .and_then(toml_edit::Item::as_table_mut)
            .and_then(|servers| servers.remove(SERVER))
            .is_some();
        return Ok(removed.then(|| document.to_string()));
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
        let document = parse_toml(text)?;
        let Some(entry) = document
            .get("mcp_servers")
            .and_then(toml_edit::Item::as_table)
            .and_then(|servers| servers.get(SERVER))
        else {
            return Ok(None);
        };
        let command = entry
            .get("command")
            .and_then(toml_edit::Item::as_str)
            .unwrap_or("")
            .to_owned();
        let args = entry
            .get("args")
            .and_then(toml_edit::Item::as_array)
            .map(|args| strings(args.iter().map(toml_edit::Value::as_str).collect()))
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
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn read_config(path: &Path) -> Result<Option<String>, &'static str> {
    let path = real_path(path);
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
/// change. The file it replaces stays beside it as a backup, both with the same permissions.
fn write_config(path: &Path, expected: Option<&str>, text: &str) -> Result<(), &'static str> {
    let path = real_path(path);
    let (folder, name) = resolved_folder(&path)?;
    let current = read_config(&path)?;
    if current.as_deref() != expected {
        return Err(CHANGED);
    }
    let mode = std::fs::metadata(&path)
        .map(|found| found.permissions().mode() & 0o777)
        .unwrap_or(NEW_FILE_MODE);
    if let Some(current) = &current {
        let mut backup = name.clone();
        backup.push(BACKUP_SUFFIX);
        place_with_mode(&folder, &backup, current.as_bytes(), mode).map_err(|_| WRITE_FAILED)?;
    }
    place_with_mode(&folder, &name, text.as_bytes(), mode).map_err(|_| WRITE_FAILED)
}

/// A path into a disk image or a translocated copy breaks once the image is ejected or the app is
/// moved, so a link or a client config points only at a copy that stays put. Both are read-only
/// volumes; an app on a second disk (also under `/Volumes`) is not.
pub(crate) fn temporary_location(path: &Path, read_only: impl FnOnce(&Path) -> bool) -> bool {
    path.components()
        .any(|part| part.as_os_str() == "AppTranslocation")
        || read_only(path)
}

/// The helper in this app's bundle; a debug build runs from `target`, so it takes the checkout's.
fn find_helper(executable: &Path, checkout: Option<&Path>) -> Option<PathBuf> {
    let in_bundle = executable
        .parent()?
        .parent()?
        .join(HELPER_FOLDER)
        .join(HELPER_FILE);
    if in_bundle.is_file() {
        return Some(in_bundle);
    }
    let built = checkout?.join("dist-mcp-helper").join(HELPER_FILE);
    built.is_file().then_some(built)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    NotConnected,
    Connected,
    /// Devot's entry names a helper in an app that has moved or was replaced.
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
    /// The exact text Connect adds; none without a helper to point at.
    preview: Option<String>,
}

fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(BACKUP_SUFFIX);
    path.with_file_name(name)
}

fn is_helper_path(command: &str) -> bool {
    let mut parts = Path::new(command).components().rev();
    parts.next() == Some(Component::Normal(OsStr::new(HELPER_FILE)))
        && parts.next() == Some(Component::Normal(OsStr::new(HELPER_FOLDER)))
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
    };
    let read = read_config(path).and_then(|text| match text {
        None => {
            found.missing = true;
            Ok(None)
        }
        Some(text) => read_entry(client, &text),
    });
    match read {
        Err(code) => {
            found.state = ConnectionState::Unreadable;
            found.code = Some(code);
        }
        Ok(None) => {}
        Ok(Some(entry)) if launch == Some(&entry) => found.state = ConnectionState::Connected,
        Ok(Some(entry)) if is_helper_path(&entry.command) => found.state = ConnectionState::Stale,
        Ok(Some(_)) => found.state = ConnectionState::Other,
    }
    found
}

fn connect(client: Client, path: &Path, launch: &Launch) -> Result<ClientStatus, &'static str> {
    let current = read_config(path)?;
    let text = with_entry(client, current.as_deref(), launch)?;
    write_config(path, current.as_deref(), &text)?;
    Ok(status(client, path, Some(launch)))
}

fn disconnect(
    client: Client,
    path: &Path,
    launch: Option<&Launch>,
) -> Result<ClientStatus, &'static str> {
    let current = read_config(path)?.ok_or(NOT_CONNECTED)?;
    let text = without_entry(client, &current)?.ok_or(NOT_CONNECTED)?;
    write_config(path, Some(&current), &text)?;
    Ok(status(client, path, launch))
}

/// The manifest of a Claude Desktop extension that runs the helper where it is installed.
fn extension_manifest(launch: &Launch, version: &str) -> Result<String, &'static str> {
    let tools: serde_json::Value =
        serde_json::from_str(include_str!("../mcp-extension/tools.json"))
            .map_err(|_| EXTENSION_FAILED)?;
    let manifest = serde_json::json!({
        "manifest_version": "0.3",
        "name": SERVER,
        "display_name": "Devot",
        "version": version,
        "description": "Search, read and edit Devot notes, only in notebooks that allow AI access.",
        "author": { "name": "Devot" },
        "icon": "icon.png",
        "server": {
            "type": "binary",
            "entry_point": launch.command,
            "mcp_config": { "command": launch.command, "args": launch.args, "env": {} },
        },
        "tools": tools,
        "compatibility": { "platforms": ["darwin"] },
    });
    serde_json::to_string_pretty(&manifest).map_err(|_| EXTENSION_FAILED)
}

/// A `.mcpb` is a zip of the manifest and what it names. This one holds no server: the helper
/// stays in the app, so updates reach it and it never outlives its database's schema.
fn extension_bytes(launch: &Launch, version: &str) -> Result<Vec<u8>, &'static str> {
    let manifest = extension_manifest(launch, version)?;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in [
        ("manifest.json", manifest.as_bytes()),
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
    /// The helper to run; none when this build has none.
    helper: Option<String>,
    /// The database to pass with `--db`: every build's but the release app's, its default.
    db: Option<String>,
    /// The app runs from a disk image or a translocated copy: Connect waits until it is installed.
    temporary: bool,
    clients: Vec<ClientStatus>,
}

fn current_helper() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    // The crate is `src-tauri` inside the checkout; a release build names no build machine's path.
    #[cfg(debug_assertions)]
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    #[cfg(not(debug_assertions))]
    let checkout = None;
    find_helper(&executable, checkout)
}

fn database_argument(app: &AppHandle) -> Result<Option<String>, &'static str> {
    if crate::data_folder::Build::this() == crate::data_folder::Build::Release {
        return Ok(None);
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "E_DATA_FOLDER_UNAVAILABLE")?;
    Ok(data
        .join(crate::startup::DB_FILE)
        .to_str()
        .map(String::from))
}

fn launch_for(helper: Option<&Path>, db: Option<&str>) -> Option<Launch> {
    let command = helper?.to_str()?.to_owned();
    let args = db
        .map(|db| vec![String::from("--db"), db.to_owned()])
        .unwrap_or_default();
    Some(Launch { command, args })
}

fn home(app: &AppHandle) -> Result<PathBuf, &'static str> {
    app.path().home_dir().map_err(|_| HOME_UNAVAILABLE)
}

fn client_path(client: Client, home: &Path) -> PathBuf {
    client.config_path(home, |name| std::env::var_os(name))
}

fn installed_launch(app: &AppHandle) -> Result<Launch, &'static str> {
    let helper = current_helper().ok_or(NO_HELPER)?;
    if temporary_location(&helper, crate::atomic_file::on_read_only_volume) {
        return Err(TEMPORARY);
    }
    let db = database_argument(app)?;
    launch_for(Some(&helper), db.as_deref()).ok_or(NO_HELPER)
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
        let db = database_argument(&app)?;
        let helper = current_helper();
        let temporary = helper
            .as_deref()
            .is_some_and(|path| temporary_location(path, crate::atomic_file::on_read_only_volume));
        let launch = launch_for(helper.as_deref(), db.as_deref());
        Ok(McpSetup {
            helper: helper.and_then(|path| path.to_str().map(String::from)),
            db,
            temporary,
            clients: CLIENTS
                .into_iter()
                .map(|client| status(client, &client_path(client, &home), launch.as_ref()))
                .collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn settings_mcp_connect(app: AppHandle, client: String) -> Result<ClientStatus, String> {
    let client = Client::parse(&client).map_err(String::from)?;
    blocking(move || {
        let launch = installed_launch(&app)?;
        let path = client_path(client, &home(&app)?);
        let done = connect(client, &path, &launch);
        match &done {
            Ok(_) => log::info!("I_MCP_CLIENT_CONNECTED {}", client.id()),
            Err(code) => log::warn!("W_MCP_CLIENT_CONNECT_FAILED {} {code}", client.id()),
        }
        done
    })
    .await
}

#[tauri::command]
pub async fn settings_mcp_disconnect(
    app: AppHandle,
    client: String,
) -> Result<ClientStatus, String> {
    let client = Client::parse(&client).map_err(String::from)?;
    blocking(move || {
        let db = database_argument(&app)?;
        let helper = current_helper();
        let launch = launch_for(helper.as_deref(), db.as_deref());
        let path = client_path(client, &home(&app)?);
        let done = disconnect(client, &path, launch.as_ref());
        match &done {
            Ok(_) => log::info!("I_MCP_CLIENT_DISCONNECTED {}", client.id()),
            Err(code) => log::warn!("W_MCP_CLIENT_DISCONNECT_FAILED {} {code}", client.id()),
        }
        done
    })
    .await
}

/// Writes the extension to the app's cache and hands it to whichever app opens `.mcpb` files.
#[tauri::command]
pub async fn settings_mcp_open_extension(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let launch = installed_launch(&app)?;
        let bytes = extension_bytes(&launch, &app.package_info().version.to_string())?;
        let cache = app.path().app_cache_dir().map_err(|_| EXTENSION_FAILED)?;
        let (folder, _) = resolved_folder(&cache.join("Devot.mcpb"))?;
        place_with_mode(&folder, OsStr::new("Devot.mcpb"), &bytes, NEW_FILE_MODE)
            .map_err(|_| EXTENSION_FAILED)?;
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(cache.join("Devot.mcpb"))
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

#[cfg(test)]
mod tests {
    use super::*;

    const HELPER: &str = "/Applications/My Apps/Devot.app/Contents/Helpers/devot-mcp";
    const OLD_HELPER: &str = "/Users/me/Downloads/Devot.app/Contents/Helpers/devot-mcp";

    fn launch() -> Launch {
        Launch {
            command: HELPER.to_owned(),
            args: Vec::new(),
        }
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
        let with_db = Launch {
            command: HELPER.to_owned(),
            args: vec!["--db".to_owned(), "/tmp/x y.sqlite".to_owned()],
        };
        let text = with_entry(Client::ClaudeCode, None, &with_db).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed["mcpServers"]["devot"],
            serde_json::json!({
                "type": "stdio",
                "command": HELPER,
                "args": ["--db", "/tmp/x y.sqlite"],
                "env": {},
            }),
        );
        let text = with_entry(Client::ClaudeDesktop, None, &launch()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed["mcpServers"]["devot"],
            serde_json::json!({ "command": HELPER, "args": [] }),
        );
    }

    #[test]
    fn toml_entry_matches_what_codex_writes() {
        let with_db = Launch {
            command: HELPER.to_owned(),
            args: vec!["--db".to_owned(), "/tmp/x y.sqlite".to_owned()],
        };
        assert_eq!(
            with_entry(Client::Codex, None, &with_db).unwrap(),
            format!(
                "[mcp_servers.devot]\ncommand = \"{HELPER}\"\nargs = [\"--db\", \"/tmp/x y.sqlite\"]\n"
            ),
        );
    }

    #[test]
    fn a_new_entry_is_laid_out_as_the_clients_write_it() {
        assert_eq!(
            with_entry(Client::ClaudeCode, None, &launch()).unwrap(),
            format!(
                "{{\n  \"mcpServers\": {{\n    \"devot\": {{\n      \"type\": \"stdio\",\n      \"command\": \"{HELPER}\",\n      \"args\": [],\n      \"env\": {{}}\n    }}\n  }}\n}}\n"
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
                .filter(|line| line.contains(HELPER) || line.contains("args"))
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
                "{{\n  \"zeta\": 1.0000000000000000001,\n  \"oauthAccount\": {{\n    \"token\": \"keep\"\n  }},\n  \"mcpServers\": {{\n    \"other\": {{\n      \"command\": \"x\"\n    }},\n    \"devot\": {{\n      \"command\": \"{HELPER}\",\n      \"args\": []\n    }}\n  }},\n  \"alpha\": [1, 2]\n}}\n"
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
        assert_eq!(parsed["mcpServers"]["devot"]["command"], HELPER);
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
            connect(Client::ClaudeCode, &path, &launch()),
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

        let found = connect(Client::ClaudeCode, &path, &launch()).unwrap();
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
            let found = connect(client, &path, &launch()).unwrap();
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
        connect(Client::ClaudeCode, &link, &launch()).unwrap();
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(std::fs::read_to_string(&real).unwrap().contains(HELPER));
    }

    #[test]
    fn tells_connected_from_a_moved_app_and_an_entry_devot_did_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeDesktop);
        let state = |path: &Path| status(Client::ClaudeDesktop, path, Some(&launch())).state;
        assert_eq!(state(&path), ConnectionState::NotConnected);

        connect(Client::ClaudeDesktop, &path, &launch()).unwrap();
        assert_eq!(state(&path), ConnectionState::Connected);

        let moved = Launch {
            command: OLD_HELPER.to_owned(),
            args: Vec::new(),
        };
        connect(Client::ClaudeDesktop, &path, &moved).unwrap();
        assert_eq!(state(&path), ConnectionState::Stale);

        let node = Launch {
            command: "node".to_owned(),
            args: vec!["/code/dist-mcp/devot-mcp.mjs".to_owned()],
        };
        connect(Client::ClaudeDesktop, &path, &node).unwrap();
        assert_eq!(state(&path), ConnectionState::Other);

        let other_db = Launch {
            command: HELPER.to_owned(),
            args: vec!["--db".to_owned(), "/x".to_owned()],
        };
        connect(Client::ClaudeDesktop, &path, &other_db).unwrap();
        assert_eq!(state(&path), ConnectionState::Stale);

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
            command: OLD_HELPER.to_owned(),
            args: Vec::new(),
        };
        connect(Client::Codex, &path, &moved).unwrap();
        let found = connect(Client::Codex, &path, &launch()).unwrap();
        assert_eq!(found.state, ConnectionState::Connected);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(OLD_HELPER));
        assert_eq!(text.matches("[mcp_servers.devot]").count(), 1);

        let found = disconnect(Client::Codex, &path, Some(&launch())).unwrap();
        assert_eq!(found.state, ConnectionState::NotConnected);
        assert_eq!(
            disconnect(Client::Codex, &path, Some(&launch())),
            Err(NOT_CONNECTED),
        );
    }

    #[test]
    fn empty_files_count_as_empty_configs() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir, Client::ClaudeCode);
        std::fs::write(&path, "\n").unwrap();
        let found = connect(Client::ClaudeCode, &path, &launch()).unwrap();
        assert_eq!(found.state, ConnectionState::Connected);
    }

    #[test]
    fn finds_the_helper_in_the_bundle_or_a_debug_builds_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Devot.app/Contents/MacOS/Devot");
        assert_eq!(find_helper(&exe, None), None);
        let checkout = dir.path().join("code");
        std::fs::create_dir_all(checkout.join("dist-mcp-helper")).unwrap();
        std::fs::write(checkout.join("dist-mcp-helper/devot-mcp"), "").unwrap();
        assert_eq!(
            find_helper(&exe, Some(&checkout)),
            Some(checkout.join("dist-mcp-helper/devot-mcp")),
        );
        let helpers = dir.path().join("Devot.app/Contents/Helpers");
        std::fs::create_dir_all(&helpers).unwrap();
        std::fs::write(helpers.join("devot-mcp"), "").unwrap();
        assert_eq!(
            find_helper(&exe, Some(&checkout)),
            Some(helpers.join("devot-mcp")),
        );
    }

    #[test]
    fn an_app_on_a_disk_image_or_translocated_is_temporary() {
        let translocated = Path::new(
            "/private/var/folders/x/AppTranslocation/y/d/Devot.app/Contents/Helpers/devot-mcp",
        );
        assert!(temporary_location(translocated, |_| false));
        assert!(temporary_location(Path::new(HELPER), |_| true));
        assert!(!temporary_location(Path::new(HELPER), |_| false));
    }

    #[test]
    fn the_extension_is_a_zip_whose_manifest_runs_the_installed_helper() {
        let bytes = extension_bytes(&launch(), "1.2.3").unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(archive.by_name("icon.png").is_ok());
        let manifest: serde_json::Value =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(manifest["manifest_version"], "0.3");
        assert_eq!(manifest["version"], "1.2.3");
        assert_eq!(manifest["server"]["type"], "binary");
        assert_eq!(manifest["server"]["mcp_config"]["command"], HELPER);
        assert_eq!(manifest["server"]["entry_point"], HELPER);
        assert_eq!(manifest["compatibility"]["platforms"][0], "darwin");
        assert_eq!(manifest["tools"].as_array().unwrap().len(), 8);
    }
}
