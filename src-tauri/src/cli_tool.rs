//! Settings > General > Command Line Tool (docs/architecture.md, Command line).

use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::strings;

pub const LINK: &str = "/usr/local/bin/devot";
pub const SCRIPT: &str = "bin/devot";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Installed,
    Absent,
    /// A link elsewhere (Install replaces it) or a file (Install refuses).
    Other,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub state: State,
    pub path: &'static str,
}

pub fn state_of(link: &Path, script: Option<&Path>) -> State {
    let Some(script) = script else {
        return State::Unavailable;
    };
    match std::fs::symlink_metadata(link) {
        Err(e) if e.kind() == ErrorKind::NotFound => State::Absent,
        Ok(meta) if meta.file_type().is_symlink() => {
            if std::fs::read_link(link).is_ok_and(|target| target == script) {
                State::Installed
            } else {
                State::Other
            }
        }
        _ => State::Other,
    }
}

// Paths come in as arguments, never spliced into the script's text.
const INSTALL_SCRIPT: &str = "on run argv
do shell script \"/bin/mkdir -p \" & quoted form of (item 1 of argv) & \" && /bin/ln -sfn \" & quoted form of (item 2 of argv) & \" \" & quoted form of (item 3 of argv) with prompt (item 4 of argv) with administrator privileges
end run";
const UNINSTALL_SCRIPT: &str = "on run argv
do shell script \"/bin/rm -f \" & quoted form of (item 1 of argv) with prompt (item 2 of argv) with administrator privileges
end run";

fn osascript(script: &str, args: &[&OsStr]) -> Command {
    let mut command = Command::new("/usr/bin/osascript");
    command.arg("-e").arg(script).args(args);
    command
}

fn install_command(link: &Path, script: &Path) -> Command {
    let folder = link.parent().unwrap_or(Path::new("/"));
    osascript(
        INSTALL_SCRIPT,
        &[
            folder.as_os_str(),
            script.as_os_str(),
            link.as_os_str(),
            OsStr::new(strings::CLI_INSTALL_PROMPT),
        ],
    )
}

fn uninstall_command(link: &Path) -> Command {
    osascript(
        UNINSTALL_SCRIPT,
        &[link.as_os_str(), OsStr::new(strings::CLI_UNINSTALL_PROMPT)],
    )
}

pub fn run_prompt(mut command: Command) -> Result<(), &'static str> {
    let output = command
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "E_CLI_AUTHORIZATION_FAILED")?;
    if output.status.success() {
        return Ok(());
    }
    // AppleScript's "User canceled." (-128).
    if String::from_utf8_lossy(&output.stderr).contains("(-128)") {
        Err("E_CLI_AUTHORIZATION_CANCELLED")
    } else {
        Err("E_CLI_AUTHORIZATION_FAILED")
    }
}

fn needs_prompt(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::PermissionDenied | ErrorKind::NotFound | ErrorKind::ReadOnlyFilesystem
    )
}

/// Linked beside its place and renamed over it; `prompt` when the folder is not writable.
pub fn install_at(
    link: &Path,
    script: &Path,
    prompt: impl FnOnce(Command) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    if state_of(link, Some(script)) == State::Installed {
        return Ok(());
    }
    if std::fs::symlink_metadata(link).is_ok_and(|meta| !meta.file_type().is_symlink()) {
        return Err("E_CLI_PATH_TAKEN");
    }
    let folder = link.parent().ok_or("E_CLI_PATH_INVALID")?;
    let temporary = folder.join(format!(".devot-{}", uuid::Uuid::new_v4().simple()));
    let made = std::os::unix::fs::symlink(script, &temporary).and_then(|()| {
        std::fs::rename(&temporary, link).inspect_err(|_| {
            let _ = std::fs::remove_file(&temporary);
        })
    });
    match made {
        Ok(()) => Ok(()),
        Err(e) if needs_prompt(&e) => prompt(install_command(link, script)),
        Err(_) => Err("E_CLI_INSTALL_FAILED"),
    }
}

