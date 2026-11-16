//! A plugin's manifest (`devot-plugin.json`, ADR 0005), checked by the rules the page checks it by again
//! (`src/core/plugins/manifest.ts`); both run the cases in `tests/fixtures/plugins/manifests.json`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const FILE: &str = "devot-plugin.json";
/// The newest plugin API this build speaks; a later one only adds, so an older plugin still runs (ADR 0020).
pub const API_VERSION: u64 = 2;
/// The oldest plugin API still run, kept at least 12 months after the next ships.
pub const API_OLDEST: u64 = 1;
pub const MAX_BYTES: usize = 64 * 1024;
pub const RESERVED_FOLDER: &str = "__devot";

pub const PERMISSIONS: [&str; 10] = [
    "note.read",
    "note.edit",
    "commands",
    "menus",
    "keymaps",
    "preview",
    "import",
    "export",
    "storage",
    "notes.read",
];

/// The API version that added each permission, in the order of `PERMISSIONS`.
const PERMISSION_SINCE: [u64; 10] = [1, 1, 1, 1, 1, 1, 1, 1, 2, 2];
const SETTINGS_SINCE: u64 = 2;
const SETTING_TEXT_MAX: usize = 1000;

const RESERVED_LANGUAGES: [&str; 5] = ["math", "mermaid", "plantuml", "puml", "markmap"];
const ID_MAX: usize = 64;
const NAME_MAX: usize = 60;
const DESCRIPTION_MAX: usize = 300;
const AUTHOR_MAX: usize = 100;
const PATH_MAX: usize = 200;
pub const DEPTH_MAX: usize = 8;
const CONTRIBUTION_ID_MAX: usize = 40;
const COMMANDS_MAX: usize = 50;
const OTHERS_MAX: usize = 20;
const EXTENSIONS_MAX: usize = 10;
const KEY_MAX: usize = 40;

