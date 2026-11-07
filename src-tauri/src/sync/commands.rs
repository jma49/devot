use std::sync::Arc;

use tauri::State;

use crate::task;

use crate::storage::Db;

use super::client::{DeviceInfo, RelayUsage};
use super::service::{
    Connected, Created, ICloudView, PairingCheck, PairingView, PullDto, PushDto, PushItemDto,
    SettingsPatch, Snapshot, StatusView, SyncService,
};

/// The longest cursor the engine keeps (`MAX_CURSOR` in commands/sync.rs).
const MAX_CURSOR: usize = 4096;
const MAX_RECOVERY_KEY: usize = 512;
const INTERNAL: &str = "E_SYNC_INTERNAL";

#[tauri::command]
pub async fn sync_get(sync: State<'_, Arc<SyncService>>) -> Result<Snapshot, String> {
    Ok(sync_get_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_set(
    sync: State<'_, Arc<SyncService>>,
    patch: SettingsPatch,
) -> Result<Snapshot, String> {
    Ok(sync_set_inner(&sync, patch).await?)
}

/// The relay secret is used for the one request that creates the vault, never stored. The answer
/// carries the recovery key when this call made the vault, to show once.
#[tauri::command]
pub async fn sync_vault_create(
    sync: State<'_, Arc<SyncService>>,
    relay_secret: String,
) -> Result<Created, String> {
    Ok(sync_vault_create_inner(&sync, relay_secret).await?)
}

/// Rotates the vault's key (docs/adr/0017-sync-key-rotation.md). The relay secret makes the
/// successor in one request and is never stored; the answer carries the new recovery key.
#[tauri::command]
pub async fn sync_vault_rotate(
    sync: State<'_, Arc<SyncService>>,
    relay_secret: String,
) -> Result<Created, String> {
    Ok(sync_vault_rotate_inner(&sync, relay_secret).await?)
}

/// Leaves the relay vault this device holds: its key and token go here, its notes stay, and
/// nothing changes on the relay or the other devices.
#[tauri::command]
pub async fn sync_vault_leave(sync: State<'_, Arc<SyncService>>) -> Result<Snapshot, String> {
    Ok(sync_vault_leave_inner(&sync).await?)
}

/// The recovery key until this device says it was saved; then `null`.
#[tauri::command]
pub async fn sync_recovery_key(
    sync: State<'_, Arc<SyncService>>,
) -> Result<Option<String>, String> {
    Ok(sync_recovery_key_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_recovery_saved(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    Ok(sync_recovery_saved_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_pairing_open(sync: State<'_, Arc<SyncService>>) -> Result<PairingView, String> {
    Ok(sync_pairing_open_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_pairing_check(sync: State<'_, Arc<SyncService>>) -> Result<PairingCheck, String> {
    Ok(sync_pairing_check_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_pairing_cancel(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    Ok(sync_pairing_cancel_inner(&sync).await?)
}

/// A pairing code as typed or pasted, or the link its QR code holds. `via` is the way a code alone
/// goes: `relay` (the default) or `icloud`.
#[tauri::command]
pub async fn sync_join_code(
    sync: State<'_, Arc<SyncService>>,
    code: String,
    via: Option<String>,
) -> Result<Snapshot, String> {
    Ok(sync_join_code_inner(&sync, code, via).await?)
}

#[tauri::command]
pub async fn sync_join_recovery(
    sync: State<'_, Arc<SyncService>>,
    recovery_key: String,
) -> Result<Snapshot, String> {
    Ok(sync_join_recovery_inner(&sync, recovery_key).await?)
}

#[tauri::command]
pub async fn sync_devices(sync: State<'_, Arc<SyncService>>) -> Result<Vec<DeviceInfo>, String> {
    Ok(sync_devices_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_usage(sync: State<'_, Arc<SyncService>>) -> Result<RelayUsage, String> {
    Ok(sync_usage_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_device_remove(
    sync: State<'_, Arc<SyncService>>,
    device: String,
) -> Result<Vec<DeviceInfo>, String> {
    Ok(sync_device_remove_inner(&sync, device).await?)
}

#[tauri::command]
pub async fn sync_connect(
    sync: State<'_, Arc<SyncService>>,
    db: State<'_, Db>,
) -> Result<Connected, String> {
    let state = db
        .call(|store| store.sync_state())
        .await
        .map_err(|e| e.to_string())?;
    let has_synced = state
        .iter()
        .any(|(key, value)| key == "hasSynced" && value == "1");
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.connect(has_synced)
    })
    .await
}

/// A relay's cursor is digits; iCloud's, an archived change token in base64.
pub(crate) fn valid_cursor(cursor: &str) -> bool {
    cursor.len() <= MAX_CURSOR
        && cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

#[tauri::command]
pub async fn sync_pull(
    sync: State<'_, Arc<SyncService>>,
    since: String,
) -> Result<PullDto, String> {
    if !valid_cursor(&since) {
        return Err("E_SYNC_CURSOR_INVALID".into());
    }
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| sync.pull(&since)).await
}

#[tauri::command]
pub async fn sync_push(
    sync: State<'_, Arc<SyncService>>,
    id: String,
    base: u64,
    data: String,
    kind: Option<String>,
    tag: Option<String>,
) -> Result<PushDto, String> {
    if !tag.as_deref().is_none_or(crate::commands::sync::valid_tag) {
        return Err("E_SYNC_TAG_INVALID".into());
    }
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.push(
            &id,
            base,
            &data,
            kind.as_deref().unwrap_or("record"),
            tag.as_deref().unwrap_or(""),
        )
    })
    .await
}

/// A batch for iCloud; every item is checked as `sync_push` checks one.
#[tauri::command]
pub async fn sync_push_many(
    sync: State<'_, Arc<SyncService>>,
    items: Vec<PushItemDto>,
) -> Result<Vec<PushDto>, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| sync.push_many(&items)).await
}

#[tauri::command]
pub async fn sync_icloud_status(sync: State<'_, Arc<SyncService>>) -> Result<ICloudView, String> {
    Ok(sync_icloud_status_inner(&sync).await?)
}

#[tauri::command]
pub async fn sync_icloud_use(
    sync: State<'_, Arc<SyncService>>,
    db: State<'_, Db>,
    recovery_key: Option<String>,
) -> Result<Snapshot, String> {
    Ok(sync_icloud_use_inner(&sync, &NoteCounts::of(&db), recovery_key).await?)
}

/// Looks for the Apple ID's vault now, as at launch: Settings' way to look again.
#[tauri::command]
pub async fn sync_icloud_look(
    sync: State<'_, Arc<SyncService>>,
    db: State<'_, Db>,
) -> Result<Snapshot, String> {
    Ok(sync_icloud_look_inner(&sync, &NoteCounts::of(&db)).await?)
}

/// The owner's answer to joining the Apple ID's vault with notes in the library.
#[tauri::command]
pub async fn sync_icloud_join(
    sync: State<'_, Arc<SyncService>>,
    accept: bool,
) -> Result<Snapshot, String> {
    Ok(sync_icloud_join_inner(&sync, accept).await?)
}

#[tauri::command]
pub async fn sync_icloud_upload_again(
    sync: State<'_, Arc<SyncService>>,
) -> Result<Snapshot, String> {
    Ok(sync_icloud_upload_again_inner(&sync).await?)
}

/// Changes the key of the vault on iCloud (docs/adr/0017-sync-key-rotation.md, On iCloud); the
/// answer carries the new recovery key.
#[tauri::command]
pub async fn sync_icloud_rotate(sync: State<'_, Arc<SyncService>>) -> Result<Created, String> {
    Ok(sync_icloud_rotate_inner(&sync).await?)
}

/// Leave This Vault: the vault's recovery key confirms it.
#[tauri::command]
pub async fn sync_icloud_leave(
    sync: State<'_, Arc<SyncService>>,
    recovery_key: String,
) -> Result<Snapshot, String> {
    Ok(sync_icloud_leave_inner(&sync, recovery_key).await?)
}

/// About what the vault holds on its transport, from the records here: Settings shows it for iCloud,
/// whose storage Devot does not read.
#[tauri::command]
pub async fn sync_icloud_storage(db: State<'_, Db>) -> Result<u64, String> {
    Ok(sync_icloud_storage_inner(&NoteCounts::of(&db)).await?)
}

/// The two counts sync's settings read from the database, and nothing else: whoever holds this
/// can read them and cannot write a note.
pub(crate) struct NoteCounts(Db);

impl NoteCounts {
    pub(crate) fn of(db: &Db) -> Self {
        Self(db.clone())
    }

    async fn own_notes(&self) -> Result<u64, &'static str> {
        self.0
            .call(|store| store.own_note_count())
            .await
            .map_err(|error| error.code())
    }

    async fn stored_bytes(&self) -> Result<u64, &'static str> {
        self.0
            .call(|store| store.sync_stored_bytes())
            .await
            .map_err(|error| error.code())
    }
}

/// Looks for the Apple ID's vault at launch and when the account changes; the outcome reaches the
/// windows in the snapshot.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) async fn look_for_icloud_vault(app: tauri::AppHandle) {
    use tauri::Manager as _;
    let (Some(sync), Some(db)) = (app.try_state::<Arc<SyncService>>(), app.try_state::<Db>())
    else {
        return;
    };
    // A note made after this count goes into the vault unasked, as one made after the join would.
    let looked = sync_icloud_look_inner(sync.inner(), &NoteCounts::of(&db)).await;
    if let Err(code) = looked {
        log::info!("I_SYNC_ICLOUD_LOOK_FAILED {code}");
    }
}

#[tauri::command]
pub async fn sync_disconnect(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| {
        sync.disconnect();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn sync_status_report(
    sync: State<'_, Arc<SyncService>>,
    status: StatusView,
) -> Result<(), String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| sync.report(status)).await
}

/// The bodies of the settings commands, which the iPhone's native Settings call too
/// (`screens::direct`). Each change reaches the windows through the service's own `Emit`.
pub(crate) async fn sync_get_inner(sync: &Arc<SyncService>) -> Result<Snapshot, &'static str> {
    task::coded_with(sync, INTERNAL, |sync| Ok(sync.snapshot())).await
}

pub(crate) async fn sync_set_inner(
    sync: &Arc<SyncService>,
    patch: SettingsPatch,
) -> Result<Snapshot, &'static str> {
    task::coded_with(sync, INTERNAL, move |sync| sync.set(patch)).await
}

pub(crate) async fn sync_vault_create_inner(
    sync: &Arc<SyncService>,
    relay_secret: String,
) -> Result<Created, &'static str> {
    let secret = zeroize::Zeroizing::new(relay_secret);
    task::coded_with(sync, INTERNAL, move |sync| sync.create_vault(&secret)).await
}

pub(crate) async fn sync_vault_rotate_inner(
    sync: &Arc<SyncService>,
    relay_secret: String,
) -> Result<Created, &'static str> {
    let secret = zeroize::Zeroizing::new(relay_secret);
    task::coded_with(sync, INTERNAL, move |sync| sync.rotate_vault(&secret)).await
}

pub(crate) async fn sync_vault_leave_inner(
    sync: &Arc<SyncService>,
) -> Result<Snapshot, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::leave_vault).await
}

