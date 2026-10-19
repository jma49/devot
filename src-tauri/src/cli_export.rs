//! `devot export` (docs/architecture.md, Command line). The exporter's page
//! needs a web view, so this process runs a Tauri app whose one window is
//! never shown; it opens no data folder, database or socket, so it can run
//! beside an open Devot.

use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::atomic_file::{Folder, Place};
use crate::cli::{self, Export, Format, Input, fill};
use crate::{export, import, strings};

pub const LABEL: &str = "cli-export";
const PAGE: &str = "export.html";
const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CODE_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub markdown: String,
    /// None for standard input.
    pub title: Option<String>,
    pub simple: bool,
    pub print: bool,
}

struct Job {
    source: Source,
    format: Format,
    /// Taken once, so the page can finish only once.
    target: Mutex<Option<(Folder, String)>>,
}

/// As import reads a file: no byte order mark, `\n` line breaks.
fn markdown_text(bytes: Vec<u8>) -> Result<String, &'static str> {
    let text = String::from_utf8(bytes).map_err(|_| strings::CLI_INPUT_NOT_TEXT)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

fn read_capped(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(import::MAX_NOTE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| String::from("E_READ"))?;
    if bytes.len() as u64 > import::MAX_NOTE_BYTES {
        return Err(strings::CLI_INPUT_TOO_LARGE.into());
    }
    Ok(bytes)
}

fn read_source(export: &Export) -> Result<Source, String> {
    let (bytes, title) = match &export.input {
        Input::Stdin => (read_capped(std::io::stdin().lock()), None),
        Input::File(path) => {
            let shown = path.display().to_string();
            if !path.is_file() {
                return Err(fill(strings::CLI_NO_SUCH_FILE, "path", &shown));
            }
            let file = std::fs::File::open(path)
                .map_err(|_| fill(strings::CLI_READ_FAILED, "path", &shown))?;
            let title = path
                .file_stem()
                .map(|stem| export::job_title(&stem.to_string_lossy()));
            (read_capped(file), title)
        }
    };
    let bytes = bytes.map_err(|problem| match &export.input {
        Input::File(path) if problem == "E_READ" => fill(
            strings::CLI_READ_FAILED,
            "path",
            &path.display().to_string(),
        ),
        Input::Stdin if problem == "E_READ" => fill(strings::CLI_READ_FAILED, "path", "-"),
        _ => problem,
    })?;
    Ok(Source {
        markdown: markdown_text(bytes).map_err(String::from)?,
        title,
        simple: export.simple,
        print: export.format == Format::Pdf,
    })
}

pub(crate) fn run(request: Export) -> i32 {
    let source = match read_source(&request) {
        Ok(source) => source,
        Err(message) => return cli::failed(&message),
    };
    let target = match export::chosen_file(&request.output, request.format.extension()) {
        Ok(target) => target,
        Err(code) => {
            let path = request.output.display().to_string();
            return cli::failed(&fill(
                &fill(strings::CLI_OUTPUT_INVALID, "path", &path),
                "code",
                code,
            ));
        }
    };
    let job = Job {
        source,
        format: request.format,
        target: Mutex::new(Some(target)),
    };
    let built = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            cli_export_source,
            cli_export_finish,
            cli_export_fail,
        ])
        .manage(job)
        .setup(|app| {
            // No Dock icon or menu bar.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
                .visible(false)
                .focused(false)
                .incognito(true)
                .build()?;
            let watchdog = std::thread::Builder::new()
                .name("devot-export-timeout".into())
                .spawn(|| {
                    std::thread::sleep(TIMEOUT);
                    std::process::exit(cli::failed(&fill(
                        strings::CLI_EXPORT_FAILED,
                        "code",
                        "E_CLI_EXPORT_TIMEOUT",
                    )));
                });
            if watchdog.is_err() {
                log::warn!("W_CLI_EXPORT_NO_TIMEOUT");
            }
            Ok(())
        })
        .build(crate::data_folder::context());
    match built {
        Ok(app) => app.run_return(|_, _| {}),
        Err(_) => cli::failed(&fill(
            strings::CLI_EXPORT_FAILED,
            "code",
            "E_CLI_EXPORT_START_FAILED",
        )),
    }
}

fn end(app: &AppHandle, result: Result<(), String>) {
    let status = match result {
        Ok(()) => 0,
        Err(code) => cli::failed(&fill(strings::CLI_EXPORT_FAILED, "code", &code)),
    };
    app.exit(status);
}

