//! Files for the assets of an upload (ADR 0015, Batches). A `CKAsset` uploads from a file, so each
//! sealed chunk is written to one in a folder of the app's data folder: never Caches, which the
//! system may purge while an upload runs. The files of a batch go once it is sent, and whatever a
//! crash left is swept on launch. They hold sealed bytes only.

use std::path::{Path, PathBuf};

pub(crate) const DIR: &str = "sync-assets";
const FAILED: &str = "E_SYNC_ICLOUD_STAGING";

pub(crate) struct Staging {
    dir: PathBuf,
}

impl Staging {
    pub(crate) fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_owned(),
        }
    }

    pub(crate) fn stage(&self, bytes: &[u8]) -> Result<PathBuf, &'static str> {
        std::fs::create_dir_all(&self.dir).map_err(|_| FAILED)?;
        let path = self
            .dir
            .join(format!("{}.chunk", uuid::Uuid::new_v4().simple()));
        crate::atomic_file::write(&path, bytes, crate::atomic_file::Place::New)
            .map_err(|_| FAILED)?;
        Ok(path)
    }

    pub(crate) fn remove(&self, paths: &[PathBuf]) {
        for path in paths {
            if path.parent() == Some(self.dir.as_path())
                && let Err(e) = std::fs::remove_file(path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                log::warn!("W_SYNC_ICLOUD_STAGING_REMOVE");
            }
        }
    }

    /// Empties the folder: on launch, before any upload runs.
    pub(crate) fn sweep(&self) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let staged: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.path())
            .collect();
        self.remove(&staged);
    }

    #[cfg(test)]
    pub(crate) fn files(&self) -> usize {
        std::fs::read_dir(&self.dir).map_or(0, Iterator::count)
    }
}
