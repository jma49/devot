//! Tauri commands. Each one is declared in build.rs, granted in a capability
//! file, and validates its arguments before touching storage.

pub mod activity;
pub mod books;
pub mod files;
pub mod images;
pub mod notes;
pub mod revisions;
pub mod search_index;
pub mod tags;
