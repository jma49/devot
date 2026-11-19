//! Each provider's models as Settings offers them: an ID, a name to show, a tier tag where the source gives one, and the reasoning levels it takes.

use serde::Serialize;
use serde_json::Value;

use super::settings::{clean_model, clean_reasoning};

/// A provider listing more than this is cut here; no picker needs more.
pub const MAX_MODELS: usize = 500;
const MAX_NAME_CHARS: usize = 120;
/// Claude's effort levels from lowest to highest, as `claude --effort` and the Messages API's `output_config.effort` name them.
pub const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Fast,
    Best,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub tier: Option<Tier>,
    /// Lowest first; empty when the source does not say.
    pub reasoning: Vec<String>,
    /// The level the model uses when none is chosen, when the source says.
    pub default_reasoning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Catalog {
    Ready {
        models: Vec<CatalogModel>,
        /// The model a request uses when Settings names none; None leaves it to the tool.
        default_model: Option<&'static str>,
    },
    Failed {
        code: &'static str,
    },
}

/// The tier of a Claude model by its family (`opus` is the most capable, `haiku` the fastest); other families get none.
pub fn claude_tier(id: &str) -> Option<Tier> {
    if id.contains("haiku") {
        Some(Tier::Fast)
    } else if id.contains("opus") {
        Some(Tier::Best)
    } else {
        None
    }
}

/// Unicode's format characters (Cf) and line and paragraph separators (Zl, Zp): invisible, or able to make a name read as another.
fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08e2}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

fn clean_name(name: Option<&str>, id: &str) -> String {
    let name: String = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(id)
        .chars()
        .filter(|&c| !c.is_control() && !is_format(c))
        .take(MAX_NAME_CHARS)
        .collect();
    if name.is_empty() {
        id.to_string()
    } else {
        name
    }
}

fn levels<'a>(levels: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for level in levels {
        if let Ok(Some(level)) = clean_reasoning(Some(level))
            && !out.contains(&level)
        {
            out.push(level);
        }
    }
    out
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && clean_model(id).is_ok_and(|clean| clean == id)
}

#[cfg(any(desktop, test))]
/// Claude Code takes these aliases for the latest model of each family; the CLI has no command that lists them.
pub fn claude_code() -> Vec<CatalogModel> {
    [
        ("opus", "Claude Opus"),
        ("sonnet", "Claude Sonnet"),
        ("haiku", "Claude Haiku"),
        ("fable", "Claude Fable"),
    ]
    .into_iter()
    .map(|(id, name)| CatalogModel {
        id: id.to_string(),
        name: name.to_string(),
        tier: claude_tier(id),
        // Haiku takes no effort level.
        reasoning: if id == "haiku" {
            Vec::new()
        } else {
            levels(CLAUDE_EFFORTS)
        },
        default_reasoning: None,
    })
    .collect()
}

#[cfg(any(desktop, test))]
/// Codex's description says when a model is its most capable or a fast one.
fn codex_tier(description: Option<&str>) -> Option<Tier> {
    let description = description?.trim().to_ascii_lowercase();
    if description.contains("most capable") {
        Some(Tier::Best)
    } else if description.starts_with("fast") {
        Some(Tier::Fast)
    } else {
        None
    }
}

#[cfg(any(desktop, test))]
/// `codex debug models`: the models Codex lists (`visibility: "list"`), in its order (`priority`, lowest first).
/// Each entry is read on its own, so one with a field of the wrong shape is left out and the rest are kept.
pub fn parse_codex(stdout: &[u8]) -> Result<Vec<CatalogModel>, &'static str> {
    let items = array_at(stdout, "models")?;
    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_string);
    let mut listed: Vec<(i64, CatalogModel)> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("slug")?.as_str()?;
            if item.get("visibility")?.as_str()? != "list" || !valid_id(id) {
                return None;
            }
            let priority = match item.get("priority") {
                None | Some(Value::Null) => i64::MAX,
                Some(p) => p.as_i64()?,
            };
            let reasoning = match item.get("supported_reasoning_levels") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(levels_given)) => levels(
                    levels_given
                        .iter()
                        .filter_map(|l| l.get("effort").and_then(Value::as_str)),
                ),
                Some(_) => return None,
            };
            let default_reasoning =
                clean_reasoning(text(item, "default_reasoning_level").as_deref())
                    .ok()
                    .flatten()
                    .filter(|d| reasoning.contains(d));
            Some((
                priority,
                CatalogModel {
                    id: id.to_string(),
                    name: clean_name(text(item, "display_name").as_deref(), id),
                    tier: codex_tier(text(item, "description").as_deref()),
                    reasoning,
                    default_reasoning,
                },
            ))
        })
        .collect();
    listed.sort_by_key(|(priority, _)| *priority);
    Ok(listed
        .into_iter()
        .map(|(_, model)| model)
        .take(MAX_MODELS)
        .collect())
}

