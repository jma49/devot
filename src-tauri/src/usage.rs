//! Usage events (see `src/core/usage.ts`), kept on this device only. They
//! live in their own small database, `<app data>/usage.sqlite`, not in the
//! notes database: they never sync, never go into backups (so restoring one
//! cannot bring back cleared events), and devot-mcp never opens the file.
//!
//! The store is bounded: each write (and each listing) drops events older
//! than `Limits::max_age_ms` and keeps only the newest `Limits::max_events`.
//! Deleted rows are zeroed in the file (`secure_delete`), and clearing also
//! empties the write-ahead log, so cleared events are not left in either.
//! Events are disposable: the file uses WAL with `synchronous = NORMAL`, so a
//! write costs no flush to disk, and a crash can lose the latest events only. The UI checks every event against its typed catalog; this
//! module checks the shape again: a dotted lowercase name, and at most 16
//! properties whose values are short lowercase tokens or whole numbers, so a
//! title or a sentence cannot be stored even by a faulty caller.

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

pub const FILE: &str = "usage.sqlite";
const DAY_MS: i64 = 86_400_000;
const SCHEMA_VERSION: u32 = 1;
const SCHEMA: &str = "
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  name TEXT NOT NULL,
  properties TEXT NOT NULL
);
CREATE INDEX usage_events_at ON usage_events (at);
";

const MAX_NAME_LEN: usize = 64;
const MAX_PROPERTIES: usize = 16;
const MAX_KEY_LEN: usize = 32;
const MAX_TOKEN_LEN: usize = 32;
/// The largest whole number JavaScript represents exactly.
const MAX_NUMBER: u64 = (1 << 53) - 1;

/// How much the store keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_events: i64,
    pub max_age_ms: i64,
}

impl Limits {
    pub const DEFAULT: Self = Self {
        max_events: 10_000,
        max_age_ms: 90 * DAY_MS,
    };
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageEvent {
    pub id: i64,
    /// Milliseconds since the epoch, when the event was recorded.
    pub at: i64,
    pub name: String,
    pub properties: Value,
}

/// `area.event_name`: lowercase words joined by dots, at least two parts.
pub fn valid_name(name: &str) -> bool {
    name.len() <= MAX_NAME_LEN
        && name.split('.').count() >= 2
        && name.split('.').all(|part| {
            part.starts_with(|c: char| c.is_ascii_lowercase())
                && part.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        })
}

/// `camelCase`, starting with a lowercase letter.
fn valid_key(key: &str) -> bool {
    key.len() <= MAX_KEY_LEN
        && key.starts_with(|c: char| c.is_ascii_lowercase())
        && key.chars().all(|c| c.is_ascii_alphanumeric())
}

/// An enum value: a short lowercase token such as `new_note` or `2-5`.
fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOKEN_LEN
        && value.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_+-".contains(c))
}

/// Checks an event's shape; returns the error code when it is not one.
pub fn validate(name: &str, properties: &Map<String, Value>) -> Result<(), &'static str> {
    if !valid_name(name) {
        return Err("E_USAGE_NAME_INVALID");
    }
    if properties.len() > MAX_PROPERTIES {
        return Err("E_USAGE_PROPERTIES_INVALID");
    }
    for (key, value) in properties {
        let ok = valid_key(key)
            && match value {
                Value::String(s) => valid_token(s),
                Value::Number(n) => n.as_u64().is_some_and(|n| n <= MAX_NUMBER),
                _ => false,
            };
        if !ok {
            return Err("E_USAGE_PROPERTIES_INVALID");
        }
    }
    Ok(())
}

fn open(path: &Path) -> Result<Connection, &'static str> {
    let conn = Connection::open(path).map_err(|_| "E_USAGE_OPEN_FAILED")?;
    let setup = || -> rusqlite::Result<u32> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "secure_delete", true)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
    };
    match setup().map_err(|_| "E_USAGE_OPEN_FAILED")? {
        0 => conn
            .execute_batch(&format!(
                "BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
            ))
            .map_err(|_| "E_USAGE_OPEN_FAILED")?,
        SCHEMA_VERSION => {}
        _ => return Err("E_USAGE_SCHEMA_NEWER"),
    }
    Ok(conn)
}

