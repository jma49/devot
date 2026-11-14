//! Any server that speaks OpenAI's chat completions API: OpenAI, a gateway or a local model.

use serde::Deserialize;
use serde_json::json;

use super::provider::{
    Completion, Partial, Prepared, Provider, Role, Stop, Usage, WireRequest, join_url,
};

pub struct OpenAi;

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    choices: Vec<Choice>,
    usage: Option<Counts>,
}

#[derive(Deserialize)]
struct Choice {
    message: Option<Reply>,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct Reply {
    content: Option<String>,
    refusal: Option<String>,
}

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<ChunkChoice>,
    usage: Option<Counts>,
}

#[derive(Deserialize)]
struct ChunkChoice {
    delta: Option<Reply>,
    finish_reason: Option<String>,
}

fn stop_of(reason: Option<&str>) -> Stop {
    match reason {
        Some("stop") => Stop::End,
        Some("length") => Stop::MaxTokens,
        _ => Stop::Other,
    }
}

#[derive(Deserialize)]
struct Counts {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

impl Provider for OpenAi {
    fn default_endpoint(&self) -> &'static str {
        "https://api.openai.com/v1"
    }

    fn default_model(&self) -> Option<&'static str> {
        None
    }

    fn build(&self, endpoint: &str, model: &str, key: &str, request: &Prepared) -> WireRequest {
        let system = request
            .system
            .map(|s| json!({ "role": "system", "content": s }));
        let messages: Vec<_> = system
            .into_iter()
            .chain(request.messages.iter().map(|m| {
                let role = match m.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                };
                json!({ "role": role, "content": m.content })
            }))
            .collect();
        let mut body = json!({
            "model": model,
            "max_completion_tokens": request.max_tokens,
            "messages": messages,
        });
        if request.stream {
            body["stream"] = json!(true);
        }
        WireRequest {
            url: join_url(endpoint, "chat/completions"),
            headers: vec![
                ("authorization", format!("Bearer {key}")),
                ("content-type", "application/json".to_string()),
            ],
            body: body.to_string().into_bytes(),
        }
    }

    fn parse(&self, body: &[u8]) -> Result<Completion, &'static str> {
        let response: Response =
            serde_json::from_slice(body).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or("E_AI_RESPONSE_INVALID")?;
        let reply = choice.message.ok_or("E_AI_RESPONSE_INVALID")?;
        let text = match reply.content {
            Some(text) => text,
            None if reply.refusal.is_some() => return Err("E_AI_REFUSED"),
            None => return Err("E_AI_RESPONSE_INVALID"),
        };
        let stop = stop_of(choice.finish_reason.as_deref());
        let usage = response.usage.and_then(|u| {
            Some(Usage {
                input_tokens: u.prompt_tokens?,
                output_tokens: u.completion_tokens?,
            })
        });
        Ok(Completion { text, stop, usage })
    }

    fn event(&self, data: &str, into: &mut Partial) -> Result<String, &'static str> {
        if data.trim() == "[DONE]" {
            into.ended = true;
            return Ok(String::new());
        }
        let chunk: Chunk = serde_json::from_str(data).map_err(|_| "E_AI_RESPONSE_INVALID")?;
        if let Some(counts) = chunk.usage {
            into.input_tokens = counts.prompt_tokens;
            into.output_tokens = counts.completion_tokens;
        }
        let mut added = String::new();
        for choice in chunk.choices.into_iter().take(1) {
            if let Some(reply) = choice.delta {
                if reply.refusal.as_deref().is_some_and(|r| !r.is_empty()) {
                    return Err("E_AI_REFUSED");
                }
                if let Some(text) = reply.content {
                    added.push_str(&text);
                }
            }
            if choice.finish_reason.is_some() {
                into.stop = Some(stop_of(choice.finish_reason.as_deref()));
            }
        }
        into.text.push_str(&added);
        Ok(added)
    }
}
