//! A plugin's manifest (`devot-plugin.json`, ADR 0005), checked by the rules the page checks it by again
//! (`src/core/plugins/manifest.ts`); both run the cases in `tests/fixtures/plugins/manifests.json`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const FILE: &str = "devot-plugin.json";
pub const API_VERSION: u64 = 1;
pub const MAX_BYTES: usize = 64 * 1024;
pub const RESERVED_FOLDER: &str = "__devot";

pub const PERMISSIONS: [&str; 8] = [
    "note.read",
    "note.edit",
    "commands",
    "menus",
    "keymaps",
    "preview",
    "import",
    "export",
];

const RESERVED_LANGUAGES: [&str; 2] = ["math", "mermaid"];
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributions {
    pub commands: Vec<Command>,
    pub menus: Vec<Menu>,
    pub keymaps: Vec<Keymap>,
    pub preview_renderers: Vec<Renderer>,
    pub import_formats: Vec<ImportFormat>,
    pub export_formats: Vec<ExportFormat>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u64,
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

fn permissions(value: Option<&Value>) -> Result<Vec<String>, &'static str> {
    let items = match value {
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= PERMISSIONS.len() => items,
        _ => return Err(INVALID),
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(name) = item.as_str().filter(|p| PERMISSIONS.contains(p)) else {
            return Err(PERMISSION_UNKNOWN);
        };
        if out.iter().any(|p| p == name) {
            return Err(INVALID);
        }
        out.push(name.to_string());
    }
    Ok(out)
}

fn contributions(value: Option<&Value>, granted: &[String]) -> Result<Contributions, &'static str> {
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
    })
}

/// The first rule broken, as its code; unknown keys are left out.
pub fn parse(value: &Value) -> Result<Manifest, &'static str> {
    let m = value.as_object().ok_or(INVALID)?;
    let id = match m.get("id") {
        Some(Value::String(id)) if is_id(id) => id.clone(),
        _ => return Err(ID_INVALID),
    };
    if m.get("apiVersion").and_then(Value::as_u64) != Some(API_VERSION) {
        return Err(API);
    }
    let version = match m.get("version") {
        Some(Value::String(v)) if is_version(v) => v.clone(),
        _ => return Err(INVALID),
    };
    let main = match m.get("main") {
        Some(Value::String(main)) if is_package_path(main) && main.ends_with(".js") => main.clone(),
        _ => return Err(INVALID),
    };
    let permissions = permissions(m.get("permissions"))?;
    let name = text(m.get("name"), NAME_MAX, INVALID)?;
    let description = optional_text(m.get("description"), DESCRIPTION_MAX)?;
    let author = optional_text(m.get("author"), AUTHOR_MAX)?;
    let contributes = contributions(m.get("contributes"), &permissions)?;
    Ok(Manifest {
        id,
        name,
        version,
        api_version: API_VERSION,
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
    fn refuses_a_file_too_large_or_not_json() {
        assert_eq!(parse_bytes(&vec![b' '; MAX_BYTES + 1]), Err(INVALID));
        assert_eq!(parse_bytes(b"{"), Err(INVALID));
    }
}
