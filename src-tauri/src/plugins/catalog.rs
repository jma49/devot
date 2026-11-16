//! The official plugin index (ADR 0025), which devot.online serves at [`INDEX_URL`]: Settings > Plugins lists it and
//! installs or updates a plugin from it through the same review as an archive the user picks.
//! Archives come only from that site, and each must have the size and SHA-256 its listing gives before it is read.
//! An entry the app cannot read is left out, so a later index can list what this build does not know.

use super::Installed;
use super::manifest::{self, PERMISSIONS};
use super::package::MAX_TOTAL_BYTES;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::Url;

pub const INDEX_URL: &str = "https://devot.online/plugins/index.json";
const SCHEMA: u64 = 1;
pub const INDEX_MAX_BYTES: usize = 512 * 1024;
const MAX_LISTINGS: usize = 1000;
const TEXT_MAX: usize = 1000;

const INDEX_INVALID: &str = "E_PLUGIN_INDEX_INVALID";
const INDEX_SCHEMA: &str = "E_PLUGIN_INDEX_SCHEMA";
pub const NOT_LISTED: &str = "E_PLUGIN_NOT_LISTED";
pub const ARCHIVE_MISMATCH: &str = "E_PLUGIN_ARCHIVE_MISMATCH";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u64,
    pub min_app_version: Option<String>,
    pub description: String,
    pub author: String,
    pub permissions: Vec<String>,
    /// A path on the index's own site.
    pub archive: String,
    pub bytes: u64,
    pub sha256: String,
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Offer {
    Install,
    Update,
    Installed,
    /// This build is older than the plugin needs, or does not know its API version.
    NeedsNewerApp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offered {
    #[serde(flatten)]
    pub listing: Listing,
    pub installed: Option<String>,
    pub offer: Offer,
}

fn short(text: &str) -> bool {
    text.chars().count() <= TEXT_MAX && !text.chars().any(char::is_control)
}

fn is_archive_path(path: &str) -> bool {
    path.strip_prefix("/plugins/")
        .and_then(|name| name.strip_suffix(".zip"))
        .is_some_and(|name| {
            !name.is_empty()
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn readable(listing: &Listing) -> bool {
    manifest::is_id(&listing.id)
        && manifest::is_version(&listing.version)
        && listing
            .min_app_version
            .as_deref()
            .is_none_or(manifest::is_version)
        && listing.api_version >= manifest::API_OLDEST
        && [&listing.name, &listing.description, &listing.author]
            .iter()
            .all(|t| short(t))
        && !listing.name.trim().is_empty()
        && listing.permissions.len() <= PERMISSIONS.len()
        && is_archive_path(&listing.archive)
        && listing.bytes > 0
        && listing.bytes <= MAX_TOTAL_BYTES
        && listing.sha256.len() == 64
        && listing
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && listing.source.starts_with("https://")
        && short(&listing.source)
}

pub fn parse_index(bytes: &[u8]) -> Result<Vec<Listing>, &'static str> {
    if bytes.len() > INDEX_MAX_BYTES {
        return Err(INDEX_INVALID);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| INDEX_INVALID)?;
    if value.get("schema").and_then(Value::as_u64) != Some(SCHEMA) {
        return Err(INDEX_SCHEMA);
    }
    let entries = value
        .get("plugins")
        .and_then(Value::as_array)
        .filter(|e| e.len() <= MAX_LISTINGS)
        .ok_or(INDEX_INVALID)?;
    let mut listings: Vec<Listing> = Vec::new();
    for entry in entries {
        match serde_json::from_value::<Listing>(entry.clone()) {
            Ok(listing) if readable(&listing) && !listings.iter().any(|l| l.id == listing.id) => {
                listings.push(listing);
            }
            _ => log::warn!("W_PLUGIN_LISTING_SKIPPED"),
        }
    }
    Ok(listings)
}

pub fn archive_url(index: &Url, listing: &Listing) -> Result<Url, &'static str> {
    if !is_archive_path(&listing.archive) {
        return Err(INDEX_INVALID);
    }
    index.join(&listing.archive).map_err(|_| INDEX_INVALID)
}

pub fn check_archive(listing: &Listing, bytes: &[u8]) -> Result<(), &'static str> {
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if bytes.len() as u64 == listing.bytes && digest == listing.sha256 {
        Ok(())
    } else {
        Err(ARCHIVE_MISMATCH)
    }
}

/// The package must be the one listed, so a review shows what the listing said.
pub fn check_package(listing: &Listing, manifest: &manifest::Manifest) -> Result<(), &'static str> {
    if manifest.id == listing.id && manifest.version == listing.version {
        Ok(())
    } else {
        Err(ARCHIVE_MISMATCH)
    }
}

