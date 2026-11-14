//! The vectors, in a database of their own beside the notes: derived from them, rebuilt from them
//! whenever it is missing, damaged or of another version, and never synced or backed up.

use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use std::path::Path;

pub(crate) const FILE: &str = "semantic-index.sqlite";
const VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  body_version INTEGER NOT NULL,
  digest       BLOB NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE passages (
  note_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  tag     TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  vector  BLOB NOT NULL,
  PRIMARY KEY (note_id, seq)
) STRICT, WITHOUT ROWID;
";

/// What the index holds for a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Indexed {
    pub body_version: i64,
    pub digest: [u8; 32],
}

pub(crate) struct Embedded {
    pub tag: String,
    pub excerpt: String,
    pub vector: Vec<i8>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Nearest {
    pub note_id: String,
    pub seq: usize,
    pub score: f32,
    pub excerpt: String,
}

/// Unit length, then each component in 1/127ths: a quarter of the size, and the order of scores
/// barely moves.
pub(crate) fn quantize(vector: &[f32]) -> Option<Vec<i8>> {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return None;
    }
    Some(
        vector
            .iter()
            .map(|v| (v / norm * 127.0).round().clamp(-127.0, 127.0) as i8)
            .collect(),
    )
}

fn similarity(a: &[i8], b: &[u8]) -> Option<f32> {
    (a.len() == b.len()).then(|| {
        let dot: i32 = a
            .iter()
            .zip(b)
            .map(|(&x, &y)| i32::from(x) * i32::from(y as i8))
            .sum();
        dot as f32 / (127.0 * 127.0)
    })
}

pub(crate) struct Index {
    conn: Connection,
}

impl Index {
    /// An index of another version, or one SQLite cannot read, is started again.
    pub(crate) fn open(path: &Path) -> rusqlite::Result<Self> {
        match Self::open_as_is(path) {
            Ok(index) => Ok(index),
            Err(error) => {
                log::warn!("W_SEMANTIC_INDEX_RESET {error}");
                for suffix in ["", "-wal", "-shm"] {
                    let mut file = path.as_os_str().to_owned();
                    file.push(suffix);
                    let _ = std::fs::remove_file(file);
                }
                Self::open_as_is(path)
            }
        }
    }