/// The local event store. The file opens on first use, so a store that
/// cannot open never holds up the app; its calls fail with a code instead.
pub struct UsageLog {
    path: PathBuf,
    limits: Limits,
    conn: Mutex<Option<Connection>>,
}

impl UsageLog {
    pub fn new(path: &Path, limits: Limits) -> Self {
        Self {
            path: path.to_owned(),
            limits,
            conn: Mutex::new(None),
        }
    }

    fn with<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, &'static str> {
        let mut held = self.conn.lock().map_err(|_| "E_USAGE_LOCK_FAILED")?;
        let conn = match held.as_mut() {
            Some(conn) => conn,
            None => held.insert(open(&self.path)?),
        };
        work(conn).map_err(|_| "E_USAGE_STORE_FAILED")
    }

    fn prune(&self, conn: &Connection, now: i64) -> rusqlite::Result<()> {
        conn.execute(
            "DELETE FROM usage_events WHERE at < ?1",
            [now.saturating_sub(self.limits.max_age_ms)],
        )?;
        // Everything up to the first event past the newest `max_events`.
        conn.execute(
            "DELETE FROM usage_events WHERE id <=
               (SELECT id FROM usage_events ORDER BY id DESC LIMIT 1 OFFSET ?1)",
            [self.limits.max_events],
        )?;
        Ok(())
    }

    /// Stores an event at `now`, then applies the limits.
    pub fn record(
        &self,
        name: &str,
        properties: &Map<String, Value>,
        now: i64,
    ) -> Result<(), &'static str> {
        validate(name, properties)?;
        let json = serde_json::to_string(properties).map_err(|_| "E_USAGE_PROPERTIES_INVALID")?;
        self.with(|conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO usage_events (at, name, properties) VALUES (?1, ?2, ?3)",
                params![now, name, json],
            )?;
            self.prune(&tx, now)?;
            tx.commit()
        })
    }

    /// The stored events, newest first (in the order they were recorded,
    /// whatever the clock did), after applying the limits at `now`.
    pub fn list(&self, now: i64) -> Result<Vec<UsageEvent>, &'static str> {
        self.with(|conn| {
            self.prune(conn, now)?;
            select_all(conn)
        })
    }

    /// What is on disk, without applying the limits first.
    #[cfg(test)]
    fn stored(&self) -> Vec<UsageEvent> {
        self.with(|conn| select_all(conn)).unwrap()
    }

    /// Deletes every stored event, and the log's copies of them.
    pub fn clear(&self) -> Result<(), &'static str> {
        self.with(|conn| {
            conn.execute("DELETE FROM usage_events", [])?;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        })
    }
}

fn select_all(conn: &Connection) -> rusqlite::Result<Vec<UsageEvent>> {
    let mut stmt =
        conn.prepare("SELECT id, at, name, properties FROM usage_events ORDER BY id DESC")?;
    let rows = stmt.query_map([], |row| {
        let text: String = row.get(3)?;
        Ok(UsageEvent {
            id: row.get(0)?,
            at: row.get(1)?,
            name: row.get(2)?,
            properties: serde_json::from_str(&text).unwrap_or_else(|_| Value::Object(Map::new())),
        })
    })?;
    rows.collect()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "E_USAGE_TASK".to_string())?
        .map_err(String::from)
}

/// Records one event (main window).
#[tauri::command]
pub async fn usage_record(
    log: State<'_, Arc<UsageLog>>,
    name: String,
    properties: Map<String, Value>,
) -> Result<(), String> {
    // `record` checks the event before storing it.
    let log = Arc::clone(&log);
    blocking(move || log.record(&name, &properties, crate::logs::now_ms())).await
}

