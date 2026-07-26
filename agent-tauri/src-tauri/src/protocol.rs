//! Wire protocol types and pure helpers for the Lemniscate device tunnel.
//! Shares a contract-fixture suite with agent/lib.js and the backend — see
//! tests/contract/device-ws/ (embedded in the test module below via include_str!).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::capabilities::Capabilities;

pub const AGENT_VERSION: &str = "0.2.2";

/// Server close code meaning "device token rejected — pair again".
pub const CLOSE_CODE_RE_PAIR: u16 = 4001;

pub const COMMAND_TYPES: [&str; 5] =
    ["run_web", "install_apk", "build_android", "run_desktop", "run_ios"];

/// Device metadata sent in the claim body and the WS hello.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub agent_version: String,
    pub docker_available: bool,
}

/// A parsed inbound server frame.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMessage {
    Welcome { device_id: String },
    Command { id: String, command_type: String, payload: Value },
}

/// Outbound agent frames; serialized as `{type, ...}` JSON.
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello { meta: Meta },
    #[serde(rename = "heartbeat")]
    Heartbeat,
    #[serde(rename = "capabilities")]
    Capabilities { capabilities: Capabilities },
    #[serde(rename = "command_result")]
    CommandResult {
        id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
    },
}

/// Parse a raw server frame; `None` for garbage, unknown types, missing payload.
pub fn parse_server_message(raw: &str) -> Option<ServerMessage> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let msg_type = value.get("type")?.as_str()?;
    if msg_type == "welcome" {
        let device_id = string_field(&value, "deviceId");
        return Some(ServerMessage::Welcome { device_id });
    }
    if !COMMAND_TYPES.contains(&msg_type) {
        return None;
    }
    let payload = value.get("payload")?.clone();
    Some(ServerMessage::Command {
        id: string_field(&value, "id"),
        command_type: msg_type.to_string(),
        payload,
    })
}

fn string_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Build a `command_result` frame; `result` is omitted entirely when `None`.
pub fn command_result_message(id: &str, status: &str, result: Option<Value>) -> ClientMessage {
    ClientMessage::CommandResult {
        id: id.to_string(),
        status: status.to_string(),
        result,
    }
}

/// http(s) server base URL → ws(s) device-tunnel URL for a device token.
pub fn build_ws_url(server: &str, token: &str) -> Option<String> {
    let mut url = url::Url::parse(server).ok()?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).ok()?;
    let path = format!("{}/api/devices/ws", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url.set_query(Some(&format!("token={}", percent_encode(token))));
    url.set_fragment(None);
    Some(url.to_string())
}

/// Percent-encode like encodeURIComponent (unreserved chars pass through).
pub(crate) fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Directory name under the repos root for one repo URL. Deterministic.
pub fn repo_dir_name(repo_url: &str) -> String {
    format!("{}-{}", slugify_repo_url(repo_url), short_hash(repo_url))
}

/// Slug for a repo URL: host+path, lowercase, alnum-and-dash only.
pub fn slugify_repo_url(repo_url: &str) -> String {
    let text = match url::Url::parse(repo_url) {
        Ok(parsed) => format!("{}{}", parsed.host_str().unwrap_or_default(), parsed.path()),
        Err(_) => repo_url.to_string(),
    };
    let slug = slug(&text);
    if slug.is_empty() { "repo".to_string() } else { slug }
}

fn slug(text: &str) -> String {
    let trimmed = strip_git_suffix(text).to_lowercase();
    let mut out = String::with_capacity(trimmed.len());
    let mut last_was_dash = true; // suppress leading dashes
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    let capped: String = out.chars().take(48).collect();
    capped.trim_end_matches('-').to_string()
}

fn strip_git_suffix(text: &str) -> &str {
    if text.to_lowercase().ends_with(".git") {
        return &text[..text.len() - 4];
    }
    text
}

/// Short stable hash distinguishing repos whose slugs collide.
pub fn short_hash(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest[..4].iter().map(|b| format!("{:02x}", b)).collect()
}

