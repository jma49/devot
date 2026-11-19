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

fn clean_name(name: Option<&str>, id: &str) -> String {
    let name: String = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(id)
        .chars()
        .filter(|c| !c.is_control())
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
        reasoning: levels(CLAUDE_EFFORTS),
        default_reasoning: None,
    })
    .collect()
}

#[cfg(any(desktop, test))]
#[derive(serde::Deserialize)]
struct CodexCatalog {
    models: Vec<CodexModel>,
}

#[cfg(any(desktop, test))]
#[derive(serde::Deserialize)]
struct CodexModel {
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
    visibility: Option<String>,
    priority: Option<i64>,
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexLevel>,
}

#[cfg(any(desktop, test))]
#[derive(serde::Deserialize)]
struct CodexLevel {
    effort: String,
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
pub fn parse_codex(stdout: &[u8]) -> Result<Vec<CatalogModel>, &'static str> {
    let catalog: CodexCatalog =
        serde_json::from_slice(stdout).map_err(|_| "E_AI_RESPONSE_INVALID")?;
    let mut listed: Vec<CodexModel> = catalog
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref() == Some("list") && valid_id(&m.slug))
        .collect();
    listed.sort_by_key(|m| m.priority.unwrap_or(i64::MAX));
    Ok(listed
        .into_iter()
        .take(MAX_MODELS)
        .map(|m| {
            let reasoning = levels(
                m.supported_reasoning_levels
                    .iter()
                    .map(|l| l.effort.as_str()),
            );
            let default_reasoning = clean_reasoning(m.default_reasoning_level.as_deref())
                .ok()
                .flatten()
                .filter(|d| reasoning.contains(d));
            CatalogModel {
                name: clean_name(m.display_name.as_deref(), &m.slug),
                tier: codex_tier(m.description.as_deref()),
                id: m.slug,
                reasoning,
                default_reasoning,
            }
        })
        .collect())
}

fn data(body: &[u8]) -> Result<Vec<Value>, &'static str> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "E_AI_RESPONSE_INVALID")?;
    match value.get("data") {
        Some(Value::Array(items)) => Ok(items.clone()),
        _ => Err("E_AI_RESPONSE_INVALID"),
    }
}

/// The Anthropic Models API (`GET /v1/models`): newest first, with the effort levels each model's `capabilities` mark supported.
pub fn parse_anthropic(body: &[u8]) -> Result<Vec<CatalogModel>, &'static str> {
    Ok(data(body)?
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
    Ok(data(body)?
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
    fn claude_code_offers_its_aliases_with_every_effort_level() {
        let models = claude_code();
        let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["opus", "sonnet", "haiku", "fable"]);
        assert!(models.iter().all(|m| m.reasoning == CLAUDE_EFFORTS));
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