pub(crate) async fn sync_recovery_key_inner(
    sync: &Arc<SyncService>,
) -> Result<Option<String>, &'static str> {
    task::coded_with(sync, INTERNAL, |sync| {
        Ok(sync.recovery_key()?.map(|key| key.to_string()))
    })
    .await
}

pub(crate) async fn sync_recovery_saved_inner(sync: &Arc<SyncService>) -> Result<(), &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::recovery_saved).await
}

pub(crate) async fn sync_pairing_open_inner(
    sync: &Arc<SyncService>,
) -> Result<PairingView, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::pairing_open).await
}

pub(crate) async fn sync_pairing_check_inner(
    sync: &Arc<SyncService>,
) -> Result<PairingCheck, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::pairing_check).await
}

pub(crate) async fn sync_pairing_cancel_inner(sync: &Arc<SyncService>) -> Result<(), &'static str> {
    task::coded_with(sync, INTERNAL, |sync| {
        sync.pairing_cancel();
        Ok(())
    })
    .await
}

fn join_via(via: Option<&str>) -> Result<bool, &'static str> {
    match via {
        None | Some("relay") => Ok(false),
        Some("icloud") => Ok(true),
        Some(_) => Err("E_SYNC_PAIRING_VIA"),
    }
}

pub(crate) async fn sync_join_code_inner(
    sync: &Arc<SyncService>,
    code: String,
    via: Option<String>,
) -> Result<Snapshot, &'static str> {
    let code = zeroize::Zeroizing::new(code);
    let icloud = join_via(via.as_deref())?;
    task::coded_with(sync, INTERNAL, move |sync| {
        sync.join_with_code_via(&code, icloud)
    })
    .await
}

