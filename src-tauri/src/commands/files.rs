//! Attachments: storing pasted or dropped images, and serving them to the
//! web view at `devot://file/<id>`. The image format is detected from the
//! bytes; the UI's claim is never trusted. SVG is refused (it can carry
//! scripts), and so is anything that is not a known raster image.

use super::notes::valid_note_id;
use crate::storage::{Db, FileCopy, FileRecord};
use tauri::http::{Response, StatusCode, header};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 200;
const MAX_COPIES: usize = 10_000;

pub fn detect_image(bytes: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if starts(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"avif" | b"avis" => Some("image/avif"),
            b"heic" | b"heix" | b"mif1" | b"msf1" => Some("image/heic"),
            _ => None,
        };
    }
    None
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub struct Upload {
    pub id: String,
    pub note_id: String,
    pub name: String,
}

pub fn validate_upload(upload: &Upload, data: &[u8]) -> Result<&'static str, &'static str> {
    if !valid_note_id(&upload.id) {
        return Err("E_FILE_ID_INVALID");
    }
    if !valid_note_id(&upload.note_id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if upload.name.is_empty()
        || upload.name.chars().count() > MAX_NAME_CHARS
        || upload.name.chars().any(char::is_control)
    {
        return Err("E_FILE_NAME_INVALID");
    }
    if data.is_empty() || data.len() > MAX_FILE_BYTES {
        return Err("E_FILE_SIZE_INVALID");
    }
    detect_image(data).ok_or("E_FILE_TYPE_REFUSED")
}

fn header_text(request: &Request<'_>, name: &str) -> Option<String> {
    request.headers().get(name)?.to_str().ok().map(String::from)
}

/// The bytes are the raw request body; IDs and the percent-encoded name travel in headers.
#[tauri::command]
pub async fn file_put(db: State<'_, Db>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("E_FILE_BODY_INVALID".into());
    };
    let upload = Upload {
        id: header_text(&request, "x-devot-file-id").unwrap_or_default(),
        note_id: header_text(&request, "x-devot-note-id").unwrap_or_default(),
        name: header_text(&request, "x-devot-file-name")
            .and_then(|n| percent_decode(&n))
            .unwrap_or_default(),
    };
    store_upload(&db, upload, data.clone()).await
}

pub async fn store_upload(db: &Db, upload: Upload, data: Vec<u8>) -> Result<(), String> {
    let mime = validate_upload(&upload, &data).map_err(String::from)?;
    let file = FileRecord {
        id: upload.id,
        note_id: upload.note_id,
        name: upload.name,
        mime: mime.into(),
        data,
        created_at: now_ms(),
    };
    let stored = db
        .call(move |store| store.put_file(&file))
        .await
        .map_err(|e| e.to_string())?;
    if stored {
        Ok(())
    } else {
        Err("E_NOTE_NOT_FOUND".into())
    }
}

fn validate_copies(note_id: &str, copies: &[FileCopy]) -> Result<(), &'static str> {
    if !valid_note_id(note_id) {
        return Err("E_NOTE_ID_INVALID");
    }
    if copies.len() > MAX_COPIES {
        return Err("E_FILE_COPIES_TOO_MANY");
    }
    let mut targets = std::collections::HashSet::with_capacity(copies.len());
    for FileCopy { from, to } in copies {
        if !valid_note_id(from) || !valid_note_id(to) || from == to || !targets.insert(to) {
            return Err("E_FILE_ID_INVALID");
        }
    }
    Ok(())
}

