//! A plugin's own data (ADR 0021): what it stores with `storage` and the values of the settings its manifest declares, in
//! `<app data>/plugin-data/<id>.json`. It never syncs, backups leave it out, an update keeps it and removing the plugin
//! deletes it.

use super::{Plugins, manifest::Setting};
use crate::atomic_file;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;

pub const DIR: &str = "plugin-data";
pub const SETTINGS_CHANGED_EVENT: &str = "devot://plugin-settings-changed";
/// The whole file, as JSON.
pub const BYTES_MAX: usize = 1024 * 1024;
/// One stored value, as JSON; the page checks the same (`MAX_STORAGE_VALUE_BYTES`).
pub const VALUE_BYTES_MAX: usize = 256 * 1024;
pub const KEYS_MAX: usize = 1000;
const KEY_MAX: usize = 128;
const JSON_DEPTH_MAX: usize = 32;

const KEY_INVALID: &str = "E_PLUGIN_STORAGE_KEY_INVALID";
const VALUE_INVALID: &str = "E_PLUGIN_STORAGE_VALUE_INVALID";
const FULL: &str = "E_PLUGIN_STORAGE_FULL";
const FAILED: &str = "E_PLUGIN_STORAGE_FAILED";
const SETTING_UNKNOWN: &str = "E_PLUGIN_SETTING_UNKNOWN";
const SETTING_INVALID: &str = "E_PLUGIN_SETTING_INVALID";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    storage: Map<String, Value>,
    #[serde(default)]
    settings: Map<String, Value>,
}

/// As the page's `STORAGE_KEY`: a letter or digit, then letters, digits and `._:/-`, at most 128.
pub fn is_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    key.len() <= KEY_MAX
        && first.is_ascii_alphanumeric()
        && bytes.all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
}

fn depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(depth).max().unwrap_or(0),
        Value::Object(map) => 1 + map.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

impl Plugins {
    fn data_path(&self, id: &str) -> PathBuf {
        self.data.join(DIR).join(format!("{id}.json"))
    }

