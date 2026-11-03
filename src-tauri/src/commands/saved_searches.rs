use super::books::valid_sort_key;
use super::notes::{valid_hlc, valid_note_id};
use crate::storage::{Db, SavedSearchRecord, Write};
use tauri::State;

/// MAX_SAVED_SEARCH_NAME_CHARS and MAX_SAVED_SEARCH_QUERY_CHARS in src/core/savedSearches.ts.
const MAX_NAME_CHARS: usize = 100;
const MAX_QUERY_CHARS: usize = 1000;

fn one_line(text: &str, max: usize) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && trimmed == text
        && !text.contains(['\n', '\r'])
        && text.chars().count() <= max
}

fn validate(search: &SavedSearchRecord) -> Result<(), &'static str> {
    if !valid_note_id(&search.id) {
        return Err("E_SAVED_SEARCH_ID_INVALID");
    }
    if !one_line(&search.name, MAX_NAME_CHARS) {
        return Err("E_SAVED_SEARCH_NAME_INVALID");
    }
    if !one_line(&search.query, MAX_QUERY_CHARS) {
        return Err("E_SAVED_SEARCH_QUERY_INVALID");
    }
    if !valid_hlc(&search.name_hlc)
        || !valid_hlc(&search.query_hlc)
        || !search.deleted_hlc.as_deref().is_none_or(valid_hlc)
        || !(search.sort_key_hlc.is_empty() || valid_hlc(&search.sort_key_hlc))
    {
        return Err("E_SAVED_SEARCH_HLC_INVALID");
    }
    if !(search.sort_key.is_empty() || valid_sort_key(&search.sort_key)) {
        return Err("E_SAVED_SEARCH_SORT_KEY_INVALID");
    }
    if search.created_at < 0 || search.updated_at < search.created_at {
        return Err("E_SAVED_SEARCH_TIME_INVALID");
    }
    if search.deleted_at.is_some() != search.deleted_hlc.is_some() {
        return Err("E_SAVED_SEARCH_DELETE_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn saved_searches_list(db: State<'_, Db>) -> Result<Vec<SavedSearchRecord>, String> {
    db.call(|store| store.list_saved_searches())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn saved_search_put(db: State<'_, Db>, search: SavedSearchRecord) -> Result<(), String> {
    validate(&search).map_err(String::from)?;
    db.write(Write::Content, move |store| store.put_saved_search(&search))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-0000000000d1";
    const HLC: &str = "0001728000000000-0000-node";

    fn search() -> SavedSearchRecord {
        SavedSearchRecord {
            id: ID.into(),
            name: "Open work".into(),
            name_hlc: HLC.into(),
            query: "is:active tag:work".into(),
            query_hlc: HLC.into(),
            sort_key: "a0".into(),
            sort_key_hlc: HLC.into(),
            created_at: 1,
            updated_at: 2,
            deleted_at: None,
            deleted_hlc: None,
        }
    }

    #[test]
    fn accepts_a_valid_saved_search_placed_or_not() {
        assert_eq!(validate(&search()), Ok(()));
        let mut unplaced = search();
        unplaced.sort_key = String::new();
        unplaced.sort_key_hlc = String::new();
        assert_eq!(validate(&unplaced), Ok(()));
        let mut deleted = search();
        deleted.deleted_at = Some(3);
        deleted.deleted_hlc = Some(HLC.into());
        assert_eq!(validate(&deleted), Ok(()));
    }

    #[test]
    fn rejects_bad_saved_searches() {
        type Case = (fn(&mut SavedSearchRecord), &'static str);
        let cases: [Case; 14] = [
            (|s| s.id = "x".into(), "E_SAVED_SEARCH_ID_INVALID"),
            (|s| s.name = String::new(), "E_SAVED_SEARCH_NAME_INVALID"),
            (|s| s.name = " a".into(), "E_SAVED_SEARCH_NAME_INVALID"),
            (|s| s.name = "a\nb".into(), "E_SAVED_SEARCH_NAME_INVALID"),
            (|s| s.name = "x".repeat(101), "E_SAVED_SEARCH_NAME_INVALID"),
            (|s| s.query = "  ".into(), "E_SAVED_SEARCH_QUERY_INVALID"),
            (|s| s.query = "a\rb".into(), "E_SAVED_SEARCH_QUERY_INVALID"),
            (
                |s| s.query = "q".repeat(1001),
                "E_SAVED_SEARCH_QUERY_INVALID",
            ),
            (|s| s.name_hlc = String::new(), "E_SAVED_SEARCH_HLC_INVALID"),
            (
                |s| s.query_hlc = "\u{e9}".into(),
                "E_SAVED_SEARCH_HLC_INVALID",
            ),
            (
                |s| s.sort_key = "!!".into(),
                "E_SAVED_SEARCH_SORT_KEY_INVALID",
            ),
            (|s| s.updated_at = 0, "E_SAVED_SEARCH_TIME_INVALID"),
            (
                |s| s.deleted_hlc = Some(HLC.into()),
                "E_SAVED_SEARCH_DELETE_INVALID",
            ),
            (|s| s.deleted_at = Some(3), "E_SAVED_SEARCH_DELETE_INVALID"),
        ];
        for (mutate, code) in cases {
            let mut record = search();
            mutate(&mut record);
            assert_eq!(validate(&record), Err(code));
        }
    }

    #[test]
    fn keeps_a_query_of_the_longest_length_and_any_script() {
        let mut long = search();
        long.query = "\u{540c}".repeat(1000);
        assert_eq!(validate(&long), Ok(()));
    }
}
