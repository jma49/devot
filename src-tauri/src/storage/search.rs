use rusqlite::Connection;
use std::ffi::c_int;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::notes::summary;
use super::readable;
use super::{
    NoteQuery, NoteSummary, Result, SetKind, StorageError, Store, TextCondition, TextField,
};

impl TextField {
    fn column(self, ranked: bool) -> String {
        let body = if ranked {
            "(SELECT body_md FROM notes b WHERE b.rowid = n.rid)"
        } else {
            "n.body_md"
        };
        match self {
            Self::Any => format!("n.title || char(10) || {body}"),
            Self::Title => "n.title".into(),
            Self::Body => body.into(),
        }
    }

    fn fts(self, value: &str) -> String {
        let column = match self {
            Self::Any => "",
            Self::Title => "title : ",
            Self::Body => "body_md : ",
        };
        format!("{column}\"{}\"", value.replace('"', "\"\""))
    }
}

/// Characters of body an excerpt shows, and how many of them come before
/// the word found (EXCERPT_* in src/core/search.ts).
const EXCERPT_CHARS: usize = 160;
const EXCERPT_BEFORE: usize = 40;

/// Characters of a long body read on each side of the place a word is found
/// there (EXCERPT_STRETCH in src/core/search.ts); a body of at most twice as
/// many is read whole.
const EXCERPT_STRETCH: usize = 300;
const EXCERPT_PLACES: usize = 8;

/// Lower case, one character for one (as the trigram index folds case), so
/// positions in the folded text are positions in the original.
pub(super) fn fold(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// `text` folded one character at a time (see `fold`). The SQL function
/// `devot_fold` is this: terms too short for the trigram index are scanned
/// with it, so they ignore case in every script, as the index does (SQLite's
/// own `lower()` folds ASCII only). tests/support/sqlite-adapter.ts registers the same function
/// (tests/support/sqlite-adapter.ts) from the same cases (tests/support/folds.json).
pub(super) fn fold_text(text: &str) -> String {
    if text.is_ascii() {
        text.to_ascii_lowercase()
    } else {
        text.chars().map(fold).collect()
    }
}

pub(super) fn register_fold(conn: &Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    use rusqlite::types::{Value, ValueRef};
    conn.create_scalar_function(
        "devot_fold",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            Ok(match ctx.get_raw(0) {
                ValueRef::Text(bytes) => Value::Text(fold_text(&String::from_utf8_lossy(bytes))),
                ValueRef::Null => Value::Null,
                ValueRef::Integer(i) => Value::Integer(i),
                ValueRef::Real(f) => Value::Real(f),
                ValueRef::Blob(b) => Value::Blob(b.to_vec()),
            })
        },
    )
}

fn chars_back(text: &str, at: usize, count: usize) -> usize {
    text[..at]
        .char_indices()
        .rev()
        .take(count)
        .last()
        .map_or(at, |(i, _)| i)
}

fn chars_ahead(text: &str, at: usize, count: usize) -> usize {
    text[at..]
        .char_indices()
        .nth(count)
        .map_or(text.len(), |(i, _)| at + i)
}

fn after_front_matter(body: &str) -> usize {
    let line_at = |from: usize| {
        let (line, next) = match body[from..].find('\n') {
            Some(i) => (&body[from..from + i], Some(from + i + 1)),
            None => (&body[from..], None),
        };
        (line.strip_suffix('\r').unwrap_or(line), next)
    };
    let (first, mut next) = line_at(0);
    if !readable::is_fence(first) {
        return 0;
    }
    while let Some(at) = next {
        let (line, after) = line_at(at);
        if readable::is_fence(line) {
            return after.unwrap_or(body.len());
        }
        next = after;
    }
    0
}

fn find_folded(body: &str, wanted: &[char], from: usize) -> Option<(usize, usize)> {
    let (&first, rest) = wanted.split_first()?;
    body[from..].char_indices().find_map(|(i, c)| {
        if fold(c) != first {
            return None;
        }
        let start = from + i;
        let mut end = start + c.len_utf8();
        let mut after = body[end..].chars();
        for &w in rest {
            let c = after.next().filter(|&c| fold(c) == w)?;
            end += c.len_utf8();
        }
        Some((start, end))
    })
}

struct Place {
    chars: Vec<char>,
    before: usize,
    from: usize,
}

fn place_in(text: &str, terms: &[&str]) -> Option<Place> {
    let chars: Vec<char> = text.chars().collect();
    let folded: String = chars.iter().map(|&c| fold(c)).collect();
    let before = terms.iter().find_map(|term| {
        let term: String = term.chars().map(fold).collect();
        if term.is_empty() {
            return None;
        }
        Some(folded[..folded.find(&term)?].chars().count())
    })?;
    Some(Place {
        chars,
        before,
        from: before.saturating_sub(EXCERPT_BEFORE),
    })
}

