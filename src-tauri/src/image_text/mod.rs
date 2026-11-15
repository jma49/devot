//! Reads the text in the images notes hold, on the device (the system's text recognition), so a
//! search finds a note by it (docs/specs/search.md, Text in images). No image or text leaves the
//! device. A thread of its own works through the notes whose images changed, a few images a pass,
//! only while saves are quiet and at utility priority; each image is hashed and read once, however
//! many notes hold it.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tauri::async_runtime::block_on;

use crate::storage::Db;

/// Text kept from one image at most, so a poster of small print cannot swell the index.
const MAX_CHARS: usize = 20_000;

/// The system's text recognition.
pub(crate) trait Reader {
    /// The image's text, line by line; an error is a code, never what the image holds.
    fn read(&mut self, image: &[u8]) -> Result<String, &'static str>;
}

pub(crate) type MakeReader = Box<dyn FnOnce() -> Option<Box<dyn Reader>> + Send>;

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn system() -> MakeReader {
    Box::new(|| Some(Box::new(crate::native::ios::text_recognition::Recognizer) as Box<dyn Reader>))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn system() -> MakeReader {
    Box::new(|| None)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Pace {
    /// How long saves must stay quiet before images are read.
    pub quiet: Duration,
    /// How often an idle thread looks for images to read.
    pub poll: Duration,
    /// Images read in one pass, between two looks at whether saves are still quiet.
    pub batch: usize,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            quiet: Duration::from_secs(4),
            poll: Duration::from_secs(20),
            batch: 4,
        }
    }
}

/// Dropping it ends the thread once its current image is read.
pub(crate) struct ImageText {
    _stop: mpsc::Sender<()>,
}

impl ImageText {
    pub(crate) fn start(db: Db, make: MakeReader, pace: Pace) -> Self {
        let (stop, stopped) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("devot-image-text".into())
            .spawn(move || Worker { db, pace }.run(make, &stopped));
        if spawned.is_err() {
            log::warn!("W_IMAGE_TEXT_THREAD_SPAWN");
        }
        Self { _stop: stop }
    }
}

struct Worker {
    db: Db,
    pace: Pace,
}

impl Worker {
    fn run(self, make: MakeReader, stopped: &mpsc::Receiver<()>) {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        crate::native::ios::embedding::lower_thread_priority();
        let Some(mut reader) = make() else {
            log::info!("I_IMAGE_TEXT_UNAVAILABLE");
            return;
        };
        let mut next = Instant::now() + self.pace.quiet;
        loop {
            match stopped.recv_timeout(next.saturating_duration_since(Instant::now())) {
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                _ => return,
            }
            if let Some(left) = self.quiet_left() {
                next = Instant::now() + left;
                continue;
            }
            next = match self.pass(reader.as_mut()) {
                Ok(true) => Instant::now(),
                Ok(false) => Instant::now() + self.pace.poll,
                Err(error) => {
                    log::warn!("W_IMAGE_TEXT_PASS_FAILED {error}");
                    Instant::now() + self.pace.poll
                }
            };
        }
    }

    /// How much longer saves must stay quiet, if they have not been for long enough.
    fn quiet_left(&self) -> Option<Duration> {
        let (_, since) = self.db.writes();
        since
            .filter(|since| *since < self.pace.quiet)
            .map(|since| self.pace.quiet - since)
    }

    /// Reads up to a batch of images: whether any may be left.
    fn pass(&self, reader: &mut dyn Reader) -> crate::storage::Result<bool> {
        let notes = block_on(self.db.call(|store| store.stale_image_notes(8)))?;
        if notes.is_empty() {
            return Ok(false);
        }
        let mut read = 0;
        for note in notes {
            while let Some(image) = block_on(self.db.call(move |store| store.unhashed_image(note)))?
            {
                if read == self.pace.batch || self.quiet_left().is_some() {
                    return Ok(true);
                }
                let hash: Vec<u8> = Sha256::digest(&image.data).to_vec();
                let key = hash.clone();
                if !block_on(self.db.call(move |store| store.has_image_text(&key)))? {
                    let text = reader.read(&image.data).map_or_else(
                        |code| {
                            log::warn!("W_IMAGE_TEXT_READ {code}");
                            String::new()
                        },
                        |text| clipped(&text),
                    );
                    let key = hash.clone();
                    block_on(
                        self.db
                            .write_derived(move |store| store.put_image_text(&key, &text)),
                    )?;
                    read += 1;
                }
                let file = image.file_id;
                block_on(
                    self.db
                        .write_derived(move |store| store.put_file_hash(&file, &hash)),
                )?;
            }
            block_on(
                self.db
                    .write_derived(move |store| store.refresh_image_text(note)),
            )?;
        }
        Ok(true)
    }
}

fn clipped(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(MAX_CHARS) {
        Some((end, _)) => text[..end].to_owned(),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests;
