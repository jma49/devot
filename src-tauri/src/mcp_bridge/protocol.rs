//! MCP over stdio: JSON-RPC 2.0 messages, one a line. A tool call may wait for Devot to start, so it
//! runs on a thread of its own, one at a time, and `ping` is answered meanwhile.

use std::io::{BufRead, Read, Write};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::tools::{SERVER_INSTRUCTIONS, SERVER_NAME, Tools};

/// A whole note (1 MiB of Markdown) escaped as JSON, with room to spare; a longer line is refused.
const MAX_LINE_BYTES: u64 = 8 * 1024 * 1024;
const LATEST_PROTOCOL: &str = "2025-11-25";
const PROTOCOLS: [&str; 5] = [
    LATEST_PROTOCOL,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// Cut to what the app records (`cleanWriterName`, `routes::client`).
pub(crate) fn clean_client_name(name: &str) -> String {
    let line: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars()
        .take(crate::http_api::routes::MAX_CLIENT_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialized(id: &Value, params: &Value, version: &str) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let protocol = asked
        .filter(|asked| PROTOCOLS.contains(asked))
        .unwrap_or(LATEST_PROTOCOL);
    result(
        id,
        json!({
            "protocolVersion": protocol,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": version },
            "instructions": SERVER_INSTRUCTIONS,
        }),
    )
}

/// One line, without its end; `None` at the end of input. A line over the limit reads as `Err` and
/// is passed over whole.
fn read_line(input: &mut impl BufRead, limit: u64) -> Option<Result<Vec<u8>, ()>> {
    let mut line = Vec::new();
    let read = input
        .by_ref()
        .take(limit + 1)
        .read_until(b'\n', &mut line)
        .ok()?;
    if read == 0 {
        return None;
    }
    if line.last() != Some(&b'\n') && line.len() as u64 > limit {
        loop {
            let mut rest = Vec::new();
            let read = input
                .by_ref()
                .take(limit)
                .read_until(b'\n', &mut rest)
                .ok()?;
            if read == 0 || rest.last() == Some(&b'\n') {
                return Some(Err(()));
            }
        }
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Some(Ok(line))
}

fn send(output: &Mutex<impl Write>, message: &Value) {
    let Ok(mut output) = output.lock() else {
        return;
    };
    let Ok(mut bytes) = serde_json::to_vec(message) else {
        return;
    };
    bytes.push(b'\n');
    // A client that has gone away closes stdin too, which ends the loop.
    let _ = output.write_all(&bytes).and_then(|()| output.flush());
}

/// Answers messages until `input` ends and the tool calls already asked for have answered.
pub fn serve<R, W>(
    mut input: R,
    output: W,
    tools: Tools,
    client: Arc<Mutex<String>>,
    version: &str,
    log: &(dyn Fn(&str) + Sync),
) where
    R: BufRead,
    W: Write + Send,
{
    let output = Mutex::new(output);
    let tool_list = tools.list();
    let (calls, queue) = channel::<(Value, String, Value)>();
    std::thread::scope(|scope| {
        let output = &output;
        scope.spawn(move || {
            for (id, name, args) in queue {
                let answer = tools.call(&name, args, log);
                send(output, &result(&id, answer));
            }
        });
        while let Some(line) = read_line(&mut input, MAX_LINE_BYTES) {
            let Ok(line) = line else {
                send(
                    output,
                    &error(&Value::Null, PARSE_ERROR, "Message too long"),
                );
                continue;
            };
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                send(output, &error(&Value::Null, PARSE_ERROR, "Parse error"));
                continue;
            };
            let Some(request) = message.as_object() else {
                send(
                    output,
                    &error(&Value::Null, INVALID_REQUEST, "Invalid request"),
                );
                continue;
            };
            // A notification, or an answer to something this server never asks.
            let (Some(id), Some(method)) = (
                request.get("id"),
                request.get("method").and_then(Value::as_str),
            ) else {
                continue;
            };
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            match method {
                "initialize" => {
                    let name = params
                        .pointer("/clientInfo/name")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if let Ok(mut client) = client.lock() {
                        *client = clean_client_name(name);
                    }
                    send(output, &initialized(id, &params, version));
                }
                "ping" => send(output, &result(id, json!({}))),
                "tools/list" => send(output, &result(id, json!({ "tools": &tool_list }))),
                "tools/call" => {
                    let Some(name) = params.get("name").and_then(Value::as_str) else {
                        send(
                            output,
                            &error(id, INVALID_PARAMS, "A tool name is required"),
                        );
                        continue;
                    };
                    let args = params
                        .get("arguments")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    if calls.send((id.clone(), name.to_owned(), args)).is_err() {
                        return;
                    }
                }
                _ => send(output, &error(id, METHOD_NOT_FOUND, "Method not found")),
            }
        }
        drop(calls);
    });
}

#[cfg(test)]
mod tests {
    use super::super::tools::{Api, ApiRequest};
    use super::*;
    use std::io::Cursor;

    #[derive(Default, Clone)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Listing;

    impl Api for Listing {
        fn call(&self, _: &ApiRequest) -> Result<Value, String> {
            Ok(json!({ "notebooks": [{ "id": "b", "name": "N", "notes": 1 }] }))
        }
    }

    fn talk(lines: &str) -> (Vec<Value>, String) {
        let sink = Sink::default();
        let client = Arc::new(Mutex::new(String::new()));
        serve(
            Cursor::new(lines.as_bytes().to_vec()),
            sink.clone(),
            Tools::new(Box::new(Listing)),
            Arc::clone(&client),
            "1.2.3",
            &|_: &str| {},
        );
        let bytes = sink.0.lock().unwrap().clone();
        let text = String::from_utf8(bytes).unwrap();
        let mut answers: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).expect("stdout holds only MCP messages"))
            .collect();
        answers.sort_by_key(|answer| answer["id"].as_i64().unwrap_or(-1));
        (answers, client.lock().unwrap().clone())
    }

    #[test]
    fn introduces_itself_and_remembers_the_clients_name() {
        let (answers, name) = talk(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"Claude\\nCode\",\"version\":\"9\"}}}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        );
        assert_eq!(answers.len(), 1, "a notification has no answer");
        let result = &answers[0]["result"];
        assert_eq!(result["protocolVersion"], "2025-06-18");
        assert_eq!(result["serverInfo"]["name"], "devot");
        assert_eq!(result["serverInfo"]["version"], "1.2.3");
        assert!(result["capabilities"]["tools"].is_object());
        assert!(
            result["instructions"]
                .as_str()
                .unwrap()
                .contains("Allow AI Access")
        );
        assert_eq!(name, "Claude Code");
    }

    #[test]
    fn answers_a_protocol_it_does_not_know_with_its_latest() {
        let (answers, _) = talk(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"1999-01-01\"}}\n",
        );
        assert_eq!(answers[0]["result"]["protocolVersion"], LATEST_PROTOCOL);
    }

    #[test]
    fn lists_the_tools_and_calls_one_and_answers_ping() {
        let (answers, _) = talk(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"list_notebooks\"}}\n",
        );
        assert_eq!(answers[0]["result"]["tools"].as_array().unwrap().len(), 9);
        assert_eq!(answers[1]["result"], json!({}));
        let text = answers[2]["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("\"notebooks\""));
        assert_eq!(answers[2]["result"].get("isError"), None);
    }

    #[test]
    fn refuses_what_it_cannot_read_and_stays_up() {
        let (answers, _) = talk(
            "not json\n[1]\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"nope\"}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{}}\n\n{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}\n",
        );
        let codes: Vec<i64> = answers
            .iter()
            .filter_map(|answer| answer["error"]["code"].as_i64())
            .collect();
        assert_eq!(
            codes,
            [
                PARSE_ERROR,
                INVALID_REQUEST,
                METHOD_NOT_FOUND,
                INVALID_PARAMS
            ]
        );
        assert_eq!(answers.last().unwrap()["result"], json!({}));
    }

    #[test]
    fn passes_over_a_line_that_is_too_long_whole() {
        let mut input = Cursor::new(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaa\nok\n".to_vec());
        assert_eq!(read_line(&mut input, 4), Some(Err(())));
        assert_eq!(read_line(&mut input, 4), Some(Ok(b"ok".to_vec())));
        assert_eq!(read_line(&mut input, 4), None);
        let mut windows = Cursor::new(b"ok\r\n".to_vec());
        assert_eq!(read_line(&mut windows, 4), Some(Ok(b"ok".to_vec())));
    }

    #[test]
    fn cleans_a_clients_name_as_the_app_records_it() {
        assert_eq!(clean_client_name("  Claude\tCode\n "), "Claude Code");
        assert_eq!(clean_client_name(""), "");
        assert_eq!(clean_client_name(&"x".repeat(200)).chars().count(), 100);
    }
}
