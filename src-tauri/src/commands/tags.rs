use super::notes::{valid_hlc, valid_note_id};
use crate::storage::{Db, NoteTagRecord, TAG_COLORS, TagRecord, Write};
use tauri::State;

const MAX_NAME_CHARS: usize = 100;

fn validate_tag(tag: &TagRecord) -> Result<(), &'static str> {
    if !valid_note_id(&tag.id) {
        return Err("E_TAG_ID_INVALID");
    }
    let name = tag.name.trim();
    if name.is_empty()
        || name != tag.name
        || tag.name.contains(['\n', '\r'])
        || tag.name.chars().count() > MAX_NAME_CHARS
    {
        return Err("E_TAG_NAME_INVALID");
    }
    if !valid_hlc(&tag.name_hlc)
        || !tag.deleted_hlc.as_deref().is_none_or(valid_hlc)
        || !(tag.color_hlc.is_empty() || valid_hlc(&tag.color_hlc))
    {
        return Err("E_TAG_HLC_INVALID");
    }
    if let Some(color) = &tag.color
        && (!TAG_COLORS.contains(&color.as_str()) || tag.color_hlc.is_empty())
    {
        return Err("E_TAG_COLOR_INVALID");
    }
    if tag.created_at < 0 || tag.updated_at < tag.created_at {
        return Err("E_TAG_TIME_INVALID");
    }
    if tag.deleted_at.is_some() != tag.deleted_hlc.is_some() {
        return Err("E_TAG_DELETE_INVALID");
    }
    Ok(())
}

fn validate_link_ids(note_id: &str, tag_id: &str) -> Result<(), &'static str> {
    if !valid_note_id(note_id) || !valid_note_id(tag_id) {
        return Err("E_NOTE_TAG_ID_INVALID");
    }
    Ok(())
}

fn validate_link(link: &NoteTagRecord) -> Result<(), &'static str> {
    validate_link_ids(&link.note_id, &link.tag_id)?;
    if !valid_hlc(&link.hlc) {
        return Err("E_NOTE_TAG_HLC_INVALID");
    }
    Ok(())
}

#[tauri::command]
pub async fn tags_list(db: State<'_, Db>) -> Result<Vec<TagRecord>, String> {
    db.call(|store| store.list_tags())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tag_put(db: State<'_, Db>, tag: TagRecord) -> Result<(), String> {
    validate_tag(&tag).map_err(String::from)?;
    db.write(Write::Content, move |store| store.put_tag(&tag))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn note_tag_put(db: State<'_, Db>, link: NoteTagRecord) -> Result<(), String> {
    validate_link(&link).map_err(String::from)?;
    db.write(Write::Content, move |store| store.put_note_tag(&link))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn note_tag_get(
    db: State<'_, Db>,
    note_id: String,
    tag_id: String,
) -> Result<Option<NoteTagRecord>, String> {
    validate_link_ids(&note_id, &tag_id).map_err(String::from)?;
    db.call(move |store| store.get_note_tag(&note_id, &tag_id))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0192a6f0-0000-7000-8000-0000000000c1";
    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";
    const HLC: &str = "0001728000000000-0000-node";

    fn tag() -> TagRecord {
        TagRecord {
            id: ID.into(),
            name: "sync".into(),
            name_hlc: HLC.into(),
            created_at: 1,
            updated_at: 2,
            deleted_at: None,
            deleted_hlc: None,
            color: None,
            color_hlc: String::new(),
        }
    }

    #[test]
    fn accepts_valid_tags_and_links() {
        assert_eq!(validate_tag(&tag()), Ok(()));
        let link = NoteTagRecord {
            note_id: NOTE.into(),
            tag_id: ID.into(),
            present: true,
            hlc: HLC.into(),
        };
        assert_eq!(validate_link(&link), Ok(()));
    }

    #[test]
    fn validates_the_ids_of_a_membership_read() {
        assert_eq!(validate_link_ids(NOTE, ID), Ok(()));
        assert_eq!(validate_link_ids("x", ID), Err("E_NOTE_TAG_ID_INVALID"));
        assert_eq!(
            validate_link_ids(NOTE, "../t"),
            Err("E_NOTE_TAG_ID_INVALID")
        );
    }

    #[test]
    fn rejects_bad_tags() {
        type Case = (fn(&mut TagRecord), &'static str);
        let cases: [Case; 11] = [
            (|t| t.id = "x".into(), "E_TAG_ID_INVALID"),
            (|t| t.name = String::new(), "E_TAG_NAME_INVALID"),
            (|t| t.name = " a".into(), "E_TAG_NAME_INVALID"),
            (|t| t.name = "x".repeat(101), "E_TAG_NAME_INVALID"),
            (|t| t.name_hlc = String::new(), "E_TAG_HLC_INVALID"),
            (|t| t.updated_at = 0, "E_TAG_TIME_INVALID"),
            (|t| t.deleted_hlc = Some(HLC.into()), "E_TAG_DELETE_INVALID"),
            (|t| t.color = Some("magenta".into()), "E_TAG_COLOR_INVALID"),
            (|t| t.color = Some("Red".into()), "E_TAG_COLOR_INVALID"),
            (|t| t.color = Some("red".into()), "E_TAG_COLOR_INVALID"),
            (|t| t.color_hlc = "\u{e9}".into(), "E_TAG_HLC_INVALID"),
        ];
        for (mutate, code) in cases {
            let mut record = tag();
            mutate(&mut record);
            assert_eq!(validate_tag(&record), Err(code));
        }
    }

    /// tests/support/names.json: a name the core would change or refuse is refused here too, so both sides trim by one whitespace rule.
    #[test]
    fn trims_names_as_the_core_does() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../tests/support/names.json")).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let mut raw = tag();
            raw.name = name.into();
            match case["clean"].as_str() {
                Some(clean) => {
                    let mut cleaned = tag();
                    cleaned.name = clean.into();
                    assert_eq!(validate_tag(&cleaned), Ok(()), "{case}");
                    if clean != name {
                        assert_eq!(validate_tag(&raw), Err("E_TAG_NAME_INVALID"), "{case}");
                    }
                }
                None => assert_eq!(validate_tag(&raw), Err("E_TAG_NAME_INVALID"), "{case}"),
            }
        }
        // U+0085 is whitespace and U+FEFF is not.
        let mut next_line = tag();
        next_line.name = "sync\u{85}".into();
        assert_eq!(validate_tag(&next_line), Err("E_TAG_NAME_INVALID"));
        let mut no_break = tag();
        no_break.name = "sync\u{feff}".into();
        assert_eq!(validate_tag(&no_break), Ok(()));
    }

    #[test]
    fn accepts_every_palette_colour_and_none() {
        for color in crate::storage::TAG_COLORS {
            let mut record = tag();
            record.color = Some(color.into());
            record.color_hlc = HLC.into();
            assert_eq!(validate_tag(&record), Ok(()), "{color}");
        }
        let mut cleared = tag();
        cleared.color_hlc = HLC.into();
        assert_eq!(validate_tag(&cleared), Ok(()));
    }

    #[test]
    fn rejects_bad_links() {
        let mut link = NoteTagRecord {
            note_id: "../x".into(),
            tag_id: ID.into(),
            present: true,
            hlc: HLC.into(),
        };
        assert_eq!(validate_link(&link), Err("E_NOTE_TAG_ID_INVALID"));
        link.note_id = NOTE.into();
        link.hlc = String::new();
        assert_eq!(validate_link(&link), Err("E_NOTE_TAG_HLC_INVALID"));
    }
}