const INVALID: &str = "E_PLUGIN_MANIFEST_INVALID";
const ID_INVALID: &str = "E_PLUGIN_ID_INVALID";
const API: &str = "E_PLUGIN_API_VERSION";
const API_TOO_NEW: &str = "E_PLUGIN_API_TOO_NEW";
const API_RETIRED: &str = "E_PLUGIN_API_RETIRED";
pub const APP_TOO_OLD: &str = "E_PLUGIN_APP_TOO_OLD";
const PERMISSION_UNKNOWN: &str = "E_PLUGIN_PERMISSION_UNKNOWN";
const PERMISSION_MISSING: &str = "E_PLUGIN_PERMISSION_MISSING";
const CONTRIBUTION: &str = "E_PLUGIN_CONTRIBUTION_INVALID";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Command {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Menu {
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Keymap {
    pub command: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Renderer {
    pub id: String,
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportFormat {
    pub id: String,
    pub title: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportFormat {
    pub id: String,
    pub title: String,
    pub extension: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Choice {
    pub id: String,
    pub title: String,
}

/// What a setting holds, with its default; numbers are kept as JSON numbers so they read back as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SettingKind {
    Toggle {
        default: bool,
    },
    Text {
        default: String,
    },
    Number {
        default: serde_json::Number,
        min: Option<serde_json::Number>,
        max: Option<serde_json::Number>,
    },
    Choice {
        default: String,
        choices: Vec<Choice>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setting {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(flatten)]
    pub kind: SettingKind,
}

impl Setting {
    pub fn default_value(&self) -> Value {
        match &self.kind {
            SettingKind::Toggle { default } => Value::Bool(*default),
            SettingKind::Text { default } | SettingKind::Choice { default, .. } => {
                Value::String(default.clone())
            }
            SettingKind::Number { default, .. } => Value::Number(default.clone()),
        }
    }

    /// Whether Settings may store `value` for it.
    pub fn fits(&self, value: &Value) -> bool {
        match (&self.kind, value) {
            (SettingKind::Toggle { .. }, Value::Bool(_)) => true,
            (SettingKind::Text { .. }, Value::String(text)) => is_setting_text(text),
            (SettingKind::Number { min, max, .. }, Value::Number(n)) => {
                let Some(n) = n.as_f64() else { return false };
                min.as_ref().and_then(|m| m.as_f64()).is_none_or(|m| n >= m)
                    && max.as_ref().and_then(|m| m.as_f64()).is_none_or(|m| n <= m)
            }
            (SettingKind::Choice { choices, .. }, Value::String(id)) => {
                choices.iter().any(|c| &c.id == id)
            }
            _ => false,
        }
    }
}

fn is_setting_text(text: &str) -> bool {
    text.chars().count() <= SETTING_TEXT_MAX && !text.chars().any(is_control)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub commands: Vec<Command>,
    pub menus: Vec<Menu>,
    pub keymaps: Vec<Keymap>,
    pub preview_renderers: Vec<Renderer>,
    pub import_formats: Vec<ImportFormat>,
    pub export_formats: Vec<ExportFormat>,
    pub settings: Vec<Setting>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u64,
    /// The oldest Devot release it runs on, or empty (then left out, as the page reads it).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub min_app_version: String,
    pub description: String,
    pub author: String,
    pub main: String,
    pub permissions: Vec<String>,
    pub contributes: Contributions,
}

impl Manifest {
    pub fn asks(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }

    /// Whether this Devot (`app`, its release version) is new enough for the plugin.
    pub fn runs_on(&self, app: &str) -> Result<(), &'static str> {
        if runs_on(&self.min_app_version, app) {
            Ok(())
        } else {
            Err(APP_TOO_OLD)
        }
    }
}

fn release(version: &str) -> Option<[u64; 3]> {
    let core = version.split_once('-').map_or(version, |(core, _)| core);
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let out = [parts.next()??, parts.next()??, parts.next()??];
    parts.next().is_none().then_some(out)
}

/// A beta previews its release, so `1.2.0-beta3` runs a plugin needing 1.2.0. A development build (`0.0.0`, the
/// committed version) runs every plugin.
fn runs_on(min_app_version: &str, app: &str) -> bool {
    let Some(app) = release(app) else {
        return false;
    };
    if min_app_version.is_empty() || app == [0, 0, 0] {
        return true;
    }
    release(min_app_version).is_some_and(|min| app >= min)
}

pub fn parse_bytes(bytes: &[u8]) -> Result<Manifest, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err(INVALID);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    parse(&value)
}

fn lowercase_parts(text: &str, separators: &[char]) -> bool {
    !text.is_empty()
        && text.split(|c| separators.contains(&c)).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

pub fn is_id(id: &str) -> bool {
    id.len() <= ID_MAX
        && lowercase_parts(id, &['.', '-'])
        && id != "devot"
        && !id.starts_with("devot.")
}

fn is_contribution_id(id: &str) -> bool {
    id.len() <= CONTRIBUTION_ID_MAX && lowercase_parts(id, &['-'])
}

fn is_path_part(part: &str) -> bool {
    let mut bytes = part.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    let plain = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    plain(first) && bytes.all(|b| plain(b) || b == b'.')
}

/// Plain parts, none hidden, `__devot` never first.
pub fn is_package_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    path.len() <= PATH_MAX
        && parts.len() <= DEPTH_MAX
        && parts.iter().all(|p| is_path_part(p))
        && parts[0] != RESERVED_FOLDER
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 9
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p.len() == 1 || !p.starts_with('0'))
        })
}

fn is_language(text: &str) -> bool {
    let mut bytes = text.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    text.len() <= 32
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_+#.-".contains(&b))
        && !RESERVED_LANGUAGES.contains(&text)
}

fn is_extension(text: &str) -> bool {
    (1..=10).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// The page reads the key strictly (`keys.ts`); here only its outline: one to four modifiers, then a key.
fn is_key(text: &str) -> bool {
    if text.len() > KEY_MAX {
        return false;
    }
    let parts: Vec<&str> = text.split('+').collect();
    let (key, modifiers) = parts.split_last().expect("split yields one part");
    (1..=4).contains(&modifiers.len())
        && modifiers
            .iter()
            .all(|m| ["Mod", "Ctrl", "Alt", "Shift"].contains(m))
        && (1..=12).contains(&key.chars().count())
        && !key.chars().any(char::is_whitespace)
}

fn is_control(c: char) -> bool {
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

fn text(value: Option<&Value>, max: usize, code: &'static str) -> Result<String, &'static str> {
    let Some(Value::String(text)) = value else {
        return Err(code);
    };
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed != text
        || text.chars().count() > max
        || text.chars().any(is_control)
    {
        return Err(code);
    }
    Ok(text.clone())
}

fn optional_text(value: Option<&Value>, max: usize) -> Result<String, &'static str> {
    match value {
        None => Ok(String::new()),
        Some(Value::String(text))
            if text.chars().count() <= max && !text.chars().any(is_control) =>
        {
            Ok(text.clone())
        }
        _ => Err(INVALID),
    }
}

fn list(value: Option<&Value>, max: usize) -> Result<&[Value], &'static str> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(items)) if items.len() <= max => Ok(items),
        _ => Err(CONTRIBUTION),
    }
}

fn entry(value: &Value) -> Result<&Map<String, Value>, &'static str> {
    value.as_object().ok_or(CONTRIBUTION)
}

