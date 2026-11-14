//! Claude through the Anthropic Messages API (`POST /v1/messages`), the default provider.

use serde::Deserialize;
use serde_json::json;

use super::provider::{
    Completion, Partial, Prepared, Provider, Role, Stop, Usage, WireRequest, join_url,
};

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

/// One event of a streamed message; only the fields a provider-agnostic answer needs.
#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    message: Option<Started>,
    delta: Option<Delta>,
    usage: Option<Counts>,
    error: Option<Failure>,
}

#[derive(Deserialize)]
struct Started {
    usage: Option<Counts>,
}

#[derive(Deserialize)]
struct Delta {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct Failure {
    #[serde(rename = "type")]
    kind: Option<String>,
}

fn stop_of(reason: &str) -> Result<Stop, &'static str> {
    match reason {
        "end_turn" | "stop_sequence" => Ok(Stop::End),
        "max_tokens" => Ok(Stop::MaxTokens),
        "refusal" => Err("E_AI_REFUSED"),
        _ => Ok(Stop::Other),
    }
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
        if request.stream {
            body["stream"] = json!(true);
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
        let stop = stop_of(
            response
                .stop_reason
                .as_deref()
                .ok_or("E_AI_RESPONSE_INVALID")?,
        )?;
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

    fn event(&self, data: &str, into: &mut Partial) -> Result<String, &'static str> {
        let event: Event = serde_json::from_str(data).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        match event.kind.as_str() {
            "message_start" => {
                if let Some(counts) = event.message.and_then(|m| m.usage) {
                    into.input_tokens = counts.input_tokens;
                }
            }
            "content_block_delta" => {
                if let Some(Delta {
                    kind: Some(kind),
                    text: Some(text),
                    ..
                }) = event.delta
                    && kind == "text_delta"
                {
                    into.text.push_str(&text);
                    return Ok(text);
                }
            }
            "message_delta" => {
                if let Some(reason) = event.delta.and_then(|d| d.stop_reason) {
                    into.stop = Some(stop_of(&reason)?);
                }
                if let Some(counts) = event.usage {
                    into.output_tokens = counts.output_tokens.or(into.output_tokens);
                    into.input_tokens = counts.input_tokens.or(into.input_tokens);
                }
            }
            "message_stop" => into.ended = true,
            "error" => {
                return Err(match event.error.and_then(|e| e.kind).as_deref() {
                    Some("overloaded_error" | "api_error") => "E_AI_PROVIDER_UNAVAILABLE",
                    Some("rate_limit_error") => "E_AI_RATE_LIMITED",
                    _ => "E_AI_FAILED",
                });
            }
            _ => {}
        }
        Ok(String::new())
    }
}
