use std::sync::Arc;

use tauri::State;

use super::client::{DeviceInfo, Welcome};
use super::service::{
    Created, PairingCheck, PairingView, PullDto, PushDto, SettingsPatch, Snapshot, StatusView,
    SyncService,
};

async fn blocking<T: Send + 'static>(
    sync: &Arc<SyncService>,
    work: impl FnOnce(&SyncService) -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    let sync = Arc::clone(sync);
    tauri::async_runtime::spawn_blocking(move || work(&sync))
        .await
        .map_err(|_| "E_SYNC_INTERNAL".to_string())?
        .map_err(String::from)
}

#[tauri::command]
pub async fn sync_get(sync: State<'_, Arc<SyncService>>) -> Result<Snapshot, String> {
    blocking(&sync, |sync| Ok(sync.snapshot())).await
}

#[tauri::command]
pub async fn sync_set(
    sync: State<'_, Arc<SyncService>>,
    patch: SettingsPatch,
) -> Result<Snapshot, String> {
    blocking(&sync, move |sync| sync.set(patch)).await
}

/// The relay secret is used for the one request that creates the vault, never stored. The answer
/// carries the recovery key when this call made the vault, to show once.
#[tauri::command]
pub async fn sync_vault_create(
    sync: State<'_, Arc<SyncService>>,
    relay_secret: String,
) -> Result<Created, String> {
    let secret = zeroize::Zeroizing::new(relay_secret);
    blocking(&sync, move |sync| sync.create_vault(&secret)).await
}

/// The recovery key until this device says it was saved; then `null`.
#[tauri::command]
pub async fn sync_recovery_key(
    sync: State<'_, Arc<SyncService>>,
) -> Result<Option<String>, String> {
    blocking(&sync, |sync| {
        Ok(sync.recovery_key()?.map(|key| key.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn sync_recovery_saved(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    blocking(&sync, |sync| sync.recovery_saved()).await
}

#[tauri::command]
pub async fn sync_pairing_open(sync: State<'_, Arc<SyncService>>) -> Result<PairingView, String> {
    blocking(&sync, |sync| sync.pairing_open()).await
}

#[tauri::command]
pub async fn sync_pairing_check(sync: State<'_, Arc<SyncService>>) -> Result<PairingCheck, String> {
    blocking(&sync, |sync| sync.pairing_check()).await
}

#[tauri::command]
pub async fn sync_pairing_cancel(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    blocking(&sync, |sync| {
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
    blocking(&sync, move |sync| sync.join_with_code(&code)).await
}

#[tauri::command]
pub async fn sync_join_recovery(
    sync: State<'_, Arc<SyncService>>,
    recovery_key: String,
) -> Result<Snapshot, String> {
    let key = zeroize::Zeroizing::new(recovery_key);
    blocking(&sync, move |sync| sync.join_with_recovery(&key)).await
}

#[tauri::command]
pub async fn sync_devices(sync: State<'_, Arc<SyncService>>) -> Result<Vec<DeviceInfo>, String> {
    blocking(&sync, |sync| sync.devices()).await
}

#[tauri::command]
pub async fn sync_device_remove(
    sync: State<'_, Arc<SyncService>>,
    device: String,
) -> Result<Vec<DeviceInfo>, String> {
    blocking(&sync, move |sync| sync.remove_device(&device)).await
}

#[tauri::command]
pub async fn sync_connect(sync: State<'_, Arc<SyncService>>) -> Result<Welcome, String> {
    blocking(&sync, |sync| sync.connect()).await
}

#[tauri::command]
pub async fn sync_pull(sync: State<'_, Arc<SyncService>>, since: u64) -> Result<PullDto, String> {
    blocking(&sync, move |sync| sync.pull(since)).await
}

#[tauri::command]
pub async fn sync_push(
    sync: State<'_, Arc<SyncService>>,
    id: String,
    base: u64,
    data: String,
) -> Result<PushDto, String> {
    blocking(&sync, move |sync| sync.push(&id, base, &data)).await
}

#[tauri::command]
pub async fn sync_disconnect(sync: State<'_, Arc<SyncService>>) -> Result<(), String> {
    blocking(&sync, |sync| {
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
    blocking(&sync, move |sync| sync.report(status)).await
}