fn contribution_id(value: Option<&Value>) -> Result<String, &'static str> {
    match value {
        Some(Value::String(id)) if is_contribution_id(id) => Ok(id.clone()),
        _ => Err(CONTRIBUTION),
    }
}

fn title(value: Option<&Value>) -> Result<String, &'static str> {
    text(value, NAME_MAX, CONTRIBUTION)
}

fn unique<'a>(keys: impl IntoIterator<Item = &'a str>) -> Result<(), &'static str> {
    let mut seen = std::collections::HashSet::new();
    for key in keys {
        if !seen.insert(key) {
            return Err(CONTRIBUTION);
        }
    }
    Ok(())
}

fn api_version(value: Option<&Value>) -> Result<u64, &'static str> {
    let version = value
        .and_then(Value::as_u64)
        .filter(|v| *v >= 1)
        .ok_or(API)?;
    if version > API_VERSION {
        Err(API_TOO_NEW)
    } else if version < API_OLDEST {
        Err(API_RETIRED)
    } else {
        Ok(version)
    }
}

fn permissions(value: Option<&Value>, api: u64) -> Result<Vec<String>, &'static str> {
    let items = match value {
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= PERMISSIONS.len() => items,
        _ => return Err(INVALID),
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(name) = item.as_str().filter(|p| {
            PERMISSIONS
                .iter()
                .position(|known| known == p)
                .is_some_and(|at| PERMISSION_SINCE[at] <= api)
        }) else {
            return Err(PERMISSION_UNKNOWN);
        };
        if out.iter().any(|p| p == name) {
            return Err(INVALID);
        }
        out.push(name.to_string());
    }
    Ok(out)
}

fn finite(value: Option<&Value>) -> Result<Option<serde_json::Number>, &'static str> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => Ok(Some(n.clone())),
        Some(_) => Err(CONTRIBUTION),
    }
}

fn setting(raw: &Value) -> Result<Setting, &'static str> {
    let e = entry(raw)?;
    let id = contribution_id(e.get("id"))?;
    let name = title(e.get("title"))?;
    let description =
        optional_text(e.get("description"), DESCRIPTION_MAX).map_err(|_| CONTRIBUTION)?;
    let given = e.get("default");
    let kind = match e.get("type").and_then(Value::as_str) {
        Some("toggle") => match given {
            None => SettingKind::Toggle { default: false },
            Some(Value::Bool(b)) => SettingKind::Toggle { default: *b },
            Some(_) => return Err(CONTRIBUTION),
        },
        Some("text") => match given {
            None => SettingKind::Text {
                default: String::new(),
            },
            Some(Value::String(t)) if is_setting_text(t) => {
                SettingKind::Text { default: t.clone() }
            }
            Some(_) => return Err(CONTRIBUTION),
        },
        Some("number") => {
            let min = finite(e.get("min"))?;
            let max = finite(e.get("max"))?;
            let default = finite(given)?
                .or_else(|| min.clone())
                .unwrap_or_else(|| 0.into());
            let at =
                |n: &Option<serde_json::Number>| n.as_ref().and_then(serde_json::Number::as_f64);
            let value = default.as_f64().ok_or(CONTRIBUTION)?;
            if at(&min).is_some_and(|m| value < m)
                || at(&max).is_some_and(|m| value > m)
                || matches!((at(&min), at(&max)), (Some(lo), Some(hi)) if lo > hi)
            {
                return Err(CONTRIBUTION);
            }
            SettingKind::Number { default, min, max }
        }
        Some("choice") => {
            let choices = list(e.get("choices"), OTHERS_MAX)?
                .iter()
                .map(|raw| {
                    let c = entry(raw)?;
                    Ok(Choice {
                        id: contribution_id(c.get("id"))?,
                        title: title(c.get("title"))?,
                    })
                })
                .collect::<Result<Vec<_>, &'static str>>()?;
            unique(choices.iter().map(|c| c.id.as_str()))?;
            let first = choices.first().ok_or(CONTRIBUTION)?.id.clone();
            let default = match given {
                None => first,
                Some(Value::String(id)) if choices.iter().any(|c| &c.id == id) => id.clone(),
                Some(_) => return Err(CONTRIBUTION),
            };
            SettingKind::Choice { default, choices }
        }
        _ => return Err(CONTRIBUTION),
    };
    Ok(Setting {
        id,
        title: name,
        description,
        kind,
    })
}

