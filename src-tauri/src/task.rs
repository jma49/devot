/// Runs `work` on a blocking thread; `failed` is the error when the task itself cannot finish.
pub async fn blocking<T: Send + 'static>(
    failed: &'static str,
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| failed.to_string())?
        .map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::blocking;

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
}