/// The page may print an error code and nothing else.
fn valid_code(code: &str) -> bool {
    code.len() <= MAX_CODE_LEN
        && code.starts_with("E_")
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

#[cfg(target_os = "macos")]
async fn print_pdf(
    app: &AppHandle,
    page: String,
    title: String,
    folder: &Folder,
    name: &str,
) -> Result<(), String> {
    let caches = app
        .path()
        .app_cache_dir()
        .map_err(|_| String::from("E_EXPORT_PDF_FOLDER_FAILED"))?;
    let partial = export::PdfPartial::new_in(&caches.join(export::PDF_DIR))?;
    let target = crate::native::macos::PrintTarget::Pdf(partial.file());
    match export::print_page(app, LABEL, page, title, target).await {
        Ok(true) => partial.persist(folder, name).map_err(String::from),
        Ok(false) => Err("E_EXPORT_PDF_FAILED".into()),
        Err(code) => Err(code),
    }
}

#[cfg(not(target_os = "macos"))]
async fn print_pdf(
    _app: &AppHandle,
    _page: String,
    _title: String,
    _folder: &Folder,
    _name: &str,
) -> Result<(), String> {
    Err("E_PRINT_UNSUPPORTED".into())
}

#[tauri::command]
fn cli_export_source(job: State<'_, Job>) -> Source {
    job.source.clone()
}

#[tauri::command]
async fn cli_export_finish(
    app: AppHandle,
    job: State<'_, Job>,
    html: String,
) -> Result<(), String> {
    let target = job.target.lock().ok().and_then(|mut target| target.take());
    let Some((folder, name)) = target else {
        return Err("E_CLI_EXPORT_DONE".into());
    };
    let result = if html.len() > export::MAX_TEXT_BYTES {
        Err(String::from("E_EXPORT_TOO_LARGE"))
    } else {
        match job.format {
            Format::Html => export::write_file(&folder, &name, html.as_bytes(), Place::Replace)
                .map_err(String::from),
            Format::Pdf => {
                let title = job.source.title.clone().unwrap_or_else(|| "Devot".into());
                print_pdf(&app, html, title, &folder, &name).await
            }
        }
    };
    end(&app, result);
    Ok(())
}

#[tauri::command]
fn cli_export_fail(app: AppHandle, job: State<'_, Job>, code: String) {
    let target = job.target.lock().ok().and_then(|mut target| target.take());
    if target.is_none() {
        return;
    }
    let code = if valid_code(&code) {
        code
    } else {
        "E_CLI_EXPORT_FAILED".into()
    };
    end(&app, Err(code));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn writes_to(path: &Path, format: Format) -> bool {
        export::chosen_file(path, format.extension()).is_ok()
    }

    #[test]
    fn reads_markdown_as_import_does() {
        assert_eq!(
            markdown_text(b"\xef\xbb\xbf# A\r\nb\rc\n".to_vec()),
            Ok("# A\nb\nc\n".into())
        );
        assert_eq!(
            markdown_text(vec![0xff, 0xfe]),
            Err(strings::CLI_INPUT_NOT_TEXT)
        );
    }

    #[test]
    fn refuses_input_over_the_note_limit() {
        let limit = import::MAX_NOTE_BYTES as usize;
        assert_eq!(
            read_capped(&vec![b'a'; limit][..]).map(|b| b.len()),
            Ok(limit)
        );
        assert_eq!(
            read_capped(&vec![b'a'; limit + 1][..]),
            Err(strings::CLI_INPUT_TOO_LARGE.into())
        );
    }

    fn export_of(input: Input, output: PathBuf, format: Format) -> Export {
        Export {
            input,
            output,
            format,
            simple: false,
        }
    }

    #[test]
    fn reads_a_file_with_its_name_as_the_title() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Trip plan.md");
        std::fs::write(&file, "# Day one\r\n").unwrap();
        let source = read_source(&export_of(
            Input::File(file),
            dir.path().join("out.pdf"),
            Format::Pdf,
        ))
        .unwrap();
        assert_eq!(
            source,
            Source {
                markdown: "# Day one\n".into(),
                title: Some("Trip plan".into()),
                simple: false,
                print: true,
            }
        );
        let missing = dir.path().join("missing.md");
        assert_eq!(
            read_source(&export_of(
                Input::File(missing.clone()),
                dir.path().join("out.html"),
                Format::Html,
            )),
            Err(format!("no such file: {}", missing.display()))
        );
    }

    #[test]
    fn writes_only_into_a_folder_that_is_there() {
        let dir = tempfile::tempdir().unwrap();
        assert!(writes_to(&dir.path().join("a.pdf"), Format::Pdf));
        assert!(writes_to(&dir.path().join("a.HTML"), Format::Html));
        assert!(!writes_to(&dir.path().join("none/a.pdf"), Format::Pdf));
        assert!(!writes_to(&dir.path().join(".a.html"), Format::Html));
    }

    #[test]
    fn prints_only_error_codes_from_the_page() {
        assert!(valid_code("E_PREVIEW_FAILED"));
        assert!(valid_code("E_2"));
        for code in ["", "e_x", "W_X", "E_X Y", "E_note text", &"E_X".repeat(30)] {
            assert!(!valid_code(code), "{code}");
        }
    }
}
