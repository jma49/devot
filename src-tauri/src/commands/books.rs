use super::notes::{valid_hlc, valid_note_id};
use crate::storage::{BookRecord, Db, TAG_COLORS, Write, notebook_symbol};
use tauri::State;

const MAX_NAME_CHARS: usize = 200;

/// Matches `MAX_SORT_KEY_LENGTH` in src/core/order.ts.
const MAX_SORT_KEY_LEN: usize = 1024;
const KEY_DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Mirrors `isSortKey` in src/core/order.ts.
fn valid_sort_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    let integer_len = match bytes.first() {
        Some(head @ b'a'..=b'z') => usize::from(head - b'a') + 2,
        Some(head @ b'A'..=b'Z') => usize::from(b'Z' - head) + 2,
        _ => return false,
    };
    bytes.len() <= MAX_SORT_KEY_LEN
        && bytes.len() >= integer_len
        && bytes[1..].iter().all(|b| KEY_DIGITS.as_bytes().contains(b))
        && (bytes.len() == integer_len || bytes.last() != Some(&b'0'))
        && !(bytes.len() == integer_len
            && bytes[0] == b'A'
            && bytes[1..].iter().all(|b| *b == b'0'))
}

fn validate(book: &BookRecord) -> Result<(), &'static str> {
    if !valid_note_id(&book.id) {
        return Err("E_BOOK_ID_INVALID");
    }
    let name = book.name.trim();
    if name.is_empty() || name != book.name || book.name.contains('\n') {
        return Err("E_BOOK_NAME_INVALID");
    }
    if book.name.chars().count() > MAX_NAME_CHARS {
        return Err("E_BOOK_NAME_INVALID");
    }
    if let Some(parent) = &book.parent_id
        && (!valid_note_id(parent) || parent == &book.id)
    {
        return Err("E_BOOK_PARENT_INVALID");
    }
    if !valid_hlc(&book.name_hlc)
        || !valid_hlc(&book.parent_hlc)
        || !book.deleted_hlc.as_deref().is_none_or(valid_hlc)
        || !(book.ai_access_hlc.is_empty() || valid_hlc(&book.ai_access_hlc))
        || (book.ai_access && book.ai_access_hlc.is_empty())
        || !(book.sort_key_hlc.is_empty() || valid_hlc(&book.sort_key_hlc))
        || !(book.icon_hlc.is_empty() || valid_hlc(&book.icon_hlc))
        || ((book.icon.is_some() || book.icon_color.is_some()) && book.icon_hlc.is_empty())
    {
        return Err("E_BOOK_HLC_INVALID");
    }
    // Only catalog symbols (none depicts an Apple product) and palette IDs.
    if !book.icon.as_deref().is_none_or(notebook_symbol)
        || !book
            .icon_color
            .as_deref()
            .is_none_or(|c| TAG_COLORS.contains(&c))
    {
        return Err("E_BOOK_ICON_INVALID");
    }
    // Empty: a notebook from before sort keys that was never placed.
    if !(book.sort_key.is_empty() || valid_sort_key(&book.sort_key)) {
        return Err("E_BOOK_SORT_KEY_INVALID");
    }
    if book.created_at < 0 || book.updated_at < book.created_at {
        return Err("E_BOOK_TIME_INVALID");
    }
    if book.deleted_at.is_some() != book.deleted_hlc.is_some() {
        return Err("E_BOOK_DELETE_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn books_list(db: State<'_, Db>) -> Result<Vec<BookRecord>, String> {
    db.call(|store| store.list_books())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn book_put(db: State<'_, Db>, book: BookRecord) -> Result<(), String> {
    validate(&book).map_err(String::from)?;
    db.write(Write::Content, move |store| store.put_book(&book))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-0000000000b1";
    const HLC: &str = "0001728000000000-0000-node";

    fn book() -> BookRecord {
        BookRecord {
            id: ID.into(),
            name: "Work".into(),
            name_hlc: HLC.into(),
            parent_id: Some("0192a6f0-0000-7000-8000-0000000000b0".into()),
            parent_hlc: HLC.into(),
            created_at: 1,
            updated_at: 2,
            deleted_at: None,
            deleted_hlc: None,
            ai_access: false,
            ai_access_hlc: String::new(),
            sort_key: "a0V".into(),
            sort_key_hlc: HLC.into(),
            icon: None,
            icon_color: None,
            icon_hlc: String::new(),
        }
    }

    #[test]
    fn accepts_a_valid_notebook() {
        assert_eq!(validate(&book()), Ok(()));
        let mut top = book();
        top.parent_id = None;
        assert_eq!(validate(&top), Ok(()));
        let mut allowed = book();
        allowed.ai_access = true;
        allowed.ai_access_hlc = HLC.into();
        assert_eq!(validate(&allowed), Ok(()));
        for key in ["", "a0", "Zz", "b00", "a0V", "zzzzzzzzzzzzzzzzzzzzzzzzzzz"] {
            let mut placed = book();
            placed.sort_key = key.into();
            assert_eq!(validate(&placed), Ok(()), "{key:?}");
        }
        let mut longest = book();
        longest.sort_key = format!("a0{}", "V".repeat(1022));
        assert_eq!(validate(&longest), Ok(()));
        let mut iconed = book();
        iconed.icon = Some("leaf".into());
        iconed.icon_color = Some("green".into());
        iconed.icon_hlc = HLC.into();
        assert_eq!(validate(&iconed), Ok(()));
        iconed.icon = None;
        iconed.icon_color = None;
        assert_eq!(validate(&iconed), Ok(()));
    }

    #[test]
    fn accepts_every_catalog_symbol() {
        let catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../../design/icons/notebook-symbols.json"))
                .unwrap();
        let names = catalog["symbols"].as_object().unwrap();
        assert!(names.len() > 100);
        for name in names.keys() {
            let mut iconed = book();
            iconed.icon = Some(name.clone());
            iconed.icon_hlc = HLC.into();
            assert_eq!(validate(&iconed), Ok(()), "{name}");
        }
        for color in TAG_COLORS {
            let mut tinted = book();
            tinted.icon_color = Some(color.into());
            tinted.icon_hlc = HLC.into();
            assert_eq!(validate(&tinted), Ok(()), "{color}");
        }
    }

    #[test]
    fn trims_names_as_the_core_does() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../tests/support/names.json")).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let mut raw = book();
            raw.name = name.into();
            match case["clean"].as_str() {
                Some(clean) => {
                    let mut cleaned = book();
                    cleaned.name = clean.into();
                    assert_eq!(validate(&cleaned), Ok(()), "{case}");
                    if clean != name {
                        assert_eq!(validate(&raw), Err("E_BOOK_NAME_INVALID"), "{case}");
                    }
                }
                None => assert_eq!(validate(&raw), Err("E_BOOK_NAME_INVALID"), "{case}"),
            }
        }
    }

    #[test]
    fn rejects_bad_fields() {
        type Case = (fn(&mut BookRecord), &'static str);
        let cases: [Case; 24] = [
            (|b| b.id = "nope".into(), "E_BOOK_ID_INVALID"),
            (|b| b.name = String::new(), "E_BOOK_NAME_INVALID"),
            (|b| b.name = " padded ".into(), "E_BOOK_NAME_INVALID"),
            (|b| b.name = "a\nb".into(), "E_BOOK_NAME_INVALID"),
            (|b| b.name = "x".repeat(201), "E_BOOK_NAME_INVALID"),
            (|b| b.parent_id = Some(ID.into()), "E_BOOK_PARENT_INVALID"),
            (
                |b| b.parent_id = Some("../x".into()),
                "E_BOOK_PARENT_INVALID",
            ),
            (|b| b.name_hlc = String::new(), "E_BOOK_HLC_INVALID"),
            (|b| b.updated_at = 0, "E_BOOK_TIME_INVALID"),
            (|b| b.deleted_at = Some(3), "E_BOOK_DELETE_INVALID"),
            (|b| b.ai_access_hlc = "x".repeat(65), "E_BOOK_HLC_INVALID"),
            (|b| b.ai_access = true, "E_BOOK_HLC_INVALID"),
            (|b| b.sort_key_hlc = "x".repeat(65), "E_BOOK_HLC_INVALID"),
            (|b| b.icon_hlc = "x".repeat(65), "E_BOOK_HLC_INVALID"),
            (|b| b.icon = Some("leaf".into()), "E_BOOK_HLC_INVALID"),
            (|b| b.icon_color = Some("red".into()), "E_BOOK_HLC_INVALID"),
            (
                |b| {
                    b.icon = Some("iphone".into());
                    b.icon_hlc = HLC.into();
                },
                "E_BOOK_ICON_INVALID",
            ),
            (
                |b| {
                    b.icon = Some("leaf".into());
                    b.icon_color = Some("#ff0000".into());
                    b.icon_hlc = HLC.into();
                },
                "E_BOOK_ICON_INVALID",
            ),
            (
                |b| {
                    b.icon = Some(String::new());
                    b.icon_hlc = HLC.into();
                },
                "E_BOOK_ICON_INVALID",
            ),
            (|b| b.sort_key = "a".into(), "E_BOOK_SORT_KEY_INVALID"),
            (|b| b.sort_key = "a00".into(), "E_BOOK_SORT_KEY_INVALID"),
            (|b| b.sort_key = "a0 ".into(), "E_BOOK_SORT_KEY_INVALID"),
            (
                |b| b.sort_key = format!("A{}", "0".repeat(26)),
                "E_BOOK_SORT_KEY_INVALID",
            ),
            (
                |b| b.sort_key = format!("a0{}", "V".repeat(1023)),
                "E_BOOK_SORT_KEY_INVALID",
            ),
        ];
        for (mutate, code) in cases {
            let mut record = book();
            mutate(&mut record);
            assert_eq!(validate(&record), Err(code));
        }
    }
}
