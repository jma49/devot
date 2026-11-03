//! `devot --cli mcp`: the MCP server AI tools run over stdio (ADR 0012). A small bridge, not a second
//! writer: it holds no database connection and no note, and turns each tool call into a request to
//! the running Devot's local HTTP API, whose core is the only write path. stdout carries MCP
//! messages only; logs go to stderr as codes and IDs.

mod client;
mod protocol;
mod start;
mod tools;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use client::HttpApiClient;
use start::Live;

/// Who this binary is: the identifier the app's folders and keychain items carry.
fn identity() -> (String, String) {
    let context = crate::data_folder::context();
    (
        context.config().identifier.clone(),
        context.package_info().version.to_string(),
    )
}

/// Where Tauri puts `app_data_dir` on macOS. A client may start this with a bare environment, so the
/// home folder falls back to the system's record of this user.
fn data_folder(identifier: &str) -> Option<PathBuf> {
    let home = std::env::home_dir().filter(|home| !home.as_os_str().is_empty())?;
    Some(home.join("Library/Application Support").join(identifier))
}

/// Runs until the client closes stdin; the exit status of `devot --cli mcp`.
pub fn run() -> i32 {
    let (identifier, version) = identity();
    let Some(data) = data_folder(&identifier) else {
        eprintln!("E_MCP_HOME_UNAVAILABLE");
        return 1;
    };
    let live = Live::new(&identifier, data);
    let name = Arc::new(Mutex::new(String::new()));
    let api = HttpApiClient::new(&identifier, live, Arc::clone(&name));
    let tools = tools::Tools::new(Box::new(api));
    let stdin = std::io::stdin();
    protocol::serve(
        stdin.lock(),
        std::io::stdout(),
        tools,
        name,
        &version,
        &|line: &str| eprintln!("{line}"),
    );
    0
}
