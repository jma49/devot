//! Semantic search on the device: a thread of its own cuts each live note into passages, embeds
//! them with the system's sentence model and keeps the vectors in their own database
//! (`index::FILE`). It works only while saves are quiet and at utility priority, so typing and
//! opening notes never wait for it; a search asks the same thread, ahead of any indexing left.

mod chunks;
pub(crate) mod commands;
mod embedder;
mod index;

pub(crate) use embedder::{MakeEmbedder, system};
pub(crate) use index::FILE;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::licence::Gate;
use crate::storage::Db;
use embedder::Embedder;
use index::{Embedded, Index, Indexed, Nearest, quantize};

pub(crate) const UNAVAILABLE: &str = "E_SEMANTIC_UNAVAILABLE";
const GONE: &str = "E_SEMANTIC_THREAD_GONE";
const QUERY_UNREADABLE: &str = "E_SEMANTIC_QUERY_UNREADABLE";
const FAILED: &str = "E_SEMANTIC_INDEX_FAILED";

/// A passage scoring less than this is not related enough to show.
const MIN_SCORE: f32 = 0.35;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub(crate) enum Status {
    Starting,
    /// No sentence model on this system.
    Unavailable,
    /// The licence does not cover it: nothing is indexed.
    Locked,
    Indexing {
        done: u64,
        total: u64,
    },
    Ready {
        notes: u64,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Pace {
    /// How long saves must stay quiet before indexing runs.
    pub quiet: Duration,
    /// How often an idle thread looks for notes to index.
    pub poll: Duration,
    /// A pass reads every note's version again after this long even with no write of this
    /// process seen, for what another process wrote.
    pub rescan: Duration,
    /// Notes read and embedded between two looks for a search.
    pub batch: usize,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            quiet: Duration::from_secs(4),
            poll: Duration::from_secs(20),
            rescan: Duration::from_secs(600),
            batch: 8,
        }
    }
}

type Answer = std::result::Result<Vec<Nearest>, &'static str>;

struct Search {
    text: String,
    limit: usize,
    reply: oneshot::Sender<Answer>,
}

pub(crate) struct Semantic {
    searches: mpsc::Sender<Search>,
    status: Arc<Mutex<Status>>,
    licence: Gate,
}

impl Semantic {
    pub(crate) fn start(
        db: Db,
        path: PathBuf,
        make: MakeEmbedder,
        licence: Gate,
        pace: Pace,
    ) -> Self {
        let (searches, inbox) = mpsc::channel();
        let status = Arc::new(Mutex::new(Status::Starting));
        let worker = Worker {
            db,
            licence: licence.clone(),
            status: Arc::clone(&status),
            pace,
        };
        let spawned = std::thread::Builder::new()
            .name("devot-semantic".into())
            .spawn(move || worker.run(path, make, &inbox));
        if spawned.is_err() {
            log::warn!("W_SEMANTIC_THREAD_SPAWN");
            *crate::locks::lock(&status) = Status::Unavailable;
        }
        Self {
            searches,
            status,
            licence,
        }
    }

    pub(crate) fn status(&self) -> Status {
        *crate::locks::lock(&self.status)
    }

    pub(crate) fn licence(&self) -> &Gate {
        &self.licence
    }

    /// The notes whose passages read most like `text`, best first.
    pub(crate) async fn nearest(&self, text: String, limit: usize) -> Answer {
        let (reply, answer) = oneshot::channel();
        self.searches
            .send(Search { text, limit, reply })
            .map_err(|_| GONE)?;
        answer.await.map_err(|_| GONE)?
    }
}

struct Worker {
    db: Db,
    licence: Gate,
    status: Arc<Mutex<Status>>,
    pace: Pace,
}

/// What is left to index, from the last time every note's version was read.
#[derive(Default)]
struct Queue {
    stale: VecDeque<(String, i64)>,
    total: u64,
    scanned_at: Option<Instant>,
    writes_seen: Option<u64>,
}

impl Worker {
    fn set(&self, status: Status) {
        *crate::locks::lock(&self.status) = status;
    }

