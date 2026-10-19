//! Copy Image and Save Image As for attachments. The web view names an attachment by its ID only; Rust reads the bytes and, for saving, asks for the path with the system save panel. The page never names a path.

use super::notes::valid_note_id;
use crate::storage::{Db, FileRecord};
use crate::strings;
use std::path::{Path, PathBuf};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

pub fn extension_for(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/heic" => "heic",
        _ => return None,
    })
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "tif", "tiff", "bmp",
];

pub fn save_name(name: &str, extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | ':' | '\\' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.');
    // Only an image extension goes: "v1.2 notes" keeps its dot.
    let stem = match cleaned.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) =>
        {
            stem
        }
        _ => cleaned,
    };
    let stem = if stem.is_empty() { "image" } else { stem };
    format!("{stem}.{extension}")
}

/// Checks the path the save panel returned: absolute, with a file name, in
/// an existing folder, and not a folder itself. It is written as chosen: the
/// panel asked before replacing a file of that name, and adding an extension
/// here could replace another file without asking.
pub fn save_path(path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("E_IMAGE_SAVE_PATH_INVALID");
    }
    if !path.parent().is_some_and(Path::is_dir) || path.is_dir() {
        return Err("E_IMAGE_SAVE_PATH_INVALID");
    }
    Ok(path.to_owned())
}

/// Writes next to `path` first (never through a link, see `atomic_file`), then renames over it, so a failed write never leaves half an image.
pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    crate::atomic_file::write_replacing(path, bytes).map_err(|_| "E_IMAGE_SAVE_FAILED")
}

async fn attachment(db: &Db, id: String) -> Result<FileRecord, String> {
    if !valid_note_id(&id) {
        return Err("E_FILE_ID_INVALID".into());
    }
    db.call(move |store| store.get_file(&id))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "E_FILE_NOT_FOUND".into())
}

/// Most pixels Copy Image takes: the pasteboard gets the image decoded (TIFF, four bytes a pixel) and decoding takes a few copies more, so a few-MB file could ask for gigabytes. Save Image As takes any size.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAX_COPY_PIXELS: u64 = 100_000_000;

#[tauri::command]
pub async fn image_copy(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    id: String,
) -> Result<(), String> {
    let file = attachment(&db, id).await?;
    #[cfg(target_os = "macos")]
    {
        use crate::native::macos;
        // Decoding and converting run off the main thread; only the pasteboard write runs there.
        let image = tauri::async_runtime::spawn_blocking(move || {
            macos::pasteboard_image(&file.data, MAX_COPY_PIXELS)
        })
        .await
        .map_err(|_| String::from("E_IMAGE_UNREADABLE"))?
        .map_err(String::from)?;
        let (reply, answer) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = reply.send(macos::write_clipboard_image(&image));
        })
        .map_err(|_| String::from("E_NATIVE_MAIN_THREAD_UNAVAILABLE"))?;
        match answer.await {
            Ok(true) => Ok(()),
            _ => Err(String::from("E_CLIPBOARD_WRITE_FAILED")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, file);
        Err(String::from("E_CLIPBOARD_UNSUPPORTED"))
    }
}