/// The stored events, newest first (Settings window).
#[tauri::command]
pub async fn usage_list(log: State<'_, Arc<UsageLog>>) -> Result<Vec<UsageEvent>, String> {
    let log = Arc::clone(&log);
    blocking(move || log.list(crate::logs::now_ms())).await
}

/// Deletes every stored event (Settings window).
#[tauri::command]
pub async fn usage_clear(log: State<'_, Arc<UsageLog>>) -> Result<(), String> {
    let log = Arc::clone(&log);
    blocking(move || log.clear()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_791_635_696_789;

    fn props(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("not an object"),
        }
    }

    fn store(dir: &tempfile::TempDir, limits: Limits) -> UsageLog {
        UsageLog::new(&dir.path().join(FILE), limits)
    }

    fn stored_names(log: &UsageLog) -> Vec<String> {
        log.stored().into_iter().map(|e| e.name).collect()
    }

    fn names(log: &UsageLog, now: i64) -> Vec<String> {
        log.list(now).unwrap().into_iter().map(|e| e.name).collect()
    }

    #[test]
    fn default_limits_are_ten_thousand_events_and_ninety_days() {
        assert_eq!(Limits::DEFAULT.max_events, 10_000);
        assert_eq!(Limits::DEFAULT.max_age_ms, 90 * 24 * 60 * 60 * 1000);
        assert_ne!(FILE, "devot.sqlite");
    }

    #[test]
    fn accepts_catalog_shaped_events() {
        let ok = props(json!({
            "scope": "all",
            "clauses": 2,
            "results": "101+",
            "range": "2-5",
            "durationMs": 1250,
            "from": "new_note",
        }));
        assert_eq!(validate("search.run", &ok), Ok(()));
        assert_eq!(validate("import.finished", &Map::new()), Ok(()));
    }

    #[test]
    fn rejects_names_that_are_not_dotted_lowercase_words() {
        for name in [
            "",
            "note",
            "Note.created",
            "note.",
            ".created",
            "note..created",
            "note.created!",
            "note.2",
            "note created.x",
            &format!("a.{}", "b".repeat(63)),
        ] {
            assert_eq!(
                validate(name, &Map::new()),
                Err("E_USAGE_NAME_INVALID"),
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_values_that_could_carry_content() {
        let bad = [
            json!({ "from": "Meeting notes" }),
            json!({ "from": "My Title" }),
            json!({ "from": "x".repeat(33) }),
            json!({ "from": "" }),
            json!({ "from": "-x" }),
            json!({ "from": "a/b" }),
            json!({ "count": -1 }),
            json!({ "count": 1.5 }),
            json!({ "count": 9_007_199_254_740_992_u64 }),
            json!({ "flag": true }),
            json!({ "none": null }),
            json!({ "list": ["a"] }),
            json!({ "nested": { "a": 1 } }),
            json!({ "Title": "x" }),
            json!({ "note_id": 1 }),
            json!({ "": 1 }),
        ];
        for value in bad {
            assert_eq!(
                validate("note.created", &props(value.clone())),
                Err("E_USAGE_PROPERTIES_INVALID"),
                "{value}"
            );
        }
        let many: Map<String, Value> = (0..17).map(|i| (format!("k{i}"), json!(1))).collect();
        assert_eq!(
            validate("note.created", &many),
            Err("E_USAGE_PROPERTIES_INVALID")
        );
    }

    #[test]
    fn records_and_lists_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let log = store(&dir, Limits::DEFAULT);
        log.record("note.created", &props(json!({ "from": "link" })), T0)
            .unwrap();
        log.record("search.run", &props(json!({ "clauses": 2 })), T0 + 5)
            .unwrap();
        let events = log.list(T0 + 10).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].name, "search.run");
        assert_eq!(events[0].at, T0 + 5);
        assert_eq!(events[0].properties, json!({ "clauses": 2 }));
        assert_eq!(events[1].name, "note.created");
        assert_eq!(events[1].properties, json!({ "from": "link" }));
        // A clock set back still lists in recording order.
        log.record("note.opened", &Map::new(), T0 - 1000).unwrap();
        assert_eq!(names(&log, T0)[0], "note.opened");
    }

    #[test]
    fn refuses_invalid_events_without_storing_them() {
        let dir = tempfile::tempdir().unwrap();
        let log = store(&dir, Limits::DEFAULT);
        let result = log.record("note.created", &props(json!({ "from": "A title" })), T0);
        assert_eq!(result, Err("E_USAGE_PROPERTIES_INVALID"));
        assert!(log.list(T0).unwrap().is_empty());
    }

    #[test]
    fn drops_events_past_the_age_limit_when_writing() {
        let dir = tempfile::tempdir().unwrap();
        let limits = Limits {
            max_events: 100,
            max_age_ms: 1000,
        };
        let log = store(&dir, limits);
        log.record("a.old", &Map::new(), T0).unwrap();
        log.record("a.edge", &Map::new(), T0 + 500).unwrap();
        // Exactly at the limit is kept; a millisecond more is not.
        log.record("a.new", &Map::new(), T0 + 1500).unwrap();
        // Writing alone prunes the file; nothing has been listed yet.
        assert_eq!(stored_names(&log), ["a.new", "a.edge"].map(String::from));
        log.record("a.newer", &Map::new(), T0 + 1501).unwrap();
        assert_eq!(stored_names(&log), ["a.newer", "a.new"].map(String::from));
        assert_eq!(
            names(&log, T0 + 1501),
            ["a.newer", "a.new"].map(String::from)
        );
    }

    #[test]
    fn drops_old_events_when_listing() {
        let dir = tempfile::tempdir().unwrap();
        let log = store(
            &dir,
            Limits {
                max_events: 100,
                max_age_ms: 1000,
            },
        );
        log.record("a.old", &Map::new(), T0).unwrap();
        assert_eq!(names(&log, T0 + 1000).len(), 1);
        assert!(log.list(T0 + 1001).unwrap().is_empty());
        // Gone for good, not just hidden.
        assert!(log.list(T0).unwrap().is_empty());
    }

    #[test]
    fn keeps_only_the_newest_events_past_the_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let log = store(
            &dir,
            Limits {
                max_events: 5,
                max_age_ms: DAY_MS,
            },
        );
        for i in 0..8 {
            log.record("a.event", &props(json!({ "n": i })), T0 + i)
                .unwrap();
        }
        // Writing alone keeps the file bounded; nothing has been listed yet.
        let on_disk: Vec<Value> = log
            .stored()
            .into_iter()
            .map(|e| e.properties["n"].clone())
            .collect();
        assert_eq!(on_disk, [7, 6, 5, 4, 3].map(|n| json!(n)));
        let kept: Vec<Value> = log
            .list(T0 + 8)
            .unwrap()
            .into_iter()
            .map(|e| e.properties["n"].clone())
            .collect();
        assert_eq!(kept, [7, 6, 5, 4, 3].map(|n| json!(n)));
    }

    #[test]
    fn clears_every_event_and_keeps_data_across_reopening() {
        let dir = tempfile::tempdir().unwrap();
        store(&dir, Limits::DEFAULT)
            .record("note.created", &props(json!({ "from": "link" })), T0)
            .unwrap();
        let reopened = store(&dir, Limits::DEFAULT);
        assert_eq!(names(&reopened, T0).len(), 1);
        reopened.clear().unwrap();
        assert!(reopened.list(T0).unwrap().is_empty());
        // No copy of the event is left in the database or its log.
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(!bytes.windows(12).any(|w| w == b"note.created"));
        }
        assert!(store(&dir, Limits::DEFAULT).list(T0).unwrap().is_empty());
    }

    #[test]
    fn refuses_a_file_from_a_newer_devot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        let log = UsageLog::new(&path, Limits::DEFAULT);
        assert_eq!(log.list(T0), Err("E_USAGE_SCHEMA_NEWER"));
    }
}
