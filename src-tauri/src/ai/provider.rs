//! A provider only maps requests and answers; it never sends anything itself.

use serde::{Deserialize, Serialize};

pub const DEFAULT_MAX_TOKENS: u32 = 4096;
pub const MAX_MAX_TOKENS: u32 = 32_000;
pub const MAX_MESSAGES: usize = 100;
/// The system prompt and every message together.
pub const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_MODEL_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Anthropic,
    Openai,
}

impl ProviderId {
    pub const ALL: [ProviderId; 2] = [ProviderId::Anthropic, ProviderId::Openai];

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Anthropic => "anthropic",
            ProviderId::Openai => "openai",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// What a caller asks for. `provider` is the active one when absent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRequest {
    #[serde(default)]
    pub provider: Option<ProviderId>,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    End,
    MaxTokens,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub text: String,
    pub stop: Stop,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub provider: ProviderId,
    pub model: String,
    pub text: String,
    pub stop: Stop,
    pub usage: Option<Usage>,
}

/// A request ready to send. It holds the key in a header, so it is never logged or shown.
pub struct WireRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

pub struct Prepared<'a> {
    pub system: Option<&'a str>,
    pub messages: &'a [Message],
    pub max_tokens: u32,
}

pub trait Provider: Sync {
    fn default_endpoint(&self) -> &'static str;
    /// None when the user has to name a model.
    fn default_model(&self) -> Option<&'static str>;
    fn build(&self, endpoint: &str, model: &str, key: &str, request: &Prepared) -> WireRequest;
    /// The status is 2xx; any other status is `status_error`'s.
    fn parse(&self, body: &[u8]) -> Result<Completion, &'static str>;
}

pub fn provider(id: ProviderId) -> &'static dyn Provider {
    match id {
        ProviderId::Anthropic => &super::anthropic::Anthropic,
        ProviderId::Openai => &super::openai::OpenAi,
    }
}

pub fn check_request(request: &GenerateRequest) -> Result<Prepared<'_>, &'static str> {
    let messages = &request.messages;
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err("E_AI_REQUEST_INVALID");
    }
    // Every provider needs the conversation to start with the user.
    if messages[0].role != Role::User || messages.iter().any(|m| m.content.trim().is_empty()) {
        return Err("E_AI_REQUEST_INVALID");
    }
    let system = request.system.as_deref().filter(|s| !s.trim().is_empty());
    let bytes =
        system.map_or(0, str::len) + messages.iter().map(|m| m.content.len()).sum::<usize>();
    if bytes > MAX_INPUT_BYTES {
        return Err("E_AI_REQUEST_TOO_LARGE");
    }
    let max_tokens = request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    if !(1..=MAX_MAX_TOKENS).contains(&max_tokens) {
        return Err("E_AI_REQUEST_INVALID");
    }
    Ok(Prepared {
        system,
        messages,
        max_tokens,
    })
}

/// The code for a non-2xx answer. Never the body: it can quote the prompt.
pub fn status_error(status: u16) -> &'static str {
    match status {
        401 | 403 => "E_AI_AUTH_FAILED",
        404 => "E_AI_NOT_FOUND",
        429 => "E_AI_RATE_LIMITED",
        400 | 413 | 422 => "E_AI_REQUEST_REJECTED",
        500..=599 => "E_AI_PROVIDER_UNAVAILABLE",
        _ => "E_AI_HTTP",
    }
}

/// `base` plus `path`, one slash between.
pub fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}