pub(crate) async fn sync_join_recovery_inner(
    sync: &Arc<SyncService>,
    recovery_key: String,
) -> Result<Snapshot, &'static str> {
    let key = zeroize::Zeroizing::new(recovery_key);
    task::coded_with(sync, INTERNAL, move |sync| sync.join_with_recovery(&key)).await
}

pub(crate) async fn sync_devices_inner(
    sync: &Arc<SyncService>,
) -> Result<Vec<DeviceInfo>, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::devices).await
}

pub(crate) async fn sync_usage_inner(sync: &Arc<SyncService>) -> Result<RelayUsage, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::usage).await
}

pub(crate) async fn sync_device_remove_inner(
    sync: &Arc<SyncService>,
    device: String,
) -> Result<Vec<DeviceInfo>, &'static str> {
    task::coded_with(sync, INTERNAL, move |sync| sync.remove_device(&device)).await
}

pub(crate) async fn sync_icloud_status_inner(
    sync: &Arc<SyncService>,
) -> Result<ICloudView, &'static str> {
    task::coded_with(sync, INTERNAL, |sync| Ok(sync.icloud_status())).await
}

fn recovery_key_fits(key: &str) -> Result<(), &'static str> {
    if key.len() > MAX_RECOVERY_KEY {
        return Err("E_SYNC_RECOVERY_FORMAT");
    }
    Ok(())
}