/// Tail of a build/run log, capped so command results stay small.
pub fn tail_log(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- build_ws_url (mirrors buildWsUrl tests in agent/lib.test.js) ---------

    #[test]
    fn ws_url_converts_https_to_wss() {
        assert_eq!(
            build_ws_url("https://lemniscate.grig-teo.space", "tok123").unwrap(),
            "wss://lemniscate.grig-teo.space/api/devices/ws?token=tok123"
        );
    }

    #[test]
    fn ws_url_converts_http_to_ws() {
        assert_eq!(
            build_ws_url("http://localhost:3000", "tok123").unwrap(),
            "ws://localhost:3000/api/devices/ws?token=tok123"
        );
    }

    #[test]
    fn ws_url_strips_trailing_slashes() {
        assert_eq!(
            build_ws_url("https://x.space/", "t").unwrap(),
            "wss://x.space/api/devices/ws?token=t"
        );
    }

    #[test]
    fn ws_url_preserves_custom_ports() {
        assert_eq!(
            build_ws_url("https://x.space:8443", "t").unwrap(),
            "wss://x.space:8443/api/devices/ws?token=t"
        );
    }

    #[test]
    fn ws_url_encodes_the_token() {
        assert_eq!(
            build_ws_url("https://x.space", "a b+c/d=").unwrap(),
            "wss://x.space/api/devices/ws?token=a%20b%2Bc%2Fd%3D"
        );
    }

    // --- repo dir naming -------------------------------------------------------

    #[test]
    fn repo_dir_name_is_deterministic() {
        let url = "https://github.com/grig/lemniscate.git";
        assert_eq!(repo_dir_name(url), repo_dir_name(url));
    }

    #[test]
    fn repo_dir_name_slugifies_host_and_path_and_strips_git() {
        let name = repo_dir_name("https://github.com/Grig/Lemniscate.git");
        assert!(name.starts_with("github-com-grig-lemniscate-"), "got {name}");
        assert_eq!(name.len(), "github-com-grig-lemniscate-".len() + 8);
    }

    #[test]
    fn repo_dir_name_differs_for_same_slug_tail() {
        assert_ne!(
            repo_dir_name("https://github.com/a/app"),
            repo_dir_name("https://github.com/b/app")
        );
    }

    #[test]
    fn repo_dir_name_handles_scp_like_urls() {
        let name = repo_dir_name("git@github.com:grig/lemniscate.git");
        assert!(name.starts_with("git-github-com-grig-lemniscate-"), "got {name}");
    }

    // --- shared contract fixtures (tests/contract/device-ws/) ------------------
    // The same JSON files are decoded by the backend (devices-ws.test.ts) and
    // the Node agent (agent/lib.test.js).  Embedded at compile time so a
    // missing or renamed fixture fails the build.

    const HELLO_FIXTURE: &str = include_str!("../../../tests/contract/device-ws/hello.json");
    const HEARTBEAT_FIXTURE: &str = include_str!("../../../tests/contract/device-ws/heartbeat.json");
    const CAPABILITIES_FIXTURE: &str = include_str!("../../../tests/contract/device-ws/capabilities.json");
    const CMD_RESULT_RUNNING_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-result-running.json");
    const CMD_RESULT_DONE_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-result-done.json");
    const CMD_RESULT_FAILED_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-result-failed.json");
    const WELCOME_FIXTURE: &str = include_str!("../../../tests/contract/device-ws/welcome.json");
    const CMD_RUN_WEB_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-run-web.json");
    const CMD_INSTALL_APK_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-install-apk.json");
    const CMD_BUILD_ANDROID_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-build-android.json");
    const CMD_RUN_DESKTOP_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-run-desktop.json");
    const CMD_RUN_IOS_FIXTURE: &str =
        include_str!("../../../tests/contract/device-ws/command-run-ios.json");
    const CLOSE_4001_FIXTURE: &str = include_str!("../../../tests/contract/device-ws/close-4001.json");

    /// Extract the `frame` object from a fixture wrapper.
    fn fixture_frame(raw: &str) -> Value {
        let wrapper: Value = serde_json::from_str(raw).expect("fixture must be valid JSON");
        wrapper.get("frame").expect("fixture must have a frame key").clone()
    }

    // -- client-to-server: serialize a ClientMessage and compare to the fixture --

    #[test]
    fn hello_fixture_matches_serialization() {
        let frame = fixture_frame(HELLO_FIXTURE);
        let meta: Meta = serde_json::from_value(frame["meta"].clone()).unwrap();
        let serialized = serde_json::to_value(ClientMessage::Hello { meta }).unwrap();
        assert_eq!(serialized, frame);
    }

    #[test]
    fn heartbeat_fixture_matches_serialization() {
        let frame = fixture_frame(HEARTBEAT_FIXTURE);
        assert_eq!(serde_json::to_value(ClientMessage::Heartbeat).unwrap(), frame);
    }

    #[test]
    fn capabilities_fixture_matches_serialization() {
        let frame = fixture_frame(CAPABILITIES_FIXTURE);
        let caps: Capabilities = serde_json::from_value(frame["capabilities"].clone()).unwrap();
        let serialized =
            serde_json::to_value(ClientMessage::Capabilities { capabilities: caps }).unwrap();
        assert_eq!(serialized, frame);
    }

    #[test]
    fn command_result_fixtures_match_serialization() {
        let cases = [
            ("running", CMD_RESULT_RUNNING_FIXTURE),
            ("done", CMD_RESULT_DONE_FIXTURE),
            ("failed", CMD_RESULT_FAILED_FIXTURE),
        ];
        for (label, raw) in cases {
            let frame = fixture_frame(raw);
            let result = frame.get("result").cloned();
            let msg = command_result_message(
                frame["id"].as_str().unwrap(),
                frame["status"].as_str().unwrap(),
                result,
            );
            assert_eq!(serde_json::to_value(msg).unwrap(), frame, "fixture: {label}");
        }
    }

    // -- server-to-client: parse through parse_server_message and verify fields --

    #[test]
    fn welcome_fixture_parses() {
        let frame = fixture_frame(WELCOME_FIXTURE);
        // deviceId is hardcoded — catches a field rename that a
        // pure round-trip through the fixture would miss.
        match parse_server_message(&frame.to_string()) {
            Some(ServerMessage::Welcome { device_id }) => {
                assert_eq!(device_id, "dev-abc123");
            }
            other => panic!("expected Welcome, got {other:?}"),
        }
    }

    #[test]
    fn all_command_fixtures_parse() {
        // One key payload field per command type — the field name is
        // hardcoded so a rename in the fixture (e.g. port -> portNumber)
        // causes payload.get(key) to return None and fail the assertion.
        let commands: [(&str, &str, &str); 5] = [
            ("run_web", CMD_RUN_WEB_FIXTURE, "port"),
            ("install_apk", CMD_INSTALL_APK_FIXTURE, "apkUrl"),
            ("build_android", CMD_BUILD_ANDROID_FIXTURE, "gradleTask"),
            ("run_desktop", CMD_RUN_DESKTOP_FIXTURE, "startScript"),
            ("run_ios", CMD_RUN_IOS_FIXTURE, "scheme"),
        ];
        for (expected_type, raw, payload_key) in commands {
            let frame = fixture_frame(raw);
            match parse_server_message(&frame.to_string()) {
                Some(ServerMessage::Command { command_type, payload, .. }) => {
                    assert_eq!(command_type, expected_type, "{expected_type}: type");
                    assert!(payload.get(payload_key).is_some(),
                           "{expected_type}: payload must have key '{payload_key}'");
                }
                other => panic!("expected Command for {expected_type}, got {other:?}"),
            }
        }
    }

    #[test]
    fn rejects_garbage_and_unknown_types() {
        assert_eq!(parse_server_message("not json"), None);
        assert_eq!(parse_server_message(r#"{"type":"mystery"}"#), None);
        assert_eq!(parse_server_message("{}"), None);
        assert_eq!(parse_server_message(r#"{"type":"run_web"}"#), None);
    }

    // -- close code fixture -------------------------------------------------------

    #[test]
    fn close_4001_fixture_documents_token_rejection() {
        let wrapper: Value = serde_json::from_str(CLOSE_4001_FIXTURE).unwrap();
        assert_eq!(wrapper["direction"], "close");
        assert_eq!(wrapper["closeCode"], 4001);
        assert_eq!(wrapper["reason"], "invalid device token");
        assert_eq!(CLOSE_CODE_RE_PAIR, 4001);
    }

    // --- tail_log --------------------------------------------------------------------

    #[test]
    fn tail_log_caps_long_logs_at_the_tail() {
        let text = "x".repeat(3000);
        assert_eq!(tail_log(&text, 2048).len(), 2048);
        assert_eq!(tail_log("short", 2048), "short");
    }

    #[test]
    fn tail_log_respects_utf8_boundaries() {
        let text = "é".repeat(2000); // 2 bytes each
        let tail = tail_log(&text, 2048);
        assert!(tail.len() <= 2048);
        assert_eq!(tail.len() % 2, 0);
    }
}
