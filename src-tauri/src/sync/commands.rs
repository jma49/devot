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

#[tauri::command]
pub async fn sync_get(sync: State<'_, Arc<SyncService>>) -> Result<Snapshot, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| Ok(sync.snapshot())).await
}

#[tauri::command]
pub async fn sync_set(
    sync: State<'_, Arc<SyncService>>,
    patch: SettingsPatch,
) -> Result<Snapshot, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| sync.set(patch)).await
}

/// The relay secret is used for the one request that creates the vault, never stored. The answer
/// carries the recovery key when this call made the vault, to show once.
#[tauri::command]
pub async fn sync_vault_create(
    sync: State<'_, Arc<SyncService>>,
    relay_secret: String,
) -> Result<Created, String> {
    let secret = zeroize::Zeroizing::new(relay_secret);
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.create_vault(&secret)
    })
    .await
}

/// The recovery key until this device says it was saved; then `null`.
#[tauri::command]
pub async fn sync_recovery_key(
    sync: State<'_, Arc<SyncService>>,
) -> Result<Option<String>, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| {
        Ok(sync.recovery_key()?.map(|key| key.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn sync_recovery_saved(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.recovery_saved()).await
}

#[tauri::command]
pub async fn sync_pairing_open(sync: State<'_, Arc<SyncService>>) -> Result<PairingView, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.pairing_open()).await
}

#[tauri::command]
pub async fn sync_pairing_check(sync: State<'_, Arc<SyncService>>) -> Result<PairingCheck, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.pairing_check()).await
}

#[tauri::command]
pub async fn sync_pairing_cancel(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| {
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

/// A pairing code as typed or pasted, or the link its QR code holds. `via` is the way a code alone
/// goes: `relay` (the default) or `icloud`.
#[tauri::command]
pub async fn sync_join_code(
    sync: State<'_, Arc<SyncService>>,
    code: String,
    via: Option<String>,
) -> Result<Snapshot, String> {
    let icloud = join_via(via.as_deref())?;
    let code = zeroize::Zeroizing::new(code);
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.join_with_code_via(&code, icloud)
    })
    .await
}

#[tauri::command]
pub async fn sync_join_recovery(
    sync: State<'_, Arc<SyncService>>,
    recovery_key: String,
) -> Result<Snapshot, String> {
    let key = zeroize::Zeroizing::new(recovery_key);
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.join_with_recovery(&key)
    })
    .await
}

#[tauri::command]
pub async fn sync_devices(sync: State<'_, Arc<SyncService>>) -> Result<Vec<DeviceInfo>, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.devices()).await
}

#[tauri::command]
pub async fn sync_usage(sync: State<'_, Arc<SyncService>>) -> Result<RelayUsage, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.usage()).await
}

#[tauri::command]
pub async fn sync_device_remove(
    sync: State<'_, Arc<SyncService>>,
    device: String,
) -> Result<Vec<DeviceInfo>, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.remove_device(&device)
    })
    .await
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
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| Ok(sync.icloud_status())).await
}

#[tauri::command]
pub async fn sync_icloud_use(
    sync: State<'_, Arc<SyncService>>,
    db: State<'_, Db>,
    recovery_key: Option<String>,
) -> Result<Snapshot, String> {
    if recovery_key
        .as_ref()
        .is_some_and(|key| key.len() > MAX_RECOVERY_KEY)
    {
        return Err("E_SYNC_RECOVERY_FORMAT".into());
    }
    let key = recovery_key.map(zeroize::Zeroizing::new);
    let notes = own_notes(&db).await?;
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.use_icloud(key.as_deref().map(String::as_str), notes)
    })
    .await
}

/// Looks for the Apple ID's vault now, as at launch: Settings' way to look again.
#[tauri::command]
pub async fn sync_icloud_look(
    sync: State<'_, Arc<SyncService>>,
    db: State<'_, Db>,
) -> Result<Snapshot, String> {
    let notes = own_notes(&db).await?;
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.icloud_look(notes)
    })
    .await
}

/// The owner's answer to joining the Apple ID's vault with notes in the library.
#[tauri::command]
pub async fn sync_icloud_join(
    sync: State<'_, Arc<SyncService>>,
    accept: bool,
) -> Result<Snapshot, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.icloud_join(accept)
    })
    .await
}

async fn own_notes(db: &Db) -> Result<u64, String> {
    db.call(|store| store.own_note_count())
        .await
        .map_err(|e| e.to_string())
}

/// Looks for the Apple ID's vault at launch and when the account changes; the outcome reaches the
/// windows in the snapshot.
#[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]
pub(crate) async fn look_for_icloud_vault(app: tauri::AppHandle) {
    use tauri::Manager as _;
    let (Some(sync), Some(db)) = (app.try_state::<Arc<SyncService>>(), app.try_state::<Db>())
    else {
        return;
    };
    // A note made after this count goes into the vault unasked, as one made after the join would.
    let looked = match own_notes(&db).await {
        Ok(notes) => {
            task::blocking_with(sync.inner(), "E_SYNC_INTERNAL", move |sync| {
                sync.icloud_look(notes)
            })
            .await
        }
        Err(code) => Err(code),
    };
    if let Err(code) = looked {
        log::info!("I_SYNC_ICLOUD_LOOK_FAILED {code}");
    }
}

#[tauri::command]
pub async fn sync_icloud_upload_again(
    sync: State<'_, Arc<SyncService>>,
) -> Result<Snapshot, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.icloud_upload_again()).await
}

/// Leave This Vault: the vault's recovery key confirms it.
#[tauri::command]
pub async fn sync_icloud_leave(
    sync: State<'_, Arc<SyncService>>,
    recovery_key: String,
) -> Result<Snapshot, String> {
    if recovery_key.len() > MAX_RECOVERY_KEY {
        return Err("E_SYNC_RECOVERY_FORMAT".into());
    }
    let key = zeroize::Zeroizing::new(recovery_key);
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.icloud_leave(&key)
    })
    .await
}

/// About what the vault holds on its transport, from the records here: Settings shows it for iCloud,
/// whose storage Devot does not read.
#[tauri::command]
pub async fn sync_icloud_storage(db: State<'_, Db>) -> Result<u64, String> {
    db.call(|store| store.sync_stored_bytes())
        .await
        .map_err(|e| e.to_string())
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