/// Copies, not shared files: purging the source must keep them.
#[tauri::command]
pub async fn files_copy(
    db: State<'_, Db>,
    note_id: String,
    copies: Vec<FileCopy>,
) -> Result<(), String> {
    validate_copies(&note_id, &copies).map_err(String::from)?;
    let at = now_ms();
    let copied = db
        .call(move |store| store.copy_files(&note_id, &copies, at))
        .await
        .map_err(|e| e.to_string())?;
    if copied {
        Ok(())
    } else {
        Err("E_NOTE_NOT_FOUND".into())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn file_id_from_uri(uri: &str) -> Option<&str> {
    let id = uri.strip_prefix("devot://file/")?;
    valid_note_id(id).then_some(id)
}

pub fn file_response(file: Option<FileRecord>) -> Response<Vec<u8>> {
    let builder = Response::builder()
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'");
    let response = match file {
        Some(file) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, file.mime)
            // An attachment's bytes never change under its ID.
            .header(
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            )
            .body(file.data),
        None => builder.status(StatusCode::NOT_FOUND).body(Vec::new()),
    };
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn serve(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let Some(id) = file_id_from_uri(&request.uri().to_string()).map(String::from) else {
        responder.respond(file_response(None));
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let db = app.state::<Db>();
        let file = db
            .call(move |store| store.get_file(&id))
            .await
            .ok()
            .flatten();
        responder.respond(file_response(file));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "0192a6f0-0000-7000-8000-000000000001";
    const FILE: &str = "0192a6f0-0000-7000-8000-00000000f001";
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn upload(name: &str) -> Upload {
        Upload {
            id: FILE.into(),
            note_id: NOTE.into(),
            name: name.into(),
        }
    }

    #[test]
    fn detects_supported_images_from_their_bytes() {
        assert_eq!(detect_image(PNG), Some("image/png"));
        assert_eq!(detect_image(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(detect_image(b"GIF89a...."), Some("image/gif"));
        assert_eq!(detect_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(detect_image(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(detect_image(b"\0\0\0\x18ftypheic"), Some("image/heic"));
    }

    #[test]
    fn refuses_svg_html_and_unknown_bytes() {
        assert_eq!(
            detect_image(b"<svg xmlns='http://www.w3.org/2000/svg'>"),
            None
        );
        assert_eq!(detect_image(b"<!doctype html><script>"), None);
        assert_eq!(detect_image(b"\0\0\0\x18ftypqt  "), None);
        assert_eq!(detect_image(b""), None);
    }

    #[test]
    fn validates_uploads() {
        assert_eq!(validate_upload(&upload("photo.png"), PNG), Ok("image/png"));
        let mut bad = upload("photo.png");
        bad.id = "x".into();
        assert_eq!(validate_upload(&bad, PNG), Err("E_FILE_ID_INVALID"));
        let mut bad = upload("photo.png");
        bad.note_id = "../x".into();
        assert_eq!(validate_upload(&bad, PNG), Err("E_NOTE_ID_INVALID"));
        assert_eq!(
            validate_upload(&upload(""), PNG),
            Err("E_FILE_NAME_INVALID")
        );
        assert_eq!(
            validate_upload(&upload("a\nb"), PNG),
            Err("E_FILE_NAME_INVALID")
        );
        assert_eq!(
            validate_upload(&upload("a.png"), b""),
            Err("E_FILE_SIZE_INVALID")
        );
        let huge = [PNG, &vec![0; MAX_FILE_BYTES]].concat();
        assert_eq!(
            validate_upload(&upload("a.png"), &huge),
            Err("E_FILE_SIZE_INVALID")
        );
        assert_eq!(
            validate_upload(&upload("a.svg"), b"<svg/>"),
            Err("E_FILE_TYPE_REFUSED")
        );
    }

    #[test]
    fn validates_copies() {
        const COPY: &str = "0192a6f0-0000-7000-8000-00000000f002";
        let copy = |from: &str, to: &str| FileCopy {
            from: from.into(),
            to: to.into(),
        };
        assert_eq!(validate_copies(NOTE, &[copy(FILE, COPY)]), Ok(()));
        assert_eq!(validate_copies(NOTE, &[]), Ok(()));
        assert_eq!(
            validate_copies("../x", &[copy(FILE, COPY)]),
            Err("E_NOTE_ID_INVALID")
        );
        for bad in [
            vec![copy("x", COPY)],
            vec![copy(FILE, "../x")],
            vec![copy(FILE, FILE)],
            vec![copy(FILE, COPY), copy(NOTE, COPY)],
        ] {
            assert_eq!(validate_copies(NOTE, &bad), Err("E_FILE_ID_INVALID"));
        }
        assert_eq!(
            validate_copies(NOTE, &vec![copy(FILE, COPY); MAX_COPIES + 1]),
            Err("E_FILE_COPIES_TOO_MANY")
        );
    }

    #[test]
    fn decodes_percent_encoded_names() {
        assert_eq!(percent_decode("a%20b.png").as_deref(), Some("a b.png"));
        assert_eq!(
            percent_decode("%E5%90%8C.png").as_deref(),
            Some("\u{540c}.png")
        );
        assert_eq!(percent_decode("bad%zz"), None);
        assert_eq!(percent_decode("%ff"), None);
    }

    #[test]
    fn parses_only_well_formed_file_urls() {
        assert_eq!(
            file_id_from_uri(&format!("devot://file/{FILE}")),
            Some(FILE)
        );
        assert_eq!(file_id_from_uri("devot://file/../../etc/passwd"), None);
        assert_eq!(file_id_from_uri("devot://note/x"), None);
        assert_eq!(file_id_from_uri("https://file/x"), None);
    }

    #[test]
    fn serves_with_type_and_guards_and_404s_unknown_ids() {
        let file = FileRecord {
            id: FILE.into(),
            note_id: NOTE.into(),
            name: "a.png".into(),
            mime: "image/png".into(),
            data: PNG.to_vec(),
            created_at: 1,
        };
        let ok = file_response(Some(file));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(ok.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(ok.body(), PNG);
        let missing = file_response(None);
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert!(missing.body().is_empty());
    }
}