    fn read_data(&self, id: &str) -> Result<Data, &'static str> {
        match std::fs::read(self.data_path(id)) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                log::warn!("W_PLUGIN_DATA_INVALID {id}");
                FAILED
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data::default()),
            Err(_) => Err(FAILED),
        }
    }

    fn write_data(&self, id: &str, data: &Data) -> Result<(), &'static str> {
        let bytes = serde_json::to_vec(data).map_err(|_| FAILED)?;
        if bytes.len() > BYTES_MAX || data.storage.len() > KEYS_MAX {
            return Err(FULL);
        }
        std::fs::create_dir_all(self.data.join(DIR)).map_err(|_| FAILED)?;
        atomic_file::write_replacing(&self.data_path(id), &bytes).map_err(|_| FAILED)
    }

    fn change_data(&self, id: &str, change: impl FnOnce(&mut Data)) -> Result<(), &'static str> {
        let _writing = crate::locks::lock(&self.data_writing);
        let mut data = self.read_data(id)?;
        change(&mut data);
        self.write_data(id, &data)
    }

    pub fn storage_get(&self, id: &str, key: &str) -> Result<Option<Value>, &'static str> {
        self.allowed(id, "storage")?;
        if !is_key(key) {
            return Err(KEY_INVALID);
        }
        Ok(self.read_data(id)?.storage.get(key).cloned())
    }

    pub fn storage_set(&self, id: &str, key: &str, value: Value) -> Result<(), &'static str> {
        self.allowed(id, "storage")?;
        if !is_key(key) {
            return Err(KEY_INVALID);
        }
        let size = serde_json::to_vec(&value).map_err(|_| VALUE_INVALID)?.len();
        if size > VALUE_BYTES_MAX || depth(&value) > JSON_DEPTH_MAX {
            return Err(VALUE_INVALID);
        }
        self.change_data(id, |data| {
            data.storage.insert(key.to_string(), value);
        })
    }

    pub fn storage_delete(&self, id: &str, key: &str) -> Result<(), &'static str> {
        self.allowed(id, "storage")?;
        if !is_key(key) {
            return Err(KEY_INVALID);
        }
        self.change_data(id, |data| {
            data.storage.remove(key);
        })
    }

    pub fn storage_keys(&self, id: &str) -> Result<Vec<String>, &'static str> {
        self.allowed(id, "storage")?;
        Ok(self.read_data(id)?.storage.keys().cloned().collect())
    }

    /// Every declared setting's value: the one stored when it still fits the declaration, else its default.
    pub fn settings_get(&self, id: &str) -> Result<Map<String, Value>, &'static str> {
        let declared = self.declared_settings(id)?;
        let stored = self.read_data(id).unwrap_or_default().settings;
        Ok(declared
            .iter()
            .map(|s| {
                let value = stored
                    .get(&s.id)
                    .filter(|v| s.fits(v))
                    .cloned()
                    .unwrap_or_else(|| s.default_value());
                (s.id.clone(), value)
            })
            .collect())
    }

    pub fn settings_set(&self, id: &str, setting: &str, value: Value) -> Result<(), &'static str> {
        let declared = self.declared_settings(id)?;
        let found = declared
            .iter()
            .find(|s| s.id == setting)
            .ok_or(SETTING_UNKNOWN)?;
        if !found.fits(&value) {
            return Err(SETTING_INVALID);
        }
        self.change_data(id, |data| {
            data.settings.insert(setting.to_string(), value);
        })
    }

    fn declared_settings(&self, id: &str) -> Result<Vec<Setting>, &'static str> {
        let stored = self.stored();
        let entry = stored.plugins.get(id).ok_or(super::NOT_FOUND)?;
        Ok(self.installed(id, entry)?.manifest.contributes.settings)
    }

    /// Called with the plugin's other files gone.
    pub(super) fn remove_data(&self, id: &str) {
        let _writing = crate::locks::lock(&self.data_writing);
        match std::fs::remove_file(self.data_path(id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => log::warn!("W_PLUGIN_DATA_KEPT {id}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{installed_with, settings_manifest};
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_plain_and_short() {
        for good in ["a", "notes/2026-11-16", "x.y:z_w-1", &"k".repeat(128)] {
            assert!(is_key(good), "{good}");
        }
        for bad in ["", ".a", "/a", "a b", "a\u{e9}", &"k".repeat(129)] {
            assert!(!is_key(bad), "{bad}");
        }
    }

    #[test]
    fn stores_reads_lists_and_deletes_a_plugins_own_values() {
        let (_data, plugins) = installed_with(r#"["storage"]"#, "");
        let id = "com.example.data";
        assert_eq!(plugins.storage_get(id, "count"), Ok(None));
        plugins.storage_set(id, "count", json!({ "n": 3 })).unwrap();
        plugins
            .storage_set(id, "last", json!("2026-11-16"))
            .unwrap();
        assert_eq!(
            plugins.storage_get(id, "count"),
            Ok(Some(json!({ "n": 3 })))
        );
        assert_eq!(
            plugins.storage_keys(id),
            Ok(vec!["count".into(), "last".into()])
        );
        plugins.storage_delete(id, "count").unwrap();
        assert_eq!(plugins.storage_keys(id), Ok(vec!["last".into()]));
    }

    #[test]
    fn refuses_storage_without_the_permission_or_while_off() {
        let (_data, plugins) = installed_with("[]", "");
        let id = "com.example.data";
        assert_eq!(
            plugins.storage_get(id, "k"),
            Err("E_PLUGIN_PERMISSION_DENIED")
        );
        let (_data, plugins) = installed_with(r#"["storage"]"#, "");
        plugins.set_enabled(id, false).unwrap();
        assert_eq!(
            plugins.storage_set(id, "k", json!(1)),
            Err("E_PLUGIN_DISABLED")
        );
    }

    #[test]
    fn refuses_bad_keys_large_values_and_a_full_store() {
        let (_data, plugins) = installed_with(r#"["storage"]"#, "");
        let id = "com.example.data";
        assert_eq!(plugins.storage_set(id, "../x", json!(1)), Err(KEY_INVALID));
        let big = "x".repeat(VALUE_BYTES_MAX);
        assert_eq!(
            plugins.storage_set(id, "big", json!(big)),
            Err(VALUE_INVALID)
        );
        let mut deep = json!(1);
        for _ in 0..=JSON_DEPTH_MAX {
            deep = json!([deep]);
        }
        assert_eq!(plugins.storage_set(id, "deep", deep), Err(VALUE_INVALID));
        let chunk = "x".repeat(VALUE_BYTES_MAX - 2);
        for n in 0..3 {
            plugins
                .storage_set(id, &format!("k{n}"), json!(chunk))
                .unwrap();
        }
        assert_eq!(plugins.storage_set(id, "k3", json!(chunk)), Err(FULL));
        assert_eq!(plugins.storage_keys(id).unwrap().len(), 3);
    }

    #[test]
    fn keeps_data_through_an_update_and_deletes_it_with_the_plugin() {
        let (data, plugins) = installed_with(r#"["storage"]"#, "");
        let id = "com.example.data";
        plugins.storage_set(id, "k", json!(true)).unwrap();
        super::super::tests::reinstall(&plugins, r#"["storage"]"#, "");
        assert_eq!(plugins.storage_get(id, "k"), Ok(Some(json!(true))));
        plugins.remove(id).unwrap();
        assert!(!data.path().join(DIR).join(format!("{id}.json")).exists());
    }

    #[test]
    fn hands_out_settings_with_defaults_and_stores_only_what_fits() {
        let (_data, plugins) = installed_with("[]", settings_manifest());
        let id = "com.example.data";
        assert_eq!(
            plugins.settings_get(id),
            Ok(json!({ "on": true, "label": "", "size": 12, "unit": "km" })
                .as_object()
                .unwrap()
                .clone())
        );
        plugins.settings_set(id, "size", json!(20)).unwrap();
        plugins.settings_set(id, "unit", json!("mi")).unwrap();
        assert_eq!(
            plugins.settings_set(id, "size", json!(99)),
            Err(SETTING_INVALID)
        );
        assert_eq!(
            plugins.settings_set(id, "unit", json!("ly")),
            Err(SETTING_INVALID)
        );
        assert_eq!(
            plugins.settings_set(id, "label", json!(1)),
            Err(SETTING_INVALID)
        );
        assert_eq!(
            plugins.settings_set(id, "gone", json!(1)),
            Err(SETTING_UNKNOWN)
        );
        let values = plugins.settings_get(id).unwrap();
        assert_eq!(values["size"], json!(20));
        assert_eq!(values["unit"], json!("mi"));
    }
}