pub fn offers(listings: &[Listing], installed: &[Installed], app_version: &str) -> Vec<Offered> {
    listings
        .iter()
        .map(|listing| {
            let current = installed
                .iter()
                .find(|i| i.manifest.id == listing.id)
                .map(|i| i.manifest.version.clone());
            let runs = listing.api_version <= manifest::API_VERSION
                && manifest::runs_on(
                    listing.min_app_version.as_deref().unwrap_or(""),
                    app_version,
                );
            let offer = match &current {
                Some(v) if !manifest::newer(&listing.version, v) => Offer::Installed,
                _ if !runs => Offer::NeedsNewerApp,
                Some(_) => Offer::Update,
                None => Offer::Install,
            };
            Offered {
                listing: listing.clone(),
                installed: current,
                offer,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, version: &str) -> Value {
        json!({
            "id": id,
            "name": "Charts",
            "version": version,
            "apiVersion": 1,
            "minAppVersion": null,
            "description": "Draws charts.",
            "author": "Devot",
            "permissions": ["preview"],
            "archive": "/plugins/charts.zip",
            "bytes": 3,
            "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "source": "https://github.com/jma49/devot-site/tree/main/plugins/charts",
        })
    }

    fn index(plugins: Vec<Value>) -> Vec<u8> {
        serde_json::to_vec(&json!({ "schema": 1, "plugins": plugins })).unwrap()
    }

    fn listing(id: &str, version: &str) -> Listing {
        serde_json::from_value(entry(id, version)).unwrap()
    }

    #[test]
    fn reads_the_index_the_site_serves() {
        let listings = parse_index(&index(vec![entry("online.devot.charts", "1.0.0")])).unwrap();
        assert_eq!(listings, vec![listing("online.devot.charts", "1.0.0")]);
    }

    #[test]
    fn refuses_an_index_of_another_schema_or_shape() {
        let other = serde_json::to_vec(&json!({ "schema": 2, "plugins": [] })).unwrap();
        assert_eq!(parse_index(&other), Err(INDEX_SCHEMA));
        assert_eq!(parse_index(b"[]"), Err(INDEX_SCHEMA));
        assert_eq!(parse_index(b"{\"schema\":1}"), Err(INDEX_INVALID));
        assert_eq!(parse_index(b"not json"), Err(INDEX_INVALID));
        assert_eq!(
            parse_index(&vec![b' '; INDEX_MAX_BYTES + 1]),
            Err(INDEX_INVALID)
        );
    }

    #[test]
    fn leaves_out_entries_it_cannot_read_and_repeated_ids() {
        let mut bad = Vec::new();
        for (key, value) in [
            ("id", json!("Not An Id")),
            ("version", json!("1.0")),
            ("minAppVersion", json!("soon")),
            ("archive", json!("https://elsewhere.example/charts.zip")),
            ("archive", json!("/plugins/../secret.zip")),
            ("bytes", json!(0)),
            ("bytes", json!(MAX_TOTAL_BYTES + 1)),
            ("sha256", json!("ABC")),
            ("source", json!("http://example.com")),
            ("name", json!(" ")),
            ("apiVersion", json!(0)),
        ] {
            let mut e = entry("online.devot.charts", "1.0.0");
            e[key] = value;
            bad.push(e);
        }
        bad.push(json!({ "id": "online.devot.partial" }));
        bad.push(entry("online.devot.charts", "1.0.0"));
        bad.push(entry("online.devot.charts", "2.0.0"));
        assert_eq!(
            parse_index(&index(bad)).unwrap(),
            vec![listing("online.devot.charts", "1.0.0")]
        );
    }

    #[test]
    fn fetches_archives_from_the_index_site_alone() {
        let base = Url::parse(INDEX_URL).unwrap();
        let url = archive_url(&base, &listing("online.devot.charts", "1.0.0")).unwrap();
        assert_eq!(url.as_str(), "https://devot.online/plugins/charts.zip");
        let mut elsewhere = listing("online.devot.charts", "1.0.0");
        elsewhere.archive = "//elsewhere.example/plugins/charts.zip".into();
        assert_eq!(archive_url(&base, &elsewhere), Err(INDEX_INVALID));
    }

    #[test]
    fn takes_only_the_archive_the_listing_describes() {
        let listed = listing("online.devot.charts", "1.0.0");
        assert_eq!(check_archive(&listed, b"abc"), Ok(()));
        assert_eq!(check_archive(&listed, b"abd"), Err(ARCHIVE_MISMATCH));
        assert_eq!(check_archive(&listed, b"abcd"), Err(ARCHIVE_MISMATCH));
    }

    fn installed(id: &str, version: &str) -> Installed {
        let text = format!(
            r#"{{"id":"{id}","name":"Charts","version":"{version}","apiVersion":1,"main":"main.js","permissions":["preview"],"contributes":{{"previewRenderers":[{{"id":"chart","language":"chart"}}]}}}}"#
        );
        Installed {
            manifest: manifest::parse_bytes(text.as_bytes()).unwrap(),
            enabled: true,
            granted: vec!["preview".into()],
            installed_at: 0,
        }
    }

    #[test]
    fn refuses_a_package_other_than_the_listed_one() {
        let listed = listing("online.devot.charts", "1.0.0");
        let same = installed("online.devot.charts", "1.0.0").manifest;
        assert_eq!(check_package(&listed, &same), Ok(()));
        let older = installed("online.devot.charts", "0.9.0").manifest;
        assert_eq!(check_package(&listed, &older), Err(ARCHIVE_MISMATCH));
        let other = installed("online.devot.other", "1.0.0").manifest;
        assert_eq!(check_package(&listed, &other), Err(ARCHIVE_MISMATCH));
    }

    #[test]
    fn offers_an_install_an_update_or_nothing() {
        let mut too_new = listing("online.devot.future", "1.0.0");
        too_new.min_app_version = Some("9.0.0".into());
        let mut new_api = listing("online.devot.api", "1.0.0");
        new_api.api_version = manifest::API_VERSION + 1;
        let listings = [
            listing("online.devot.charts", "1.1.0"),
            listing("online.devot.bibtex", "1.0.0"),
            listing("online.devot.csv", "1.0.0"),
            too_new,
            new_api,
        ];
        let have = [
            installed("online.devot.charts", "1.0.0"),
            installed("online.devot.bibtex", "1.0.0"),
        ];
        let got: Vec<(String, Offer, Option<String>)> = offers(&listings, &have, "1.2.0")
            .into_iter()
            .map(|o| (o.listing.id, o.offer, o.installed))
            .collect();
        assert_eq!(
            got,
            vec![
                (
                    "online.devot.charts".into(),
                    Offer::Update,
                    Some("1.0.0".into())
                ),
                (
                    "online.devot.bibtex".into(),
                    Offer::Installed,
                    Some("1.0.0".into())
                ),
                ("online.devot.csv".into(), Offer::Install, None),
                ("online.devot.future".into(), Offer::NeedsNewerApp, None),
                ("online.devot.api".into(), Offer::NeedsNewerApp, None),
            ]
        );
    }
}