fn array_at(body: &[u8], key: &str) -> Result<Vec<Value>, &'static str> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "E_AI_RESPONSE_INVALID")?;
    match value {
        Value::Object(mut fields) => match fields.remove(key) {
            Some(Value::Array(items)) => Ok(items),
            _ => Err("E_AI_RESPONSE_INVALID"),
        },
        _ => Err("E_AI_RESPONSE_INVALID"),
    }
}

/// The Anthropic Models API (`GET /v1/models`): newest first, with the effort levels each model's `capabilities` mark supported.
pub fn parse_anthropic(body: &[u8]) -> Result<Vec<CatalogModel>, &'static str> {
    Ok(array_at(body, "data")?
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            if !valid_id(id) {
                return None;
            }
            let effort = item.get("capabilities").and_then(|c| c.get("effort"));
            let supported = |v: Option<&Value>| {
                v.and_then(|v| v.get("supported"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            };
            let reasoning = if supported(effort) {
                levels(
                    CLAUDE_EFFORTS
                        .into_iter()
                        .filter(|level| supported(effort.and_then(|e| e.get(level)))),
                )
            } else {
                Vec::new()
            };
            Some(CatalogModel {
                id: id.to_string(),
                name: clean_name(item.get("display_name").and_then(Value::as_str), id),
                tier: claude_tier(id),
                reasoning,
                default_reasoning: None,
            })
        })
        .take(MAX_MODELS)
        .collect())
}