/// True once saved; false when the user cancelled.
#[tauri::command]
pub async fn image_save(
    window: WebviewWindow,
    db: State<'_, Db>,
    id: String,
) -> Result<bool, String> {
    let file = attachment(&db, id).await?;
    let extension = extension_for(&file.mime).ok_or("E_FILE_TYPE_REFUSED")?;
    let (reply, answer) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title(strings::SAVE_IMAGE_TITLE)
        .set_file_name(save_name(&file.name, extension))
        .add_filter(strings::SAVE_IMAGE_FILTER, &[extension])
        .set_parent(&window)
        .save_file(move |path| {
            let _ = reply.send(path);
        });
    let Some(path) = answer.await.map_err(|_| "E_IMAGE_SAVE_FAILED")? else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|_| "E_IMAGE_SAVE_PATH_INVALID")?;
    let path = save_path(&path)?;
    let id = file.id;
    tauri::async_runtime::spawn_blocking(move || write_file(&path, &file.data))
        .await
        .map_err(|_| "E_IMAGE_SAVE_FAILED")??;
    log::info!("I_IMAGE_SAVED {id}");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_an_extension_for_every_stored_type() {
        for (mime, ext) in [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/gif", "gif"),
            ("image/webp", "webp"),
            ("image/avif", "avif"),
            ("image/heic", "heic"),
        ] {
            assert_eq!(extension_for(mime), Some(ext));
        }
        assert_eq!(extension_for("image/svg+xml"), None);
        assert_eq!(extension_for("text/html"), None);
    }

    #[test]
    fn suggests_the_attachment_name_with_its_type_extension() {
        assert_eq!(save_name("Screen Shot.png", "png"), "Screen Shot.png");
        assert_eq!(save_name("photo.PNG", "jpg"), "photo.jpg");
        assert_eq!(save_name("image", "png"), "image.png");
        assert_eq!(save_name("a/b:c\\d.gif", "gif"), "a-b-c-d.gif");
        assert_eq!(save_name("line\nbreak.png", "png"), "line-break.png");
        assert_eq!(save_name("..hidden", "png"), "hidden.png");
        assert_eq!(save_name("", "png"), "image.png");
        assert_eq!(save_name(".png", "png"), "png.png");
        assert_eq!(save_name("v1.2 notes", "png"), "v1.2 notes.png");
        assert_eq!(save_name("scan.JPEG", "jpg"), "scan.jpg");
        assert_eq!(save_name("   ", "webp"), "image.webp");
    }

    #[test]
    fn checks_the_chosen_path() {
        let dir = tempfile::tempdir().unwrap();
        for ok in ["a.png", "a.PNG", "a", "a.gif"] {
            let path = dir.path().join(ok);
            assert_eq!(save_path(&path), Ok(path.clone()));
        }
        for bad in [
            PathBuf::from("relative.png"),
            dir.path().join("missing").join("a.png"),
            dir.path().to_owned(),
            PathBuf::from("/"),
        ] {
            assert_eq!(save_path(&bad), Err("E_IMAGE_SAVE_PATH_INVALID"), "{bad:?}");
        }
    }

    #[test]
    fn writes_the_whole_file_or_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(&path, b"old").unwrap();
        assert_eq!(write_file(&path, b"\x89PNG new"), Ok(()));
        assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG new");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("a.png")]);
        let gone = dir.path().join("gone").join("a.png");
        assert_eq!(write_file(&gone, b"x"), Err("E_IMAGE_SAVE_FAILED"));
    }

    #[cfg(unix)]
    #[test]
    fn never_writes_through_a_link_at_a_temporary_name() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let theirs = outside.path().join("theirs.txt");
        std::fs::write(&theirs, b"theirs").unwrap();
        // The name the bytes once went to first was easy to guess: a link planted there in a shared folder took the image wherever it pointed.
        std::os::unix::fs::symlink(&theirs, dir.path().join(".a.png.devot-tmp")).unwrap();
        let path = dir.path().join("a.png");
        assert_eq!(write_file(&path, b"\x89PNG new"), Ok(()));
        assert!(std::fs::symlink_metadata(&path).unwrap().is_file());
        assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG new");
        assert_eq!(std::fs::read(&theirs).unwrap(), b"theirs");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copies_no_image_over_the_pixel_limit() {
        use crate::native::macos;
        const PNG: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00,
            0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78,
            0xda, 0x63, 0x64, 0x60, 0x00, 0x00, 0x00, 0x06, 0x00, 0x02, 0x30, 0x81, 0xd0, 0x2f,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        let copy = macos::pasteboard_image(PNG, 1).expect("one pixel is within one");
        assert_eq!(copy.png.as_deref(), Some(PNG));
        assert_eq!(
            macos::pasteboard_image(PNG, 0).err(),
            Some("E_IMAGE_TOO_LARGE")
        );
        assert_eq!(
            macos::pasteboard_image(b"not an image", MAX_COPY_PIXELS).err(),
            Some("E_IMAGE_UNREADABLE")
        );
    }

    #[test]
    fn refuses_malformed_ids_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::spawn(&dir.path().join("t.sqlite")).unwrap();
        let read = |id: &str| tauri::async_runtime::block_on(attachment(&db, id.into()));
        assert_eq!(read("../x").err().as_deref(), Some("E_FILE_ID_INVALID"));
        assert_eq!(read("").err().as_deref(), Some("E_FILE_ID_INVALID"));
        assert_eq!(
            read("0192a6f0-0000-7000-8000-00000000f001")
                .err()
                .as_deref(),
            Some("E_FILE_NOT_FOUND")
        );
    }
}