fn is_break(c: char) -> bool {
    matches!(c, ' ' | '\n' | '\t' | '\r')
}

/// A cut that finds no break before the term (a term in a long word, or text without spaces) stays
/// where it falls. Same rule as `wordStart` in src/core/search.ts.
fn word_start(place: &Place) -> usize {
    let (chars, from, at) = (&place.chars, place.from, place.before);
    if from == 0 || is_break(chars[from - 1]) || is_break(chars[from]) {
        return from;
    }
    let mut i = from;
    while i < at && !is_break(chars[i]) {
        i += 1;
    }
    if i >= at {
        return from;
    }
    while i < at && is_break(chars[i]) {
        i += 1;
    }
    i
}

fn excerpt_at(place: &Place, cut: bool) -> String {
    let start = word_start(place);
    let mut excerpt = String::new();
    if cut || start > 0 {
        excerpt.push('\u{2026}');
    }
    excerpt.extend(place.chars[start..].iter().take(EXCERPT_CHARS));
    excerpt
}

/// Starts with an ellipsis when it starts mid-text; None when no term is found.
/// A body longer than twice `EXCERPT_STRETCH` characters is not read whole, so a page of results
/// costs the same however long the notes are: a term is looked for as written (in any case), at
/// most `EXCERPT_PLACES` times, after any front matter, and each place is read with
/// `EXCERPT_STRETCH` characters on each side as a body of its own, growing a stretch at a time
/// while the word shows too near one of its ends. Same rule, step for step, as `bodyExcerpt` in
/// src/core/search.ts (tests/support/excerpts.json holds cases both sides agree on).
pub(crate) fn body_excerpt(body: &str, terms: &[&str]) -> Option<String> {
    if body.chars().nth(2 * EXCERPT_STRETCH).is_none() {
        return place_in(&readable::readable_text(body), terms).map(|p| excerpt_at(&p, false));
    }
    let text = after_front_matter(body);
    // The readable text of body[start..stop], read as a body of its own: a
    // blank first line, so front matter is read only at the body's start.
    let readable = |start: usize, stop: usize| {
        if start == 0 {
            readable::readable_text(&body[..stop])
        } else {
            readable::readable_text(&format!("\n{}", &body[start..stop]))
        }
    };
    for term in terms {
        let wanted: Vec<char> = term.chars().map(fold).collect();
        let mut from = text;
        for _ in 0..EXCERPT_PLACES {
            let Some((at, end)) = find_folded(body, &wanted, from) else {
                break;
            };
            // EXCERPT_STRETCH characters on each side, from the body's start
            // when that reaches the front matter.
            let mut start = chars_back(body, at, EXCERPT_STRETCH);
            if start <= text {
                start = 0;
            }
            let mut stop = chars_ahead(body, end, EXCERPT_STRETCH);
            let mut place = place_in(&readable(start, stop), &[term]);
            for _ in 0..EXCERPT_PLACES {
                let Some(found) = &place else { break };
                let short = start > 0 && found.before < EXCERPT_BEFORE;
                let long = stop < body.len() && found.chars.len() - found.from < EXCERPT_CHARS;
                if !short && !long {
                    break;
                }
                if short {
                    start = chars_back(body, start, EXCERPT_STRETCH);
                }
                if start <= text {
                    start = 0;
                }
                if long {
                    stop = chars_ahead(body, stop, EXCERPT_STRETCH);
                }
                place = place_in(&readable(start, stop), &[term]);
            }
            if let Some(found) = place {
                return Some(excerpt_at(&found, start > 0));
            }
            from = at + body[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    None
}

fn indexable(value: &str) -> bool {
    value.chars().count() >= 3
}

/// How a scan for a term too short for the trigram index finds what
/// `devot_fold` would, more cheaply than folding every text it reads (#48;
/// `scanFolding` in src/core/search.ts, the same).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ScanFolding {
    None,
    /// Those and ASCII letters, which only an ASCII capital and the Kelvin
    /// sign (U+212A, to k) fold to: the text is read through SQLite's
    /// lower() (ASCII only) with the Kelvin sign replaced by `k`.
    Ascii,
    Fold,
}

/// Whether no character but `c` itself folds to `c` (see `fold`): ASCII
/// other than letters, CJK symbols and punctuation, kana, the CJK
/// ideographs and Hangul. A test checks every character.
pub(super) fn caseless(c: char) -> bool {
    matches!(c,
        '\0'..='\x40' | '\x5b'..='\x60' | '\x7b'..='\x7f'
        | '\u{3000}'..='\u{9fff}' | '\u{ac00}'..='\u{d7a3}' | '\u{f900}'..='\u{faff}'
        | '\u{20000}'..='\u{3ffff}')
}

pub(super) fn scan_folding(text: &str) -> ScanFolding {
    if text.chars().all(caseless) {
        ScanFolding::None
    } else if text.chars().all(|c| c.is_ascii() || caseless(c)) {
        ScanFolding::Ascii
    } else {
        ScanFolding::Fold
    }
}

/// The scan folds as the index folds case (see `ScanFolding`) and treats title and body apart when
/// the text has no line break (only such text could run from the title into the body). The
/// TypeScript adapter's `scanClause` builds the same.
fn scan_clause(t: &TextCondition, ranked: bool, value: &str) -> String {
    let columns = if t.field == TextField::Any && !t.value.contains('\n') {
        vec![
            TextField::Title.column(ranked),
            TextField::Body.column(ranked),
        ]
    } else {
        vec![t.field.column(ranked)]
    };
    let folding = scan_folding(&t.value);
    // The Kelvin sign matters only to a term with a k.
    let kelvin = t.value.contains(['k', 'K']);
    let found: Vec<String> = columns
        .iter()
        .map(|c| match folding {
            ScanFolding::None => format!("instr({c}, {value}) > 0"),
            ScanFolding::Ascii if kelvin => {
                format!("instr(lower(replace({c}, char(8490), 'k')), lower({value})) > 0")
            }
            ScanFolding::Ascii => format!("instr(lower({c}), lower({value})) > 0"),
            ScanFolding::Fold => format!("instr(devot_fold({c}), devot_fold({value})) > 0"),
        })
        .collect();
    let any = if found.len() > 1 {
        format!("({})", found.join(" OR "))
    } else {
        found.join("")
    };
    if t.negate { format!("NOT {any}") } else { any }
}

/// The same SQL as the TypeScript adapter builds (tests/support/sqlite-adapter.ts, searchStatement): every
/// condition is one clause of a WHERE, so the limit applies after all of them. Ranked text (three
/// or more characters) matches the trigram index first (`hits`, with each match's rank) and the
/// list's index joins them, so a ranked search walks the whole list index even for one match
/// (O(notes), about 2.5 ms for 50,000 notes); letting the matches drive the join would read each
/// match's row through its blobs, which costs twice as much once a word is in many notes (see
/// tests/core/list-cost.test.ts). Shorter text is scanned. With ranked text the matches meeting
/// every other condition are put in rank order first (`ranked`) and the scan reads them in that
/// order, so it stops once a page is full instead of reading every match's body (#48). Ties go to
/// the newer note, then by ID.
pub(super) fn search_sql(query: &NoteQuery, limit: u32) -> (String, Vec<String>) {
    let mut values: Vec<String> = Vec::new();
    // Numbered parameters: the SQL is built out of order.
    let mut param = |value: String| {
        values.push(value);
        format!("?{}", values.len())
    };
    let ranked: Vec<&TextCondition> = query
        .text
        .iter()
        .filter(|t| !t.negate && indexable(&t.value))
        .collect();
    let mut clauses = vec![
        "n.deleted_at IS NULL".to_string(),
        "n.purged_at IS NULL".to_string(),
    ];
    let mut scans: Vec<String> = Vec::new();
    for t in &query.text {
        if !indexable(&t.value) {
            let value = param(t.value.clone());
            scans.push(scan_clause(t, !ranked.is_empty(), &value));
        } else if t.negate {
            clauses.push(format!(
                "n.rowid NOT IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH {})",
                param(t.field.fts(&t.value))
            ));
        }
    }
    for set in &query.sets {
        let json = serde_json::to_string(&set.ids).unwrap_or_default();
        let ids = format!("(SELECT value FROM json_each({}))", param(json));
        clauses.push(match (set.kind, set.negate) {
            (SetKind::Book, false) => format!("n.book_id IN {ids}"),
            (SetKind::Book, true) => format!("(n.book_id IS NULL OR n.book_id NOT IN {ids})"),
            (SetKind::Status, false) => format!("n.status IN {ids}"),
            (SetKind::Status, true) => format!("n.status NOT IN {ids}"),
            (SetKind::Tag, negate) => format!(
                "{}EXISTS (SELECT 1 FROM note_tags nt
                   WHERE nt.note_id = n.id AND nt.present = 1 AND nt.tag_id IN {ids})",
                if negate { "NOT " } else { "" }
            ),
        });
    }
    match query.pinned {
        Some(true) => clauses.push("n.pinned = 1".into()),
        Some(false) => clauses.push("n.pinned = 0".into()),
        None => {}
    }
    let hits = if ranked.is_empty() {
        String::new()
    } else {
        let all: Vec<String> = ranked.iter().map(|t| t.field.fts(&t.value)).collect();
        format!(
            "WITH hits AS MATERIALIZED (SELECT rowid AS rid, bm25(notes_fts) AS score
               FROM notes_fts WHERE notes_fts MATCH {})",
            param(all.join(" AND "))
        )
    };
    let select = "SELECT n.id, n.title, n.created_at AS createdAt, n.updated_at AS updatedAt, n.book_id AS bookId, n.status, n.pinned,
                (SELECT group_concat(nt.tag_id) FROM note_tags nt
                   JOIN tags t ON t.id = nt.tag_id AND t.deleted_at IS NULL
                  WHERE nt.note_id = n.id AND nt.present = 1) AS tagIds,
                n.body_version AS bodyVersion";
    // Ranked text and a scan: the matches meeting every other condition, in
    // rank order. The scan reads them in that order and stops at a page only
    // because SQLite keeps a MATERIALIZED CTE's order and uses it for the
    // same ORDER BY outside (the results stay right if it did not, only
    // slower; tests check the plan and how many bodies are read).
    let early = !hits.is_empty() && !scans.is_empty();
    let (source, conditions, score) = if early {
        (
            format!(
                "{hits},
                 ranked AS MATERIALIZED (SELECT n.rowid AS rid, h.score, n.id, n.title, n.created_at,
                     n.updated_at, n.book_id, n.status, n.pinned, n.body_version
                   FROM notes n INDEXED BY notes_list JOIN hits h ON h.rid = n.rowid
                   WHERE {}
                   ORDER BY h.score, n.updated_at DESC, n.id DESC)
                 {select} FROM ranked n",
                clauses.join(" AND ")
            ),
            scans,
            "n.score, ",
        )
    } else if hits.is_empty() {
        clauses.extend(scans);
        (
            format!("{select} FROM notes n INDEXED BY notes_list"),
            clauses,
            "",
        )
    } else {
        clauses.extend(scans);
        (
            format!(
                "{hits} {select} FROM notes n INDEXED BY notes_list JOIN hits h ON h.rid = n.rowid"
            ),
            clauses,
            "h.score, ",
        )
    };
    let sql = format!(
        "{source}
         WHERE {}
         ORDER BY {score}n.updated_at DESC, n.id DESC LIMIT {limit}",
        conditions.join(" AND ")
    );
    (sql, values)
}

