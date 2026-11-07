//! Rust-direct operations (docs/specs/iphone-screens.md, Rust-direct operations): the native
//! Settings read and write the domains Rust owns through the same bodies the Tauri commands run,
//! so validation and change events are never written twice, and no page is needed. Nothing here
//! reaches a note.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::message::{Empty, Reply};
use crate::ai::{self, Ai, provider::ProviderId, settings::AiSettings};
use crate::editor_settings::{self, EditorSettingsStore};
use crate::fonts::{self, Fonts};
use crate::licence::{self, Licence, app_store::Shop};
use crate::sync::commands::{self as sync, NoteCounts};
use crate::sync::service::{SettingsPatch, SyncService};

/// The services the operations run on, as Tauri's state holds them.
pub struct Services {
    pub editor_settings: Arc<EditorSettingsStore>,
    /// What `editor_settings::announce` does in the app: every window hears the change.
    pub announce: Arc<dyn Fn(&editor_settings::Snapshot) + Send + Sync>,
    pub fonts: Arc<Fonts>,
    pub ai: Arc<Ai>,
    pub licence: Arc<Licence>,
    pub shop: Shop,
    pub sync: Arc<SyncService>,
    pub counts: NoteCounts,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorPatch {
    pub patch: Map<String, Value>,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncSettings {
    pub patch: SettingsPatch,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct On {
    pub on: bool,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Providers {
    pub settings: AiSettings,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderKey {
    pub provider: ProviderId,
    pub key: String,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provider {
    pub provider: ProviderId,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub key: String,
}

/// A product of the purchase sheet, which the command checks by name.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub product: String,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RelaySecret {
    pub relay_secret: String,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinCode {
    pub code: String,
    #[serde(default)]
    pub via: Option<String>,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RecoveryKey {
    pub recovery_key: String,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MaybeRecoveryKey {
    #[serde(default)]
    pub recovery_key: Option<String>,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Picked {
    pub path: String,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub device: String,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accept {
    pub accept: bool,
}

/// Each operation is a Tauri command's body, with the command's arguments under `args`. It has no
/// `Debug`: its arguments may hold a licence key, an AI key or a relay secret.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "op", content = "args")]
pub enum Op {
    #[serde(rename = "direct.editorSettings.get")]
    EditorSettingsGet(Empty),
    #[serde(rename = "direct.editorSettings.set")]
    EditorSettingsSet(EditorPatch),
    #[serde(rename = "direct.fonts.list")]
    FontsList(Empty),
    #[serde(rename = "direct.fonts.import")]
    FontsImport(Picked),
    #[serde(rename = "direct.crashReports.get")]
    CrashReportsGet(Empty),
    #[serde(rename = "direct.crashReports.set")]
    CrashReportsSet(On),
    #[serde(rename = "direct.ai.get")]
    AiGet(Empty),
    #[serde(rename = "direct.ai.set")]
    AiSet(Providers),
    #[serde(rename = "direct.ai.keySet")]
    AiKeySet(ProviderKey),
    #[serde(rename = "direct.ai.keyClear")]
    AiKeyClear(Provider),
    #[serde(rename = "direct.licence.get")]
    LicenceGet(Empty),
    #[serde(rename = "direct.licence.set")]
    LicenceSet(Key),
    #[serde(rename = "direct.licence.remove")]
    LicenceRemove(Empty),
    #[serde(rename = "direct.licence.refresh")]
    LicenceRefresh(Empty),
    #[serde(rename = "direct.store.products")]
    StoreProducts(Empty),
    #[serde(rename = "direct.store.purchase")]
    StorePurchase(Offer),
    #[serde(rename = "direct.store.restore")]
    StoreRestore(Empty),
    #[serde(rename = "direct.store.macKey")]
    StoreMacKey(Empty),
    #[serde(rename = "direct.store.refund")]
    StoreRefund(Empty),
    #[serde(rename = "direct.sync.get")]
    SyncGet(Empty),
    #[serde(rename = "direct.sync.set")]
    SyncSet(SyncSettings),
    #[serde(rename = "direct.sync.vaultCreate")]
    SyncVaultCreate(RelaySecret),
    #[serde(rename = "direct.sync.vaultRotate")]
    SyncVaultRotate(RelaySecret),
    #[serde(rename = "direct.sync.vaultLeave")]
    SyncVaultLeave(Empty),
    #[serde(rename = "direct.sync.recoveryKey")]
    SyncRecoveryKey(Empty),
    #[serde(rename = "direct.sync.recoverySaved")]
    SyncRecoverySaved(Empty),
    #[serde(rename = "direct.sync.pairingOpen")]
    SyncPairingOpen(Empty),
    #[serde(rename = "direct.sync.pairingCheck")]
    SyncPairingCheck(Empty),
    #[serde(rename = "direct.sync.pairingCancel")]
    SyncPairingCancel(Empty),
    #[serde(rename = "direct.sync.joinCode")]
    SyncJoinCode(JoinCode),
    #[serde(rename = "direct.sync.joinRecovery")]
    SyncJoinRecovery(RecoveryKey),
    #[serde(rename = "direct.sync.devices")]
    SyncDevices(Empty),
    #[serde(rename = "direct.sync.usage")]
    SyncUsage(Empty),
    #[serde(rename = "direct.sync.deviceRemove")]
    SyncDeviceRemove(Device),
    #[serde(rename = "direct.sync.icloudStatus")]
    SyncIcloudStatus(Empty),
    #[serde(rename = "direct.sync.icloudUse")]
    SyncIcloudUse(MaybeRecoveryKey),
    #[serde(rename = "direct.sync.icloudLook")]
    SyncIcloudLook(Empty),
    #[serde(rename = "direct.sync.icloudJoin")]
    SyncIcloudJoin(Accept),
    #[serde(rename = "direct.sync.icloudUploadAgain")]
    SyncIcloudUploadAgain(Empty),
    #[serde(rename = "direct.sync.icloudRotate")]
    SyncIcloudRotate(Empty),
    #[serde(rename = "direct.sync.icloudLeave")]
    SyncIcloudLeave(RecoveryKey),
    #[serde(rename = "direct.sync.icloudStorage")]
    SyncIcloudStorage(Empty),
}

pub const OPS: &[&str] = &[
    "direct.editorSettings.get",
    "direct.editorSettings.set",
    "direct.fonts.list",
    "direct.fonts.import",
    "direct.crashReports.get",
    "direct.crashReports.set",
    "direct.ai.get",
    "direct.ai.set",
    "direct.ai.keySet",
    "direct.ai.keyClear",
    "direct.licence.get",
    "direct.licence.set",
    "direct.licence.remove",
    "direct.licence.refresh",
    "direct.store.products",
    "direct.store.purchase",
    "direct.store.restore",
    "direct.store.macKey",
    "direct.store.refund",
    "direct.sync.get",
    "direct.sync.set",
    "direct.sync.vaultCreate",
    "direct.sync.vaultRotate",
    "direct.sync.vaultLeave",
    "direct.sync.recoveryKey",
    "direct.sync.recoverySaved",
    "direct.sync.pairingOpen",
    "direct.sync.pairingCheck",
    "direct.sync.pairingCancel",
    "direct.sync.joinCode",
    "direct.sync.joinRecovery",
    "direct.sync.devices",
    "direct.sync.usage",
    "direct.sync.deviceRemove",
    "direct.sync.icloudStatus",
    "direct.sync.icloudUse",
    "direct.sync.icloudLook",
    "direct.sync.icloudJoin",
    "direct.sync.icloudUploadAgain",
    "direct.sync.icloudRotate",
    "direct.sync.icloudLeave",
    "direct.sync.icloudStorage",
];

/// A request Rust answers itself, under the name Swift sent.
#[derive(Clone, PartialEq)]
pub struct Asked {
    pub id: u64,
    pub name: &'static str,
    pub op: Op,
}

impl std::fmt::Debug for Asked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Asked {{ id: {}, name: {} }}", self.id, self.name)
    }
}

fn value<T: Serialize>(outcome: Result<T, &'static str>) -> Result<Value, &'static str> {
    serde_json::to_value(outcome?).map_err(|_| "E_SCREENS_RESULT_INVALID")
}

pub async fn run(services: &Services, op: Op) -> Result<Value, &'static str> {
    let Services {
        editor_settings: settings,
        announce,
        fonts,
        ai,
        licence,
        shop,
        sync,
        counts,
    } = services;
    match op {
        Op::EditorSettingsGet(Empty {}) => {
            value(editor_settings::editor_settings_get_inner(settings).await)
        }
        Op::EditorSettingsSet(EditorPatch { patch }) => value(
            editor_settings::editor_settings_set_inner(settings, patch, |next| announce(next))
                .await,
        ),
        Op::FontsList(Empty {}) => value(fonts::fonts_list_inner(fonts).await),
        Op::FontsImport(Picked { path }) => {
            value(fonts::font_import_picked_inner(fonts, path).await)
        }
        Op::CrashReportsGet(Empty {}) => value(Ok(crate::crash::crash_reports_now())),
        Op::CrashReportsSet(On { on }) => value(crate::crash::crash_reports_set_inner(on)),
        Op::AiGet(Empty {}) => value(ai::ai_settings_get_inner(ai).await),
        Op::AiSet(Providers { settings }) => value(ai::ai_settings_set_inner(ai, settings).await),
        Op::AiKeySet(ProviderKey { provider, key }) => {
            value(ai::ai_key_set_inner(ai, provider, key).await)
        }
        Op::AiKeyClear(Provider { provider }) => value(ai::ai_key_clear_inner(ai, provider).await),
        Op::LicenceGet(Empty {}) => value(licence::licence_get_inner(licence).await),
        Op::LicenceSet(Key { key }) => value(licence::licence_set_inner(licence, key).await),
        Op::LicenceRemove(Empty {}) => value(licence::licence_remove_inner(licence).await),
        Op::LicenceRefresh(Empty {}) => value(licence::licence_refresh_inner(licence).await),
        Op::StoreProducts(Empty {}) => value(licence::app_store::store_products_inner(shop).await),
        Op::StorePurchase(Offer { product }) => {
            value(licence::app_store::store_purchase_inner(shop, &product).await)
        }
        Op::StoreRestore(Empty {}) => {
            value(licence::app_store::store_restore_inner(shop, licence).await)
        }
        Op::StoreMacKey(Empty {}) => value(licence::app_store::store_mac_key_inner(licence).await),
        Op::StoreRefund(Empty {}) => value(licence::app_store::store_refund_inner(shop).await),
        Op::SyncGet(Empty {}) => value(sync::sync_get_inner(sync).await),
        Op::SyncSet(SyncSettings { patch }) => value(sync::sync_set_inner(sync, patch).await),
        Op::SyncVaultCreate(RelaySecret { relay_secret }) => {
            value(sync::sync_vault_create_inner(sync, relay_secret).await)
        }
        Op::SyncVaultRotate(RelaySecret { relay_secret }) => {
            value(sync::sync_vault_rotate_inner(sync, relay_secret).await)
        }
        Op::SyncVaultLeave(Empty {}) => value(sync::sync_vault_leave_inner(sync).await),
        Op::SyncRecoveryKey(Empty {}) => value(sync::sync_recovery_key_inner(sync).await),
        Op::SyncRecoverySaved(Empty {}) => value(sync::sync_recovery_saved_inner(sync).await),
        Op::SyncPairingOpen(Empty {}) => value(sync::sync_pairing_open_inner(sync).await),
        Op::SyncPairingCheck(Empty {}) => value(sync::sync_pairing_check_inner(sync).await),
        Op::SyncPairingCancel(Empty {}) => value(sync::sync_pairing_cancel_inner(sync).await),
        Op::SyncJoinCode(JoinCode { code, via }) => {
            value(sync::sync_join_code_inner(sync, code, via).await)
        }
        Op::SyncJoinRecovery(RecoveryKey { recovery_key }) => {
            value(sync::sync_join_recovery_inner(sync, recovery_key).await)
        }
        Op::SyncDevices(Empty {}) => value(sync::sync_devices_inner(sync).await),
        Op::SyncUsage(Empty {}) => value(sync::sync_usage_inner(sync).await),
        Op::SyncDeviceRemove(Device { device }) => {
            value(sync::sync_device_remove_inner(sync, device).await)
        }
        Op::SyncIcloudStatus(Empty {}) => value(sync::sync_icloud_status_inner(sync).await),
        Op::SyncIcloudUse(MaybeRecoveryKey { recovery_key }) => {
            value(sync::sync_icloud_use_inner(sync, counts, recovery_key).await)
        }
        Op::SyncIcloudLook(Empty {}) => value(sync::sync_icloud_look_inner(sync, counts).await),
        Op::SyncIcloudJoin(Accept { accept }) => {
            value(sync::sync_icloud_join_inner(sync, accept).await)
        }
        Op::SyncIcloudUploadAgain(Empty {}) => {
            value(sync::sync_icloud_upload_again_inner(sync).await)
        }
        Op::SyncIcloudRotate(Empty {}) => value(sync::sync_icloud_rotate_inner(sync).await),
        Op::SyncIcloudLeave(RecoveryKey { recovery_key }) => {
            value(sync::sync_icloud_leave_inner(sync, recovery_key).await)
        }
        Op::SyncIcloudStorage(Empty {}) => value(sync::sync_icloud_storage_inner(counts).await),
    }
}

/// The reply Swift hears, as `hub` encodes one; a failure is logged with its code.
pub async fn answer(services: &Services, asked: Asked) -> Vec<u8> {
    let Asked { id, name, op } = asked;
    let outcome = run(services, op).await;
    if let Err(code) = outcome {
        log::warn!("W_SCREENS_DIRECT_FAILED op={name} id={id} code={code}");
    }
    serde_json::to_vec(
        &Reply {
            id,
            outcome: outcome.map_err(String::from),
        }
        .to_value(),
    )
    .unwrap_or_default()
}

/// What `answer` sends when the operation could not run at all.
pub fn refused(id: u64, code: &str) -> Vec<u8> {
    serde_json::to_vec(&Reply::refused(id, code).to_value()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    use serde_json::json;
    use zeroize::Zeroizing;

    use super::*;
    use crate::licence::testing;
    use crate::screens::message::{self, Asked as Checked};
    use crate::storage::Db;
    use crate::sync::{SecretStore, SyncError};

    #[derive(Default)]
    struct Secrets(Mutex<HashMap<String, Vec<u8>>>);

    impl SecretStore for Secrets {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SyncError> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .map(Zeroizing::new))
        }

        fn add(&self, account: &str, secret: &[u8]) -> Result<bool, SyncError> {
            let mut items = self.0.lock().unwrap();
            if items.contains_key(account) {
                return Ok(false);
            }
            items.insert(account.into(), secret.to_vec());
            Ok(true)
        }

        fn replace(&self, account: &str, secret: &[u8]) -> Result<(), SyncError> {
            self.0
                .lock()
                .unwrap()
                .insert(account.into(), secret.to_vec());
            Ok(())
        }

        fn remove(&self, account: &str) -> Result<bool, SyncError> {
            Ok(self.0.lock().unwrap().remove(account).is_some())
        }
    }

    struct Setup {
        services: Services,
        announced: Arc<Mutex<Vec<editor_settings::Snapshot>>>,
        _dir: tempfile::TempDir,
    }

    /// The app's services on a temporary folder, as `lib.rs` builds them at launch.
    fn setup() -> Setup {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path();
        let licence = testing::licence(path, false);
        let db = Db::spawn(&path.join("devot.sqlite")).expect("database");
        let announced = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::clone(&announced);
        let sync = SyncService::new(
            crate::sync::settings::SettingsStore::new(&path.join(crate::sync::settings::FILE)),
            Arc::new(Secrets::default()),
            Arc::new(|_, _| ()),
            licence::Gate::of(&licence),
        )
        .with_handover(Arc::new(Secrets::default()));
        let services = Services {
            editor_settings: Arc::new(EditorSettingsStore::new(&path.join(editor_settings::FILE))),
            announce: Arc::new(move |next| heard.lock().unwrap().push(next.clone())),
            fonts: Arc::new(Fonts::new(path)),
            ai: Arc::new(Ai::new(
                ai::settings::SettingsStore::new(&path.join(ai::settings::FILE)),
                Arc::new(ai::keychain::MemoryKeys::default()),
                licence::Gate::of(&licence),
            )),
            licence,
            shop: Shop(None),
            sync: Arc::new(sync),
            counts: NoteCounts::of(&db),
        };
        Setup {
            services,
            announced,
            _dir: dir,
        }
    }

    fn block_on<T>(work: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(work)
    }

    fn request(op: &str, args: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({ "v": 1, "id": 1, "op": op, "args": args })).unwrap()
    }

    /// Swift's request as it crosses the bridge: checked, then run.
    fn direct(setup: &Setup, op: &str, args: Value) -> Result<Value, &'static str> {
        match message::from_swift(1, &request(op, args))? {
            Checked::Direct(asked) => block_on(run(&setup.services, asked.op)),
            Checked::Page(_) => panic!("{op} went to the page"),
        }
    }

    fn json<T: Serialize>(outcome: Result<T, &'static str>) -> Result<Value, &'static str> {
        outcome.map(|value| serde_json::to_value(value).unwrap())
    }

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    /// The enum's own names, from serde's refusal of a name it does not know.
    fn variants() -> Vec<String> {
        let refusal = serde_json::from_value::<Op>(json!({ "op": "?", "args": {} }))
            .err()
            .expect("refused")
            .to_string();
        refusal
            .split('`')
            .skip(3)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn every_operation_belongs_to_a_settings_area_and_none_to_notes() {
        const AREAS: [&str; 7] = [
            "editorSettings",
            "fonts",
            "crashReports",
            "ai",
            "licence",
            "store",
            "sync",
        ];
        assert_eq!(variants(), OPS);
        let mut seen = HashSet::new();
        for name in OPS {
            let mut parts = name.split('.');
            assert_eq!(parts.next(), Some("direct"), "{name}");
            assert!(
                parts.next().is_some_and(|area| AREAS.contains(&area)),
                "{name}"
            );
            let lower = name.to_lowercase();
            for note in ["note", "book", "tag", "trash", "revision", "search"] {
                assert!(!lower.contains(note), "{name}");
            }
            assert!(seen.insert(name), "{name} twice");
        }
        assert!(message::OPS.iter().all(|op| !op.starts_with("direct.")));
    }

    #[test]
    fn the_operations_hold_no_way_to_the_database_but_two_counts() {
        let source = include_str!("direct.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or_default();
        let words: HashSet<&str> = code
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .collect();
        for way in ["Db", "storage", "notes", "Store", "put_note"] {
            assert!(!words.contains(way), "{way}");
        }
        assert!(words.contains("NoteCounts"));
    }

    #[test]
    fn a_direct_name_swift_does_not_know_or_bad_args_are_refused_before_anything_runs() {
        for (op, args) in [
            ("direct.notes.put", json!({})),
            ("direct.note.create", json!({})),
            ("direct", json!({})),
        ] {
            assert_eq!(
                message::from_swift(1, &request(op, args)).err(),
                Some("E_SCREENS_OP_UNKNOWN"),
                "{op}"
            );
        }
        for (op, args) in [
            ("direct.licence.get", json!({ "key": "x" })),
            ("direct.licence.set", json!({})),
            ("direct.store.purchase", json!({ "product": 1 })),
            ("direct.crashReports.set", json!({ "on": "yes" })),
            (
                "direct.sync.set",
                json!({ "patch": { "relayUrl": "https://a", "token": "t" } }),
            ),
            ("direct.ai.keyClear", json!({ "provider": "other" })),
        ] {
            assert_eq!(
                message::from_swift(1, &request(op, args)).err(),
                Some("E_SCREENS_ARGS_INVALID"),
                "{op}"
            );
        }
    }

    #[test]
    fn editor_settings_change_as_the_command_changes_them_and_every_window_hears() {
        let (by_command, by_direct) = (setup(), setup());
        let store = &by_command.services.editor_settings;
        assert_eq!(
            direct(&by_direct, "direct.editorSettings.get", json!({})),
            json(block_on(editor_settings::editor_settings_get_inner(store)))
        );
        let larger = json!({ "fontSize": 16 });
        let commanded = json(block_on(editor_settings::editor_settings_set_inner(
            store,
            object(larger.clone()),
            |_| {},
        )));
        assert!(commanded.is_ok());
        assert_eq!(
            direct(
                &by_direct,
                "direct.editorSettings.set",
                json!({ "patch": larger })
            ),
            commanded
        );
        let heard = by_direct.announced.lock().unwrap().clone();
        assert_eq!(heard.len(), 1);
        assert_eq!(json(Ok(heard[0].clone())), commanded);

        let too_large = json!({ "fontSize": 99 });
        let refused = block_on(editor_settings::editor_settings_set_inner(
            store,
            object(too_large.clone()),
            |_| {},
        ));
        assert!(refused.is_err());
        assert_eq!(
            direct(
                &by_direct,
                "direct.editorSettings.set",
                json!({ "patch": too_large })
            ),
            json(refused)
        );
        assert_eq!(by_direct.announced.lock().unwrap().len(), 1);
    }

    #[test]
    fn fonts_and_crash_reports_read_as_the_commands_read_them() {
        let setup = setup();
        assert_eq!(
            direct(&setup, "direct.fonts.list", json!({})),
            json(block_on(fonts::fonts_list_inner(&setup.services.fonts)))
        );
        assert_eq!(
            direct(&setup, "direct.crashReports.get", json!({})),
            json(Ok(crate::crash::crash_reports_now()))
        );
        for on in [true, false] {
            assert_eq!(
                direct(&setup, "direct.crashReports.set", json!({ "on": on })),
                json(crate::crash::crash_reports_set_inner(on)),
                "{on}"
            );
        }
    }

    #[test]
    fn a_font_the_picker_copied_imports_as_the_command_imports_it() {
        let setup = setup();
        let picked = tempfile::tempdir().unwrap();
        let path = picked.path().join("Fira Code.ttf");
        std::fs::write(&path, [0, 1, 0, 0, 0, 9, 0, 0]).unwrap();
        let font = json!({ "id": "Fira Code.ttf", "name": "Fira Code" });
        assert_eq!(
            direct(&setup, "direct.fonts.import", json!({ "path": path })),
            Ok(font.clone())
        );
        assert_eq!(
            direct(&setup, "direct.fonts.list", json!({})),
            Ok(json!([font]))
        );
        let outside = picked.path().join("../elsewhere/Fira Code.ttf");
        for path in [
            json!("/etc/hosts"),
            json!("Fira Code.ttf"),
            json!(outside),
            json!(7),
        ] {
            assert_eq!(
                direct(&setup, "direct.fonts.import", json!({ "path": path })),
                Err("E_SCREENS_ARGS_INVALID"),
                "{path}"
            );
        }
    }

    #[test]
    fn ai_providers_change_as_the_commands_change_them() {
        let (by_command, by_direct) = (setup(), setup());
        let ai = &by_command.services.ai;
        assert_eq!(
            direct(&by_direct, "direct.ai.get", json!({})),
            json(block_on(ai::ai_settings_get_inner(ai)))
        );
        let mut settings = AiSettings::default();
        settings.anthropic.model = "model-x".into();
        let commanded = json(block_on(ai::ai_settings_set_inner(ai, settings.clone())));
        assert!(commanded.is_ok());
        assert_eq!(
            direct(&by_direct, "direct.ai.set", json!({ "settings": settings })),
            commanded
        );
        settings.openai.endpoint = "ftp://example.com".into();
        let refused = block_on(ai::ai_settings_set_inner(ai, settings.clone()));
        assert!(refused.is_err());
        assert_eq!(
            direct(&by_direct, "direct.ai.set", json!({ "settings": settings })),
            json(refused)
        );
        let commanded = json(block_on(ai::ai_key_set_inner(
            ai,
            ProviderId::Anthropic,
            "sk-test".into(),
        )));
        assert_eq!(
            commanded.as_ref().map(|s| &s["anthropic"]["key"]),
            Ok(&json!("set"))
        );
        assert_eq!(
            direct(
                &by_direct,
                "direct.ai.keySet",
                json!({ "provider": "anthropic", "key": "sk-test" })
            ),
            commanded
        );
        assert_eq!(
            direct(
                &by_direct,
                "direct.ai.keyClear",
                json!({ "provider": "anthropic" })
            ),
            json(block_on(ai::ai_key_clear_inner(ai, ProviderId::Anthropic)))
        );
    }

    #[test]
    fn the_licence_changes_as_the_commands_change_it() {
        let (by_command, by_direct) = (setup(), setup());
        let licence = &by_command.services.licence;
        assert_eq!(
            direct(&by_direct, "direct.licence.get", json!({})),
            json(block_on(licence::licence_get_inner(licence)))
        );
        let refused = block_on(licence::licence_set_inner(licence, "not a key".into()));
        assert!(refused.is_err());
        assert_eq!(
            direct(
                &by_direct,
                "direct.licence.set",
                json!({ "key": "not a key" })
            ),
            json(refused)
        );
        let key = testing::key(testing::ID);
        let commanded = json(block_on(licence::licence_set_inner(licence, key.clone())));
        assert_eq!(
            commanded.as_ref().map(|s| &s["id"]),
            Ok(&json!(testing::ID))
        );
        assert_eq!(
            direct(&by_direct, "direct.licence.set", json!({ "key": key })),
            commanded
        );
        assert_eq!(
            direct(&by_direct, "direct.licence.refresh", json!({})),
            json(block_on(licence::licence_refresh_inner(licence)))
        );
        assert_eq!(
            direct(&by_direct, "direct.licence.remove", json!({})),
            json(block_on(licence::licence_remove_inner(licence)))
        );
    }

    #[test]
    fn a_build_without_the_app_store_refuses_its_actions_with_the_commands_codes() {
        let setup = setup();
        let services = &setup.services;
        for (op, args, commanded) in [
            (
                "direct.store.products",
                json!({}),
                json(block_on(licence::app_store::store_products_inner(
                    &services.shop,
                ))),
            ),
            (
                "direct.store.purchase",
                json!({ "product": "pro" }),
                json(block_on(licence::app_store::store_purchase_inner(
                    &services.shop,
                    "pro",
                ))),
            ),
            (
                "direct.store.restore",
                json!({}),
                json(block_on(licence::app_store::store_restore_inner(
                    &services.shop,
                    &services.licence,
                ))),
            ),
            (
                "direct.store.macKey",
                json!({}),
                json(block_on(licence::app_store::store_mac_key_inner(
                    &services.licence,
                ))),
            ),
            (
                "direct.store.refund",
                json!({}),
                json(block_on(licence::app_store::store_refund_inner(
                    &services.shop,
                ))),
            ),
        ] {
            assert_eq!(commanded, Err("E_APP_STORE_UNAVAILABLE"), "{op}");
            assert_eq!(direct(&setup, op, args), commanded, "{op}");
        }
        assert_eq!(
            direct(
                &setup,
                "direct.store.purchase",
                json!({ "product": "lifetime" })
            ),
            json(block_on(licence::app_store::store_purchase_inner(
                &services.shop,
                "lifetime",
            ))),
        );
        assert_eq!(
            direct(
                &setup,
                "direct.store.purchase",
                json!({ "product": "lifetime" })
            ),
            Err("E_APP_STORE_UNKNOWN_PRODUCT"),
        );
    }

    #[test]
    fn sync_settings_read_and_change_as_the_commands_do() {
        let setup = setup();
        let sync = &setup.services.sync;
        let counts = &setup.services.counts;
        for (op, commanded) in [
            (
                "direct.sync.get",
                json(block_on(sync::sync_get_inner(sync))),
            ),
            (
                "direct.sync.recoveryKey",
                json(block_on(sync::sync_recovery_key_inner(sync))),
            ),
            (
                "direct.sync.icloudStatus",
                json(block_on(sync::sync_icloud_status_inner(sync))),
            ),
            (
                "direct.sync.icloudStorage",
                json(block_on(sync::sync_icloud_storage_inner(counts))),
            ),
            (
                "direct.sync.devices",
                json(block_on(sync::sync_devices_inner(sync))),
            ),
            (
                "direct.sync.usage",
                json(block_on(sync::sync_usage_inner(sync))),
            ),
            (
                "direct.sync.pairingOpen",
                json(block_on(sync::sync_pairing_open_inner(sync))),
            ),
            (
                "direct.sync.pairingCancel",
                json(block_on(sync::sync_pairing_cancel_inner(sync))),
            ),
        ] {
            assert_eq!(direct(&setup, op, json!({})), commanded, "{op}");
        }
        let relay = SettingsPatch {
            relay_url: Some("https://relay.example.com".into()),
            enabled: Some(false),
        };
        let commanded = json(block_on(sync::sync_set_inner(sync, relay)));
        assert!(commanded.is_ok());
        assert_eq!(
            direct(
                &setup,
                "direct.sync.set",
                json!({ "patch": { "relayUrl": "https://relay.example.com", "enabled": false } })
            ),
            commanded
        );
    }

    #[test]
    fn sync_refuses_what_its_commands_refuse_with_the_same_codes() {
        let setup = setup();
        let sync = &setup.services.sync;
        let counts = &setup.services.counts;
        let long_key = "A".repeat(600);
        let not_a_relay = SettingsPatch {
            relay_url: Some("not a url".into()),
            enabled: None,
        };
        for (op, args, commanded) in [
            (
                "direct.sync.set",
                json!({ "patch": { "relayUrl": "not a url" } }),
                json(block_on(sync::sync_set_inner(sync, not_a_relay))),
            ),
            (
                "direct.sync.joinCode",
                json!({ "code": "ABCD", "via": "cloudkit" }),
                json(block_on(sync::sync_join_code_inner(
                    sync,
                    "ABCD".into(),
                    Some("cloudkit".into()),
                ))),
            ),
            (
                "direct.sync.icloudLeave",
                json!({ "recoveryKey": long_key }),
                json(block_on(sync::sync_icloud_leave_inner(
                    sync,
                    long_key.clone(),
                ))),
            ),
            (
                "direct.sync.icloudUse",
                json!({ "recoveryKey": long_key }),
                json(block_on(sync::sync_icloud_use_inner(
                    sync,
                    counts,
                    Some(long_key.clone()),
                ))),
            ),
            (
                "direct.sync.vaultCreate",
                json!({ "relaySecret": "" }),
                json(block_on(sync::sync_vault_create_inner(sync, String::new()))),
            ),
            (
                "direct.sync.deviceRemove",
                json!({ "device": "" }),
                json(block_on(sync::sync_device_remove_inner(
                    sync,
                    String::new(),
                ))),
            ),
        ] {
            assert!(commanded.is_err(), "{op}");
            assert_eq!(direct(&setup, op, args), commanded, "{op}");
        }
        assert_eq!(
            direct(
                &setup,
                "direct.sync.joinCode",
                json!({ "code": "ABCD", "via": "cloudkit" })
            ),
            Err("E_SYNC_PAIRING_VIA")
        );
        assert_eq!(
            direct(
                &setup,
                "direct.sync.icloudLeave",
                json!({ "recoveryKey": long_key })
            ),
            Err("E_SYNC_RECOVERY_FORMAT")
        );
    }

    #[test]
    fn answers_with_the_result_or_the_code_and_never_more() {
        let setup = setup();
        let asked = |op: &str, args: Value| match message::from_swift(1, &request(op, args)) {
            Ok(Checked::Direct(asked)) => Asked { id: 9, ..asked },
            _ => panic!("{op} not direct"),
        };
        fn sendable<T: Send>(work: T) -> T {
            work
        }
        let answered = |asked: Asked| -> Value {
            serde_json::from_slice(&block_on(sendable(answer(&setup.services, asked)))).unwrap()
        };
        let licence = json(block_on(licence::licence_get_inner(
            &setup.services.licence,
        )));
        assert_eq!(
            answered(asked("direct.licence.get", json!({}))),
            json!({ "v": 1, "id": 9, "ok": true, "result": licence.unwrap() })
        );
        assert_eq!(
            answered(asked("direct.store.refund", json!({}))),
            json!({ "v": 1, "id": 9, "ok": false, "code": "E_APP_STORE_UNAVAILABLE" })
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&refused(4, "E_SCREENS_INTERNAL")).unwrap(),
            json!({ "v": 1, "id": 4, "ok": false, "code": "E_SCREENS_INTERNAL" })
        );
        let secret = asked("direct.licence.set", json!({ "key": "devot1.secret" }));
        assert!(!format!("{secret:?}").contains("secret"));
    }
}
