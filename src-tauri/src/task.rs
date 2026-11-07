use std::sync::Arc;

/// Runs `work` on a blocking thread; `failed` is the error when the task itself cannot finish.
pub async fn blocking<T: Send + 'static>(
    failed: &'static str,
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    coded(failed, work).await.map_err(String::from)
}

/// [`blocking`] for a command whose work needs a service held in Tauri's state.
pub async fn blocking_with<S: Send + Sync + 'static, T: Send + 'static>(
    state: &Arc<S>,
    failed: &'static str,
    work: impl FnOnce(&S) -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    coded_with(state, failed, work).await.map_err(String::from)
}

/// [`blocking`] that keeps the code, for a body that a command and the iPhone's screens share.
pub async fn coded<T: Send + 'static>(
    failed: &'static str,
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, &'static str> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| failed)?
}

/// [`blocking_with`] that keeps the code.
pub async fn coded_with<S: Send + Sync + 'static, T: Send + 'static>(
    state: &Arc<S>,
    failed: &'static str,
    work: impl FnOnce(&S) -> Result<T, &'static str> + Send + 'static,
) -> Result<T, &'static str> {
    let state = Arc::clone(state);
    coded(failed, move || work(&state)).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{blocking, blocking_with};

    #[test]
    fn hands_back_what_the_work_returns() {
        let done = tauri::async_runtime::block_on(blocking("E_TEST_TASK", || Ok(7)));
        assert_eq!(done, Ok(7));
    }

    #[test]
    fn hands_back_the_work_s_own_code() {
        let done: Result<(), String> =
            tauri::async_runtime::block_on(blocking("E_TEST_TASK", || Err("E_WORK")));
        assert_eq!(done, Err("E_WORK".to_string()));
    }

    #[test]
    fn names_a_task_that_could_not_finish_by_its_code() {
        let done: Result<(), String> =
            tauri::async_runtime::block_on(blocking("E_TEST_TASK", || panic!("lost")));
        assert_eq!(done, Err("E_TEST_TASK".to_string()));
    }

    #[test]
    fn hands_the_service_to_the_work() {
        let service = Arc::new(String::from("kept"));
        let done =
            tauri::async_runtime::block_on(blocking_with(&service, "E_TEST_TASK", |s| Ok(s.len())));
        assert_eq!(done, Ok(4));
        assert_eq!(Arc::strong_count(&service), 1);
    }
}
