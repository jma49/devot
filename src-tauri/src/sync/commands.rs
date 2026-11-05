use std::sync::Arc;

use tauri::State;

use crate::task;

use super::client::{DeviceInfo, RelayUsage, Welcome};
use super::service::{
    Created, PairingCheck, PairingView, PullDto, PushDto, SettingsPatch, Snapshot, StatusView,
    SyncService,
};

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

/// A pairing code as typed or pasted, or the link its QR code holds.
#[tauri::command]
pub async fn sync_join_code(
    sync: State<'_, Arc<SyncService>>,
    code: String,
) -> Result<Snapshot, String> {
    let code = zeroize::Zeroizing::new(code);
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.join_with_code(&code)
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
pub async fn sync_connect(sync: State<'_, Arc<SyncService>>) -> Result<Welcome, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", |sync| sync.connect()).await
}

#[tauri::command]
pub async fn sync_pull(sync: State<'_, Arc<SyncService>>, since: u64) -> Result<PullDto, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| sync.pull(since)).await
}

#[tauri::command]
pub async fn sync_push(
    sync: State<'_, Arc<SyncService>>,
    id: String,
    base: u64,
    data: String,
    kind: Option<String>,
) -> Result<PushDto, String> {
    task::blocking_with(&sync, "E_SYNC_INTERNAL", move |sync| {
        sync.push(&id, base, &data, kind.as_deref().unwrap_or("record"))
    })
    .await
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