const REBUILD_STOP_STEPS: c_int = 100;

fn rebuild_checked(conn: &Connection) -> rusqlite::Result<u32> {
    conn.execute_batch(
        "INSERT INTO notes_fts (notes_fts) VALUES ('rebuild');
         INSERT INTO notes_fts (notes_fts, rank) VALUES ('integrity-check', 1);",
    )?;
    conn.query_row(
        "SELECT count(*) FROM notes WHERE purged_at IS NULL",
        [],
        |row| row.get(0),
    )
}

impl Store {
    /// FTS5 reports no progress, so it is one statement, then checked against the table, all in one
    /// transaction: a failed check rolls the rebuild back, and so does `stop` answering true. SQLite
    /// asks it from a progress handler: `sqlite3_interrupt` would be lost between two statements
    /// and could stop the next job's statement instead.
    pub fn rebuild_search_index(
        &mut self,
        mut stop: impl FnMut() -> bool + Send + 'static,
    ) -> Result<u32> {
        let stopped = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&stopped);
        let tx = self.conn.transaction()?;
        tx.progress_handler(
            REBUILD_STOP_STEPS,
            Some(move || {
                let now = stop();
                if now {
                    seen.store(true, Ordering::Relaxed);
                }
                now
            }),
        )?;
        let rebuilt = rebuild_checked(&tx);
        // Off before the transaction ends, so nothing stops its commit or rollback.
        tx.progress_handler(REBUILD_STOP_STEPS, None::<fn() -> bool>)?;
        if stopped.load(Ordering::Relaxed) {
            return Err(StorageError::RebuildStopped);
        }
        let notes = rebuilt?;
        tx.commit()?;
        Ok(notes)
    }

    pub fn search_notes(&self, query: &NoteQuery, limit: u32) -> Result<Vec<NoteSummary>> {
        let (sql, values) = search_sql(query, limit);
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(values.iter()), summary)?;
        let mut found: Vec<NoteSummary> = rows.collect::<rusqlite::Result<_>>()?;
        let terms: Vec<&str> = query
            .text
            .iter()
            .filter(|t| !t.negate && t.field != TextField::Title)
            .map(|t| t.value.as_str())
            .collect();
        if !terms.is_empty() {
            let mut body = self
                .conn
                .prepare_cached("SELECT body_md FROM notes WHERE id = ?1")?;
            for note in &mut found {
                let text: String = body.query_row([&note.id], |row| row.get(0))?;
                note.excerpt = body_excerpt(&text, &terms);
            }
        }
        Ok(found)
    }
}
