use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::chunks::passages;
use super::{Semantic, Status};
use crate::commands::notes::validate_query;
use crate::storage::{Db, NoteQuery, NoteSummary};

/// A query's text, as the search field holds it (src/core/semantic.ts, MAX_SEMANTIC_TEXT).
const MAX_TEXT_CHARS: usize = 1_000;
/// Results one search returns (MAX_SEMANTIC_RESULTS).
const MAX_RESULTS: u32 = 50;
/// Passages ranked before the filter leaves out what the view or AI access does not show.
const CANDIDATES: usize = 400;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SemanticQuery {
    pub text: String,
    /// The search's other conditions; any text condition must be negated.
    pub filter: NoteQuery,
    pub limit: u32,
    /// Whether each hit carries its whole passage (for a question to a model), not its excerpt
    /// alone.
    pub passages: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SemanticHit {
    #[serde(flatten)]
    pub note: NoteSummary,
    pub score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage: Option<String>,
}

pub(crate) fn validate(query: &SemanticQuery) -> Result<(), &'static str> {
    let chars = query.text.trim().chars().count();
    if chars == 0 || chars > MAX_TEXT_CHARS {
        return Err("E_SEMANTIC_TEXT_INVALID");
    }
    if !(1..=MAX_RESULTS).contains(&query.limit) {
        return Err("E_SEMANTIC_LIMIT_INVALID");
    }
    if query.filter.text.iter().any(|t| !t.negate) {
        return Err("E_SEMANTIC_FILTER_INVALID");
    }
    validate_query(&query.filter)
}

pub(crate) async fn search(
    semantic: &Semantic,
    db: &Db,
    query: SemanticQuery,
) -> Result<Vec<SemanticHit>, &'static str> {
    validate(&query)?;
    semantic.licence().require()?;
    let nearest = semantic
        .nearest(query.text.trim().to_owned(), CANDIDATES)
        .await?;
    if nearest.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = nearest.iter().map(|n| n.note_id.clone()).collect();
    let (filter, want_passages) = (query.filter, query.passages);
    let (shown, bodies) = db
        .call(move |store| {
            let shown = store.notes_among(&filter, &ids)?;
            let bodies = if want_passages {
                let ids: Vec<String> = shown.iter().map(|n| n.id.clone()).collect();
                store.live_bodies(&ids)?
            } else {
                Vec::new()
            };
            Ok((shown, bodies))
        })
        .await
        .map_err(|_| "E_SEMANTIC_FILTER_FAILED")?;
    let mut shown: std::collections::HashMap<String, NoteSummary> =
        shown.into_iter().map(|n| (n.id.clone(), n)).collect();
    let bodies: std::collections::HashMap<String, (String, String)> = bodies
        .into_iter()
        .map(|(b, _)| (b.id, (b.title, b.body_md)))
        .collect();
    Ok(nearest
        .into_iter()
        .filter_map(|found| {
            let mut note = shown.remove(&found.note_id)?;
            let passage = want_passages.then(|| {
                bodies
                    .get(&note.id)
                    .and_then(|(title, body)| passages(title, body).into_iter().nth(found.seq))
                    .map_or_else(|| found.excerpt.clone(), |p| p.text)
            });
            note.excerpt = Some(found.excerpt).filter(|e| !e.is_empty());
            Some(SemanticHit {
                note,
                score: found.score,
                passage,
            })
        })
        .take(query.limit as usize)
        .collect())
}

#[tauri::command]
pub async fn semantic_search(
    semantic: State<'_, Arc<Semantic>>,
    db: State<'_, Db>,
    query: SemanticQuery,
) -> Result<Vec<SemanticHit>, String> {
    search(&semantic, &db, query).await.map_err(String::from)
}

#[tauri::command]
pub fn semantic_status(semantic: State<'_, Arc<Semantic>>) -> Status {
    semantic.status()
}