    fn open_as_is(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS passages; VACUUM;",
            )?;
            conn.execute_batch(SCHEMA)?;
            conn.pragma_update(None, "user_version", VERSION)?;
        }
        conn.query_row("SELECT count(*) FROM notes", [], |_| Ok(()))?;
        Ok(Self { conn })
    }

    pub(crate) fn known(&self) -> rusqlite::Result<HashMap<String, Indexed>> {
        let mut statement = self
            .conn
            .prepare("SELECT id, body_version, digest FROM notes")?;
        let rows = statement.query_map([], |row| {
            let digest: Vec<u8> = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                Indexed {
                    body_version: row.get(1)?,
                    digest: digest.try_into().unwrap_or([0; 32]),
                },
            ))
        })?;
        rows.collect()
    }

    pub(crate) fn put(
        &mut self,
        id: &str,
        indexed: &Indexed,
        passages: &[Embedded],
    ) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM passages WHERE note_id = ?1", [id])?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO passages (note_id, seq, tag, excerpt, vector) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for (seq, passage) in passages.iter().enumerate() {
                let bytes: Vec<u8> = passage.vector.iter().map(|&v| v as u8).collect();
                insert.execute(params![id, seq as i64, passage.tag, passage.excerpt, bytes])?;
            }
        }
        tx.execute(
            "INSERT INTO notes (id, body_version, digest) VALUES (?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET body_version = excluded.body_version, digest = excluded.digest",
            params![id, indexed.body_version, indexed.digest.as_slice()],
        )?;
        tx.commit()
    }

    /// The note's text is the one indexed: only its version moved (a pin, a move, a tag).
    pub(crate) fn touch(&self, id: &str, body_version: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE notes SET body_version = ?2 WHERE id = ?1",
            params![id, body_version],
        )?;
        Ok(())
    }

    pub(crate) fn remove(&mut self, ids: &[String]) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM passages WHERE note_id = ?1", [id])?;
            tx.execute("DELETE FROM notes WHERE id = ?1", [id])?;
        }
        tx.commit()
    }

    pub(crate) fn tags(&self) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.conn.prepare("SELECT DISTINCT tag FROM passages")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    /// Notes with a passage of `tag`, which the next pass indexes again.
    pub(crate) fn forget_tag(&mut self, tag: &str) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM notes WHERE id IN (SELECT note_id FROM passages WHERE tag = ?1)",
            [tag],
        )?;
        tx.execute(
            "DELETE FROM passages WHERE note_id NOT IN (SELECT id FROM notes)",
            [],
        )?;
        tx.commit()
    }

    #[cfg(test)]
    pub(crate) fn passage_count(&self) -> rusqlite::Result<u64> {
        let count: i64 = self
            .conn
            .query_row("SELECT count(*) FROM passages", [], |row| row.get(0))?;
        Ok(u64::try_from(count).unwrap_or(0))
    }

    /// Each note's best passage of `tag` at `min_score` or more, best first, at most `limit`.
    pub(crate) fn nearest(
        &self,
        tag: &str,
        query: &[i8],
        min_score: f32,
        limit: usize,
    ) -> rusqlite::Result<Vec<Nearest>> {
        let mut best: HashMap<String, (usize, f32)> = HashMap::new();
        let mut statement = self
            .conn
            .prepare_cached("SELECT note_id, seq, vector FROM passages WHERE tag = ?1")?;
        let mut rows = statement.query([tag])?;
        while let Some(row) = rows.next()? {
            let vector = row.get_ref(2)?.as_blob()?;
            let Some(score) = similarity(query, vector) else {
                continue;
            };
            if score < min_score {
                continue;
            }
            let id = row.get_ref(0)?.as_str()?;
            let seq = row.get::<_, i64>(1)? as usize;
            match best.get_mut(id) {
                Some(found) if found.1 >= score => {}
                Some(found) => *found = (seq, score),
                None => {
                    best.insert(id.to_owned(), (seq, score));
                }
            }
        }
        let mut ranked: Vec<(String, usize, f32)> = best
            .into_iter()
            .map(|(id, (seq, score))| (id, seq, score))
            .collect();
        ranked.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        ranked.truncate(limit);
        let mut excerpt = self
            .conn
            .prepare_cached("SELECT excerpt FROM passages WHERE note_id = ?1 AND seq = ?2")?;
        ranked
            .into_iter()
            .map(|(note_id, seq, score)| {
                let text: Option<String> = excerpt
                    .query_row(params![note_id, seq as i64], |row| row.get(0))
                    .optional()?;
                Ok(Nearest {
                    note_id,
                    seq,
                    score,
                    excerpt: text.unwrap_or_default(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embedded(tag: &str, vector: &[f32]) -> Embedded {
        Embedded {
            tag: tag.into(),
            excerpt: format!("{tag} {vector:?}"),
            vector: quantize(vector).unwrap(),
        }
    }

    fn indexed(version: i64) -> Indexed {
        Indexed {
            body_version: version,
            digest: [version as u8; 32],
        }
    }

    #[test]
    fn quantized_vectors_score_as_their_cosine() {
        let a = quantize(&[3.0, 4.0]).unwrap();
        assert_eq!(a, vec![76, 102]);
        let bytes: Vec<u8> = a.iter().map(|&v| v as u8).collect();
        assert!((similarity(&a, &bytes).unwrap() - 1.0).abs() < 0.01);
        let opposite: Vec<u8> = quantize(&[-3.0, -4.0])
            .unwrap()
            .iter()
            .map(|&v| v as u8)
            .collect();
        assert!((similarity(&a, &opposite).unwrap() + 1.0).abs() < 0.01);
        assert_eq!(similarity(&a, &[1, 2, 3]), None);
        assert_eq!(quantize(&[0.0, 0.0]), None);
        assert_eq!(quantize(&[f32::NAN, 1.0]), None);
    }

    #[test]
    fn nearest_ranks_each_note_by_its_best_passage_of_the_tag() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Index::open(&dir.path().join(FILE)).unwrap();
        index
            .put(
                "a",
                &indexed(1),
                &[embedded("en@1", &[1.0, 0.0]), embedded("en@1", &[0.6, 0.8])],
            )
            .unwrap();
        index
            .put("b", &indexed(1), &[embedded("en@1", &[0.8, 0.6])])
            .unwrap();
        index
            .put("c", &indexed(1), &[embedded("de@1", &[1.0, 0.0])])
            .unwrap();
        index
            .put("d", &indexed(1), &[embedded("en@1", &[-1.0, 0.0])])
            .unwrap();
        let query = quantize(&[0.0, 1.0]).unwrap();
        let found = index.nearest("en@1", &query, 0.1, 10).unwrap();
        let ids: Vec<(&str, usize)> = found.iter().map(|n| (n.note_id.as_str(), n.seq)).collect();
        assert_eq!(ids, vec![("a", 1), ("b", 0)]);
        assert!(found[0].score > found[1].score);
        assert_eq!(found[0].excerpt, "en@1 [0.6, 0.8]");
        assert_eq!(index.nearest("en@1", &query, 0.1, 1).unwrap().len(), 1);
        assert_eq!(index.passage_count().unwrap(), 5);
    }

    #[test]
    fn a_put_replaces_the_notes_passages_and_remove_and_forget_take_them_out() {
        let dir = tempfile::tempdir().unwrap();
        let mut index = Index::open(&dir.path().join(FILE)).unwrap();
        index
            .put(
                "a",
                &indexed(1),
                &[embedded("en@1", &[1.0]), embedded("en@1", &[1.0])],
            )
            .unwrap();
        index
            .put("a", &indexed(2), &[embedded("en@2", &[1.0])])
            .unwrap();
        index
            .put("b", &indexed(1), &[embedded("en@1", &[1.0])])
            .unwrap();
        assert_eq!(index.passage_count().unwrap(), 2);
        assert_eq!(index.known().unwrap()["a"], indexed(2));
        index.touch("a", 5).unwrap();
        assert_eq!(index.known().unwrap()["a"].body_version, 5);
        let mut tags = index.tags().unwrap();
        tags.sort();
        assert_eq!(tags, vec!["en@1", "en@2"]);
        index.forget_tag("en@1").unwrap();
        assert!(!index.known().unwrap().contains_key("b"));
        assert_eq!(index.passage_count().unwrap(), 1);
        index.remove(&["a".into()]).unwrap();
        assert!(index.known().unwrap().is_empty());
        assert_eq!(index.passage_count().unwrap(), 0);
    }

    #[test]
    fn an_index_of_another_version_or_a_damaged_file_starts_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        {
            let mut index = Index::open(&path).unwrap();
            index
                .put("a", &indexed(1), &[embedded("en@1", &[1.0])])
                .unwrap();
            index.conn.pragma_update(None, "user_version", 99).unwrap();
        }
        assert!(Index::open(&path).unwrap().known().unwrap().is_empty());
        drop(std::fs::remove_file(path.with_extension("sqlite-wal")));
        std::fs::write(&path, vec![7u8; 8192]).unwrap();
        let index = Index::open(&path).unwrap();
        assert!(index.known().unwrap().is_empty());
    }
}