pub fn uninstall_at(
    link: &Path,
    script: &Path,
    prompt: impl FnOnce(Command) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    match state_of(link, Some(script)) {
        State::Absent => return Ok(()),
        State::Installed => {}
        _ => return Err("E_CLI_NOT_INSTALLED"),
    }
    match std::fs::remove_file(link) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) if needs_prompt(&e) => prompt(uninstall_command(link)),
        Err(_) => Err("E_CLI_UNINSTALL_FAILED"),
    }
}

fn script<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let script = app.path().resource_dir().ok()?.join(SCRIPT);
    script.is_file().then_some(script)
}

fn status<R: Runtime>(app: &AppHandle<R>) -> Status {
    Status {
        state: state_of(Path::new(LINK), script(app).as_deref()),
        path: LINK,
    }
}

/// Off the main thread: the prompt waits for the user. Cancelling it is no error.
async fn change<R: Runtime>(
    app: AppHandle<R>,
    change: fn(&Path, &Path) -> Result<(), &'static str>,
) -> Result<Status, String> {
    let script = script(&app).ok_or_else(|| String::from("E_CLI_UNAVAILABLE"))?;
    let changed = tauri::async_runtime::spawn_blocking(move || change(Path::new(LINK), &script))
        .await
        .map_err(|_| String::from("E_CLI_INSTALL_FAILED"))?;
    match changed {
        Ok(()) | Err("E_CLI_AUTHORIZATION_CANCELLED") => Ok(status(&app)),
        Err(code) => {
            log::warn!("W_CLI_TOOL_FAILED {code}");
            Err(code.into())
        }
    }
}

#[tauri::command]
pub fn cli_tool_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn cli_tool_install(app: AppHandle) -> Result<Status, String> {
    change(app, |link, script| install_at(link, script, run_prompt)).await
}

