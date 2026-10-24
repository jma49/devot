use std::sync::Arc;

use tauri::State;

use super::client::Welcome;
use super::service::{PullDto, PushDto, SettingsPatch, Snapshot, StatusView, SyncService};

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

/// The relay secret is used for the one request that creates the vault, never stored.
#[tauri::command]
pub async fn sync_vault_create(
    sync: State<'_, Arc<SyncService>>,
    relay_secret: String,
) -> Result<Snapshot, String> {
    let secret = zeroize::Zeroizing::new(relay_secret);
    blocking(&sync, move |sync| sync.create_vault(&secret)).await
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
