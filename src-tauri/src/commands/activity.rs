//! The activity heatmap's command; the core counts per local day (src/core/activity.ts).

use crate::storage::{ActivityData, Db};
use tauri::State;

fn validate_since(since: i64) -> Result<(), &'static str> {
    if since < 0 {
        return Err("E_ACTIVITY_TIME_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn activity_list(db: State<'_, Db>, since: i64) -> Result<ActivityData, String> {
    validate_since(since).map_err(String::from)?;
    db.call(move |store| store.list_activity(since))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_the_start_time() {
        assert_eq!(validate_since(0), Ok(()));
        assert_eq!(validate_since(1_791_115_200_000), Ok(()));
        assert_eq!(validate_since(-1), Err("E_ACTIVITY_TIME_INVALID"));
        assert_eq!(validate_since(i64::MIN), Err("E_ACTIVITY_TIME_INVALID"));
    }
}