#[tauri::command]
pub async fn cli_tool_uninstall(app: AppHandle) -> Result<Status, String> {
    change(app, |link, script| uninstall_at(link, script, run_prompt)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn no_prompt(_: Command) -> Result<(), &'static str> {
        panic!("no prompt expected")
    }

    struct Place {
        _dir: tempfile::TempDir,
        bin: PathBuf,
        link: PathBuf,
        script: PathBuf,
    }

    fn place() -> Place {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let script = dir.path().join("Devot.app/Contents/Resources/bin/devot");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "#!/bin/sh\n").unwrap();
        Place {
            link: bin.join("devot"),
            bin,
            script,
            _dir: dir,
        }
    }

    #[test]
    fn installs_and_removes_a_link_where_it_may_write() {
        let p = place();
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Absent);
        assert_eq!(state_of(&p.link, None), State::Unavailable);
        install_at(&p.link, &p.script, no_prompt).unwrap();
        assert_eq!(std::fs::read_link(&p.link).unwrap(), p.script);
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Installed);
        install_at(&p.link, &p.script, no_prompt).unwrap();
        uninstall_at(&p.link, &p.script, no_prompt).unwrap();
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Absent);
        assert_eq!(std::fs::read_dir(&p.bin).unwrap().count(), 0);
    }

    #[test]
    fn replaces_a_link_elsewhere_but_never_a_file() {
        let p = place();
        std::os::unix::fs::symlink("/Old/Devot.app/Contents/Resources/bin/devot", &p.link).unwrap();
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Other);
        assert_eq!(
            uninstall_at(&p.link, &p.script, no_prompt),
            Err("E_CLI_NOT_INSTALLED")
        );
        install_at(&p.link, &p.script, no_prompt).unwrap();
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Installed);

        std::fs::remove_file(&p.link).unwrap();
        std::fs::write(&p.link, "someone's own tool").unwrap();
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Other);
        assert_eq!(
            install_at(&p.link, &p.script, no_prompt),
            Err("E_CLI_PATH_TAKEN")
        );
        assert_eq!(
            std::fs::read_to_string(&p.link).unwrap(),
            "someone's own tool"
        );
    }

    #[test]
    fn asks_for_a_password_where_it_may_not_write() {
        let p = place();
        std::fs::set_permissions(&p.bin, std::fs::Permissions::from_mode(0o555)).unwrap();
        let mut asked = None;
        let result = install_at(&p.link, &p.script, |command| {
            asked = Some(command);
            Err("E_CLI_AUTHORIZATION_CANCELLED")
        });
        std::fs::set_permissions(&p.bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result, Err("E_CLI_AUTHORIZATION_CANCELLED"));
        let command = asked.unwrap();
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/osascript"));
        let args: Vec<&OsStr> = command.get_args().collect();
        assert_eq!(
            args,
            [
                OsStr::new("-e"),
                OsStr::new(INSTALL_SCRIPT),
                p.bin.as_os_str(),
                p.script.as_os_str(),
                p.link.as_os_str(),
                OsStr::new(strings::CLI_INSTALL_PROMPT),
            ]
        );
        assert_eq!(state_of(&p.link, Some(&p.script)), State::Absent);
    }

    #[test]
    fn a_missing_folder_is_made_through_the_prompt() {
        let p = place();
        let link = p.bin.join("missing/devot");
        let mut asked = false;
        install_at(&link, &p.script, |_| {
            asked = true;
            Ok(())
        })
        .unwrap();
        assert!(asked);
    }

    #[test]
    fn removes_through_the_prompt_where_it_may_not_write() {
        let p = place();
        install_at(&p.link, &p.script, no_prompt).unwrap();
        std::fs::set_permissions(&p.bin, std::fs::Permissions::from_mode(0o555)).unwrap();
        let mut asked = None;
        let result = uninstall_at(&p.link, &p.script, |command| {
            asked = Some(command);
            Ok(())
        });
        std::fs::set_permissions(&p.bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        result.unwrap();
        let command = asked.unwrap();
        let args: Vec<&OsStr> = command.get_args().collect();
        assert_eq!(
            args,
            [
                OsStr::new("-e"),
                OsStr::new(UNINSTALL_SCRIPT),
                p.link.as_os_str(),
                OsStr::new(strings::CLI_UNINSTALL_PROMPT),
            ]
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_prompt_scripts_compile() {
        let dir = tempfile::tempdir().unwrap();
        for (name, script) in [("install", INSTALL_SCRIPT), ("uninstall", UNINSTALL_SCRIPT)] {
            let status = Command::new("/usr/bin/osacompile")
                .arg("-e")
                .arg(script)
                .arg("-o")
                .arg(dir.path().join(format!("{name}.scpt")))
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "{name}");
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_script_runs_the_binary_beside_it_in_command_line_mode() {
        let dir = tempfile::tempdir().unwrap();
        let contents = dir.path().join("Devot.app/Contents");
        let script = contents.join("Resources/bin/devot");
        let binary = contents.join("MacOS/devot");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("cli/devot");
        std::fs::copy(&source, &script).unwrap();
        std::fs::write(&binary, "#!/bin/sh\nprintf '%s|' \"$@\"\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = dir.path().join("devot");
        std::os::unix::fs::symlink(&script, &link).unwrap();
        let output = Command::new(&link)
            .args(["a b.md", "--notebook"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "--cli|a b.md|--notebook|"
        );
        std::fs::remove_file(&binary).unwrap();
        let dev = dir.path().join("target/debug");
        std::fs::create_dir_all(dev.join("bin")).unwrap();
        std::fs::copy(&source, dev.join("bin/devot")).unwrap();
        std::fs::write(dev.join("devot"), "#!/bin/sh\nprintf '%s|' \"$@\"\n").unwrap();
        std::fs::set_permissions(dev.join("devot"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let output = Command::new(dev.join("bin/devot"))
            .arg("export")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout), "--cli|export|");
    }
}
