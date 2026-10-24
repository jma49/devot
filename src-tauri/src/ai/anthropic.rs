//! Claude through the Anthropic Messages API (`POST /v1/messages`), the default provider.

use serde::Deserialize;
use serde_json::json;

use super::provider::{Completion, Prepared, Provider, Role, Stop, Usage, WireRequest, join_url};

const VERSION: &str = "2023-06-01";

pub struct Anthropic;

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    content: Vec<Block>,
    stop_reason: Option<String>,
    usage: Option<Counts>,
}

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct Counts {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

impl Provider for Anthropic {
    fn default_endpoint(&self) -> &'static str {
        "https://api.anthropic.com"
    }

    fn default_model(&self) -> Option<&'static str> {
        Some("claude-sonnet-5-5")
    }

    fn build(&self, endpoint: &str, model: &str, key: &str, request: &Prepared) -> WireRequest {
        let messages: Vec<_> = request
            .messages
            .iter()
            .map(|m| {
                let role = match m.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                };
                json!({ "role": role, "content": m.content })
            })
            .collect();
        let mut body = json!({
            "model": model,
            "max_tokens": request.max_tokens,
            "messages": messages,
        });
        if let Some(system) = request.system {
            body["system"] = json!(system);
        }
        WireRequest {
            url: join_url(endpoint, "v1/messages"),
            headers: vec![
                ("x-api-key", key.to_string()),
                ("anthropic-version", VERSION.to_string()),
                ("content-type", "application/json".to_string()),
            ],
            body: body.to_string().into_bytes(),
        }
    }

    fn parse(&self, body: &[u8]) -> Result<Completion, &'static str> {
        let response: Response =
            serde_json::from_slice(body).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        let stop = match response.stop_reason.as_deref() {
            Some("end_turn" | "stop_sequence") => Stop::End,
            Some("max_tokens") => Stop::MaxTokens,
            Some("refusal") => return Err("E_AI_REFUSED"),
            Some(_) => Stop::Other,
            None => return Err("E_AI_RESPONSE_INVALID"),
        };
        let text: String = response
            .content
            .iter()
            .filter(|b| b.kind == "text")
            .filter_map(|b| b.text.as_deref())
            .collect();
        let usage = response.usage.and_then(|u| {
            Some(Usage {
                input_tokens: u.input_tokens?,
                output_tokens: u.output_tokens?,
            })
        });
        Ok(Completion { text, stop, usage })
    }
}