fn contributions(
    value: Option<&Value>,
    granted: &[String],
    api: u64,
) -> Result<Contributions, &'static str> {
    let empty = Map::new();
    let c = match value {
        None => &empty,
        Some(Value::Object(c)) => c,
        Some(_) => return Err(CONTRIBUTION),
    };
    let commands = list(c.get("commands"), COMMANDS_MAX)?
        .iter()
        .map(|raw| {
            let e = entry(raw)?;
            Ok(Command {
                id: contribution_id(e.get("id"))?,
                title: title(e.get("title"))?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(commands.iter().map(|x| x.id.as_str()))?;
    let command = |raw: Option<&Value>| match raw {
        Some(Value::String(id)) if commands.iter().any(|c| &c.id == id) => Ok(id.clone()),
        _ => Err(CONTRIBUTION),
    };
    let menus = list(c.get("menus"), COMMANDS_MAX)?
        .iter()
        .map(|raw| {
            Ok(Menu {
                command: command(entry(raw)?.get("command"))?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(menus.iter().map(|x| x.command.as_str()))?;
    let keymaps = list(c.get("keymaps"), COMMANDS_MAX)?
        .iter()
        .map(|raw| {
            let e = entry(raw)?;
            let key = match e.get("key") {
                Some(Value::String(key)) if is_key(key) => key.clone(),
                _ => return Err(CONTRIBUTION),
            };
            Ok(Keymap {
                command: command(e.get("command"))?,
                key,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(keymaps.iter().map(|x| x.command.as_str()))?;
    let preview_renderers = list(c.get("previewRenderers"), OTHERS_MAX)?
        .iter()
        .map(|raw| {
            let e = entry(raw)?;
            let language = match e.get("language") {
                Some(Value::String(l)) if is_language(l) => l.clone(),
                _ => return Err(CONTRIBUTION),
            };
            Ok(Renderer {
                id: contribution_id(e.get("id"))?,
                language,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(preview_renderers.iter().map(|x| x.id.as_str()))?;
    unique(preview_renderers.iter().map(|x| x.language.as_str()))?;
    let extension = |raw: &Value| match raw {
        Value::String(x) if is_extension(x) => Ok(x.clone()),
        _ => Err(CONTRIBUTION),
    };
    let import_formats = list(c.get("importFormats"), OTHERS_MAX)?
        .iter()
        .map(|raw| {
            let e = entry(raw)?;
            let extensions = match e.get("extensions") {
                Some(Value::Array(items)) if !items.is_empty() => {
                    list(e.get("extensions"), EXTENSIONS_MAX)?;
                    items.iter().map(extension).collect::<Result<Vec<_>, _>>()?
                }
                _ => return Err(CONTRIBUTION),
            };
            unique(extensions.iter().map(String::as_str))?;
            Ok(ImportFormat {
                id: contribution_id(e.get("id"))?,
                title: title(e.get("title"))?,
                extensions,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(import_formats.iter().map(|x| x.id.as_str()))?;
    let export_formats = list(c.get("exportFormats"), OTHERS_MAX)?
        .iter()
        .map(|raw| {
            let e = entry(raw)?;
            Ok(ExportFormat {
                id: contribution_id(e.get("id"))?,
                title: title(e.get("title"))?,
                extension: e.get("extension").map_or(Err(CONTRIBUTION), extension)?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(export_formats.iter().map(|x| x.id.as_str()))?;
    let settings = list(c.get("settings"), OTHERS_MAX)?
        .iter()
        .map(setting)
        .collect::<Result<Vec<_>, &'static str>>()?;
    unique(settings.iter().map(|x| x.id.as_str()))?;
    if !settings.is_empty() && api < SETTINGS_SINCE {
        return Err(CONTRIBUTION);
    }
    let needs = [
        (!commands.is_empty(), "commands"),
        (!menus.is_empty(), "menus"),
        (!menus.is_empty(), "commands"),
        (!keymaps.is_empty(), "keymaps"),
        (!keymaps.is_empty(), "commands"),
        (!preview_renderers.is_empty(), "preview"),
        (!import_formats.is_empty(), "import"),
        (!export_formats.is_empty(), "export"),
    ];
    if needs
        .iter()
        .any(|(used, permission)| *used && !granted.iter().any(|g| g == permission))
    {
        return Err(PERMISSION_MISSING);
    }
    Ok(Contributions {
        commands,
        menus,
        keymaps,
        preview_renderers,
        import_formats,
        export_formats,
        settings,
    })
}

/// The first rule broken, as its code; unknown keys are left out.
pub fn parse(value: &Value) -> Result<Manifest, &'static str> {
    let m = value.as_object().ok_or(INVALID)?;
    let id = match m.get("id") {
        Some(Value::String(id)) if is_id(id) => id.clone(),
        _ => return Err(ID_INVALID),
    };
    let api_version = api_version(m.get("apiVersion"))?;
    let version = match m.get("version") {
        Some(Value::String(v)) if is_version(v) => v.clone(),
        _ => return Err(INVALID),
    };
    let main = match m.get("main") {
        Some(Value::String(main)) if is_package_path(main) && main.ends_with(".js") => main.clone(),
        _ => return Err(INVALID),
    };
    let min_app_version = match m.get("minAppVersion") {
        None => String::new(),
        Some(Value::String(v)) if is_version(v) => v.clone(),
        Some(_) => return Err(INVALID),
    };
    let permissions = permissions(m.get("permissions"), api_version)?;
    let name = text(m.get("name"), NAME_MAX, INVALID)?;
    let description = optional_text(m.get("description"), DESCRIPTION_MAX)?;
    let author = optional_text(m.get("author"), AUTHOR_MAX)?;
    let contributes = contributions(m.get("contributes"), &permissions, api_version)?;
    Ok(Manifest {
        id,
        name,
        version,
        api_version,
        min_app_version,
        description,
        author,
        main,
        permissions,
        contributes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/plugins/manifests.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn patched(base: &Value, patch: &Value) -> Value {
        let mut out = base.clone();
        let target = out.as_object_mut().unwrap();
        for (key, value) in patch.as_object().unwrap() {
            if value.is_null() {
                target.remove(key);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
        out
    }

    #[test]
    fn runs_the_shared_manifest_cases() {
        let cases = cases();
        let base = &cases["base"];
        for case in cases["valid"].as_array().unwrap() {
            let manifest = parse(&patched(base, &case["patch"]));
            assert!(manifest.is_ok(), "{}: {:?}", case["name"], manifest);
        }
        for case in cases["invalid"].as_array().unwrap() {
            assert_eq!(
                parse(&patched(base, &case["patch"])).err(),
                case["code"].as_str(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn serializes_as_the_page_reads_it() {
        let cases = cases();
        let manifest = parse(&cases["base"]).unwrap();
        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["apiVersion"], 1);
        assert_eq!(json["contributes"]["keymaps"][0]["key"], "Mod+Shift+U");
        assert_eq!(
            json["contributes"]["previewRenderers"],
            serde_json::json!([])
        );
        assert!(manifest.asks("menus"));
        assert!(!manifest.asks("note.edit"));
    }

    #[test]
    fn runs_on_the_app_versions_the_shared_cases_name() {
        for case in cases()["appVersions"].as_array().unwrap() {
            let min = case["minAppVersion"].as_str().unwrap();
            let app = case["app"].as_str().unwrap();
            assert_eq!(
                runs_on(min, app),
                case["runs"].as_bool().unwrap(),
                "{min} on {app}"
            );
        }
        assert!(!runs_on("1.0.0", "not a version"));
    }

    #[test]
    fn refuses_a_file_too_large_or_not_json() {
        assert_eq!(parse_bytes(&vec![b' '; MAX_BYTES + 1]), Err(INVALID));
        assert_eq!(parse_bytes(b"{"), Err(INVALID));
    }
}