/// An OpenAI-compatible `GET /models`: IDs only, in the server's order.
pub fn parse_openai(body: &[u8]) -> Result<Vec<CatalogModel>, &'static str> {
    Ok(array_at(body, "data")?
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            valid_id(id).then(|| CatalogModel {
                id: id.to_string(),
                name: id.to_string(),
                tier: None,
                reasoning: Vec::new(),
                default_reasoning: None,
            })
        })
        .take(MAX_MODELS)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_lists_only_its_listed_models_in_priority_order() {
        let stdout = json!({"models": [
            {"slug": "gpt-b", "display_name": "GPT B", "visibility": "list", "priority": 2,
             "description": "Our most capable model.", "default_reasoning_level": "medium",
             "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "ultra"}],
             "base_instructions": "long text"},
            {"slug": "gpt-hidden", "display_name": "Hidden", "visibility": "hide", "priority": 0},
            {"slug": "gpt-a", "display_name": "GPT A", "visibility": "list", "priority": 1,
             "description": "Fast, go-to model.", "default_reasoning_level": "max",
             "supported_reasoning_levels": [{"effort": "low"}, {"effort": "--bad"}]},
            {"slug": "--model", "visibility": "list", "priority": 3},
            {"slug": "gpt-c", "visibility": "list"}
        ]})
        .to_string();
        let models = parse_codex(stdout.as_bytes()).unwrap();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-a", "gpt-b", "gpt-c"]);
        assert_eq!(models[0].tier, Some(Tier::Fast));
        assert_eq!(models[0].reasoning, ["low"]);
        assert_eq!(models[0].default_reasoning, None, "not among its levels");
        assert_eq!(models[1].tier, Some(Tier::Best));
        assert_eq!(models[1].reasoning, ["low", "medium", "ultra"]);
        assert_eq!(models[1].default_reasoning.as_deref(), Some("medium"));
        assert_eq!(models[2].name, "gpt-c");
        assert_eq!(models[2].tier, None);
        assert_eq!(parse_codex(b"not json"), Err("E_AI_RESPONSE_INVALID"));
        assert_eq!(
            parse_codex(b"{\"models\": 1}"),
            Err("E_AI_RESPONSE_INVALID")
        );
    }

    #[test]
    fn a_codex_entry_of_the_wrong_shape_is_left_out_and_the_rest_kept() {
        let stdout = json!({"models": [
            {"slug": "gpt-ok", "visibility": "list", "priority": 1, "display_name": null,
             "description": null, "default_reasoning_level": null, "supported_reasoning_levels": null},
            {"slug": "gpt-bad-priority", "visibility": "list", "priority": "first"},
            {"slug": "gpt-bad-levels", "visibility": "list", "supported_reasoning_levels": "low"},
            {"slug": null, "visibility": "list"},
            {"slug": "gpt-no-visibility"},
            "not an object",
            {"slug": "gpt-named", "visibility": "list", "priority": 2, "display_name": 7,
             "supported_reasoning_levels": [{"effort": 3}, {"effort": "low"}, null]}
        ]})
        .to_string();
        let models = parse_codex(stdout.as_bytes()).unwrap();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-ok", "gpt-named"]);
        assert_eq!(models[0].name, "gpt-ok");
        assert!(models[0].reasoning.is_empty());
        assert_eq!(models[1].name, "gpt-named");
        assert_eq!(models[1].reasoning, ["low"]);
    }

    #[test]
    fn a_name_loses_invisible_and_direction_characters() {
        assert_eq!(
            clean_name(Some("Op\u{202e}us\u{200b} 9\u{2028}\u{feff}\u{e0041}"), "x"),
            "Opus 9"
        );
        assert_eq!(clean_name(Some("\u{200d}\u{2029}"), "model-id"), "model-id");
        assert_eq!(clean_name(Some("Caf\u{e9}"), "x"), "Caf\u{e9}");
    }

    #[test]
    fn anthropic_models_carry_the_effort_levels_their_capabilities_mark() {
        let body = json!({"data": [
            {"id": "claude-opus-9", "display_name": "Claude Opus 9", "capabilities": {"effort": {
                "supported": true, "low": {"supported": true}, "medium": {"supported": true},
                "high": {"supported": true}, "xhigh": {"supported": false}, "max": {"supported": true}}}},
            {"id": "claude-haiku-9", "display_name": "Claude\u{0007} Haiku 9", "capabilities": {"effort": {"supported": false}}},
            {"id": "claude-sonnet-9"},
            {"id": "bad id"}
        ], "has_more": false})
        .to_string();
        let models = parse_anthropic(body.as_bytes()).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].reasoning, ["low", "medium", "high", "max"]);
        assert_eq!(models[0].tier, Some(Tier::Best));
        assert_eq!(models[1].name, "Claude Haiku 9");
        assert_eq!(models[1].tier, Some(Tier::Fast));
        assert!(models[1].reasoning.is_empty());
        assert_eq!(models[2].name, "claude-sonnet-9");
        assert_eq!(
            parse_anthropic(b"{\"data\": 1}"),
            Err("E_AI_RESPONSE_INVALID")
        );
    }

    #[test]
    fn an_openai_compatible_list_is_ids_only() {
        let body =
            json!({"object": "list", "data": [{"id": "llama3.2:3b"}, {"id": 4}, {"id": "gpt-x"}]});
        let models = parse_openai(body.to_string().as_bytes()).unwrap();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["llama3.2:3b", "gpt-x"]);
        assert!(
            models
                .iter()
                .all(|m| m.reasoning.is_empty() && m.tier.is_none())
        );
    }

    #[test]
    fn claude_code_offers_its_aliases_with_every_effort_level_but_haiku_none() {
        let models = claude_code();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["opus", "sonnet", "haiku", "fable"]);
        for model in &models {
            let expected: &[&str] = if model.id == "haiku" {
                &[]
            } else {
                &CLAUDE_EFFORTS
            };
            assert_eq!(model.reasoning, expected, "{}", model.id);
        }
        assert_eq!(models[0].tier, Some(Tier::Best));
        assert_eq!(models[2].tier, Some(Tier::Fast));
    }

    #[test]
    fn a_catalog_says_its_state() {
        let ready = Catalog::Ready {
            models: claude_code().into_iter().take(1).collect(),
            default_model: None,
        };
        let json = serde_json::to_value(&ready).unwrap();
        assert_eq!(json["state"], "ready");
        assert_eq!(json["defaultModel"], Value::Null);
        assert_eq!(json["models"][0]["defaultReasoning"], Value::Null);
        assert_eq!(json["models"][0]["tier"], "best");
        let failed = serde_json::to_value(Catalog::Failed {
            code: "E_AI_KEY_MISSING",
        })
        .unwrap();
        assert_eq!(
            failed,
            json!({"state": "failed", "code": "E_AI_KEY_MISSING"})
        );
    }
}