pub(crate) async fn sync_icloud_use_inner(
    sync: &Arc<SyncService>,
    counts: &NoteCounts,
    recovery_key: Option<String>,
) -> Result<Snapshot, &'static str> {
    let key = recovery_key.map(zeroize::Zeroizing::new);
    key.as_deref()
        .map_or(Ok(()), |key| recovery_key_fits(key))?;
    let notes = counts.own_notes().await?;
    task::coded_with(sync, INTERNAL, move |sync| {
        sync.use_icloud(key.as_deref().map(String::as_str), notes)
    })
    .await
}

pub(crate) async fn sync_icloud_look_inner(
    sync: &Arc<SyncService>,
    counts: &NoteCounts,
) -> Result<Snapshot, &'static str> {
    let notes = counts.own_notes().await?;
    task::coded_with(sync, INTERNAL, move |sync| sync.icloud_look(notes)).await
}

pub(crate) async fn sync_icloud_join_inner(
    sync: &Arc<SyncService>,
    accept: bool,
) -> Result<Snapshot, &'static str> {
    task::coded_with(sync, INTERNAL, move |sync| sync.icloud_join(accept)).await
}

pub(crate) async fn sync_icloud_upload_again_inner(
    sync: &Arc<SyncService>,
) -> Result<Snapshot, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::icloud_upload_again).await
}

pub(crate) async fn sync_icloud_rotate_inner(
    sync: &Arc<SyncService>,
) -> Result<Created, &'static str> {
    task::coded_with(sync, INTERNAL, SyncService::rotate_icloud).await
}

pub(crate) async fn sync_icloud_leave_inner(
    sync: &Arc<SyncService>,
    recovery_key: String,
) -> Result<Snapshot, &'static str> {
    let key = zeroize::Zeroizing::new(recovery_key);
    recovery_key_fits(&key)?;
    task::coded_with(sync, INTERNAL, move |sync| sync.icloud_leave(&key)).await
}

pub(crate) async fn sync_icloud_storage_inner(counts: &NoteCounts) -> Result<u64, &'static str> {
    counts.stored_bytes().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_goes_through_the_relay_unless_it_names_icloud() {
        assert_eq!(join_via(None), Ok(false));
        assert_eq!(join_via(Some("relay")), Ok(false));
        assert_eq!(join_via(Some("icloud")), Ok(true));
        for via in ["", "iCloud", "icloud ", "cloudkit"] {
            assert_eq!(join_via(Some(via)), Err("E_SYNC_PAIRING_VIA"), "{via:?}");
        }
    }
}