    fn run(self, path: PathBuf, make: MakeEmbedder, inbox: &mpsc::Receiver<Search>) {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        crate::native::ios::embedding::lower_thread_priority();
        let Some(mut embedder) = make() else {
            log::info!("I_SEMANTIC_UNAVAILABLE");
            return self.refuse_all(inbox);
        };
        let mut index = match Index::open(&path) {
            Ok(index) => index,
            Err(error) => {
                log::warn!("W_SEMANTIC_INDEX_OPEN {error}");
                return self.refuse_all(inbox);
            }
        };
        if let Err(error) = forget_old_models(&mut index, embedder.as_mut()) {
            log::warn!("W_SEMANTIC_INDEX_MODELS {error}");
        }
        let mut known = index.known().unwrap_or_default();
        let mut queue = Queue::default();
        let mut next = Instant::now() + self.pace.quiet;
        loop {
            let wait = if queue.stale.is_empty() {
                next.saturating_duration_since(Instant::now())
            } else {
                Duration::ZERO
            };
            match inbox.recv_timeout(wait) {
                Ok(search) => {
                    let answer = answer(embedder.as_mut(), &index, &search.text, search.limit);
                    let _ = search.reply.send(answer);
                    // Searches one after another must not hold indexing off for good.
                    if queue.stale.is_empty() && Instant::now() < next {
                        continue;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            let (writes, since) = self.db.writes();
            if let Some(since) = since.filter(|since| *since < self.pace.quiet) {
                queue.stale.clear();
                next = Instant::now() + (self.pace.quiet - since);
                continue;
            }
            if self.licence.require().is_err() {
                self.set(Status::Locked);
                next = Instant::now() + self.pace.poll;
                continue;
            }
            let outcome = if queue.stale.is_empty() {
                self.scan(&mut index, &mut known, &mut queue, writes)
            } else {
                self.index_batch(embedder.as_mut(), &mut index, &mut known, &mut queue)
            };
            if let Err(error) = outcome {
                log::warn!("W_SEMANTIC_PASS_FAILED {error}");
                queue.stale.clear();
            }
            if queue.stale.is_empty() {
                next = Instant::now() + self.pace.poll;
                self.set(Status::Ready {
                    notes: known.len() as u64,
                });
            } else {
                self.set(Status::Indexing {
                    done: queue.total - queue.stale.len() as u64,
                    total: queue.total,
                });
            }
        }
    }

    fn refuse_all(&self, inbox: &mpsc::Receiver<Search>) {
        self.set(Status::Unavailable);
        for search in inbox {
            let _ = search.reply.send(Err(UNAVAILABLE));
        }
    }

    /// Reads every live note's version, drops what the index holds for notes no longer live and
    /// queues the notes whose version moved since they were indexed.
    fn scan(
        &self,
        index: &mut Index,
        known: &mut HashMap<String, Indexed>,
        queue: &mut Queue,
        writes: u64,
    ) -> Result<(), String> {
        let fresh = queue
            .scanned_at
            .is_some_and(|at| at.elapsed() < self.pace.rescan);
        if fresh && queue.writes_seen == Some(writes) {
            return Ok(());
        }
        let live = tauri::async_runtime::block_on(self.db.call(|store| store.live_body_versions()))
            .map_err(|e| e.to_string())?;
        let live_ids: std::collections::HashSet<&str> =
            live.iter().map(|(id, _)| id.as_str()).collect();
        let gone: Vec<String> = known
            .keys()
            .filter(|id| !live_ids.contains(id.as_str()))
            .cloned()
            .collect();
        if !gone.is_empty() {
            index.remove(&gone).map_err(|e| e.to_string())?;
            for id in &gone {
                known.remove(id);
            }
        }
        queue.stale = live
            .into_iter()
            .filter(|(id, version)| known.get(id).is_none_or(|k| k.body_version != *version))
            .collect();
        queue.total = queue.stale.len() as u64;
        queue.scanned_at = Some(Instant::now());
        queue.writes_seen = Some(writes);
        Ok(())
    }

    fn index_batch(
        &self,
        embedder: &mut dyn Embedder,
        index: &mut Index,
        known: &mut HashMap<String, Indexed>,
        queue: &mut Queue,
    ) -> Result<(), String> {
        let take = self.pace.batch.min(queue.stale.len());
        let batch: Vec<(String, i64)> = queue.stale.drain(..take).collect();
        let ids: Vec<String> = batch.iter().map(|(id, _)| id.clone()).collect();
        let bodies =
            tauri::async_runtime::block_on(self.db.call(move |store| store.live_bodies(&ids)))
                .map_err(|e| e.to_string())?;
        for (body, body_version) in bodies {
            let digest: [u8; 32] = Sha256::new()
                .chain_update(body.title.as_bytes())
                .chain_update([0])
                .chain_update(body.body_md.as_bytes())
                .finalize()
                .into();
            let indexed = Indexed {
                body_version,
                digest,
            };
            if known.get(&body.id).is_some_and(|k| k.digest == digest) {
                index
                    .touch(&body.id, body_version)
                    .map_err(|e| e.to_string())?;
            } else {
                let embedded = embed_note(embedder, &body.title, &body.body_md);
                index
                    .put(&body.id, &indexed, &embedded)
                    .map_err(|e| e.to_string())?;
            }
            known.insert(body.id, indexed);
        }
        Ok(())
    }
}

fn forget_old_models(index: &mut Index, embedder: &mut dyn Embedder) -> rusqlite::Result<()> {
    for tag in index.tags()? {
        if !embedder.current(&tag) {
            index.forget_tag(&tag)?;
        }
    }
    Ok(())
}

fn embed_note(embedder: &mut dyn Embedder, title: &str, markdown: &str) -> Vec<Embedded> {
    chunks::passages(title, markdown)
        .into_iter()
        .filter_map(|passage| {
            let tag = embedder.tag_for(&passage.embedded)?;
            let vector = quantize(&embedder.vector(&tag, &passage.embedded)?)?;
            Some(Embedded {
                tag,
                excerpt: chunks::excerpt(&passage.text),
                vector,
            })
        })
        .collect()
}

/// The query is read with the model of its own language when the index holds passages of it,
/// else with every model the index holds, and the scores are merged.
fn answer(embedder: &mut dyn Embedder, index: &Index, text: &str, limit: usize) -> Answer {
    let tags = index.tags().map_err(|_| FAILED)?;
    let own = embedder.tag_for(text).ok_or(UNAVAILABLE)?;
    let asked: Vec<String> = if tags.contains(&own) || tags.is_empty() {
        vec![own]
    } else {
        tags
    };
    let mut best: HashMap<String, Nearest> = HashMap::new();
    let mut read = false;
    for tag in &asked {
        let Some(query) = embedder.vector(tag, text).and_then(|v| quantize(&v)) else {
            continue;
        };
        read = true;
        for found in index
            .nearest(tag, &query, MIN_SCORE, limit)
            .map_err(|_| FAILED)?
        {
            match best.get(&found.note_id) {
                Some(kept) if kept.score >= found.score => {}
                _ => {
                    best.insert(found.note_id.clone(), found);
                }
            }
        }
    }
    if !read {
        return Err(QUERY_UNREADABLE);
    }
    let mut ranked: Vec<Nearest> = best.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.note_id.cmp(&b.note_id))
    });
    ranked.truncate(limit);
    Ok(ranked)
}

#[cfg(test)]
mod tests;
