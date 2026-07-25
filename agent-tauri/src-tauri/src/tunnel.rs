//! Outbound WebSocket tunnel: connect, hello, 25s heartbeat, command
//! dispatch, exponential-backoff reconnect (1s doubling to a 30s cap).
//! Close code 4001 means the server rejected the device token → clear the
//! saved config and stop until the user pairs again.

use futures_util::{SinkExt, Stream, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::commands;
use crate::config::{self, Config};
use crate::protocol::{self, ClientMessage, Meta, ServerMessage};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 30_000;

/// Reconnect-forever driver; returns only when re-pairing is required.
pub async fn run(app: AppHandle, config: Config, meta: Meta) {
    let mut attempt: u32 = 0;
    loop {
        match connect_once(&app, &config, &meta).await {
            CloseReason::Retry => {
                let delay = backoff_delay(attempt);
                attempt = attempt.saturating_add(1);
                tokio::time::sleep(delay).await;
            }
            CloseReason::RePair => {
                crate::set_status(&app, "error", Some("token rejected — pair again with a new code"));
                config::clear(&config::config_path());
                crate::clear_saved_config(&app);
                return;
            }
        }
    }
}

fn backoff_delay(attempt: u32) -> Duration {
    let shift = attempt.min(5); // 1s << 5 = 32s, already past the cap
    Duration::from_millis((BACKOFF_BASE_MS << shift).min(BACKOFF_CAP_MS))
}

enum CloseReason {
    Retry,
    RePair,
}

/// One tunnel session: connect, run until close/error, report how it ended.
async fn connect_once(app: &AppHandle, config: &Config, meta: &Meta) -> CloseReason {
    let Some(url) = protocol::build_ws_url(&config.server, &config.device_token) else {
        crate::set_status(app, "error", Some("invalid server URL in the saved config"));
        return CloseReason::RePair;
    };
    let (socket, _) = match connect_async(&url).await {
        Ok(pair) => pair,
        Err(error) => {
            crate::set_status(app, "error", Some(&format!("tunnel connect failed: {error}")));
            return CloseReason::Retry;
        }
    };
    crate::set_status(app, "connected", Some(&config.server));
    let (mut write, mut read) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ClientMessage>(32);
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let text = serde_json::to_string(&message).unwrap_or_default();
            if write.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    let _ = tx.send(ClientMessage::Hello { meta: meta.clone() }).await;
    let heartbeat = spawn_heartbeat(tx.clone());
    let reason = read_loop(app, config, tx, &mut read).await;
    heartbeat.abort();
    writer.abort();
    crate::set_status(app, "disconnected", None);
    reason
}

fn spawn_heartbeat(tx: mpsc::Sender<ClientMessage>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
        interval.tick().await; // first tick fires immediately — skip it
        loop {
            interval.tick().await;
            if tx.send(ClientMessage::Heartbeat).await.is_err() {
                return;
            }
        }
    })
}

/// Consume server frames until close/error. Commands spawn one task each.
async fn read_loop<S>(
    app: &AppHandle,
    config: &Config,
    tx: mpsc::Sender<ClientMessage>,
    read: &mut S,
) -> CloseReason
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    while let Some(frame) = read.next().await {
        match frame {
            Ok(Message::Text(text)) => handle_text(app, config, &tx, &text),
            Ok(Message::Close(close)) => return close_reason(close),
            Ok(_) => {}
            Err(_) => return CloseReason::Retry,
        }
    }
    CloseReason::Retry
}

fn close_reason(frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>) -> CloseReason {
    if let Some(frame) = frame {
        if u16::from(frame.code) == protocol::CLOSE_CODE_RE_PAIR {
            return CloseReason::RePair;
        }
    }
    CloseReason::Retry
}

fn handle_text(app: &AppHandle, config: &Config, tx: &mpsc::Sender<ClientMessage>, text: &str) {
    match protocol::parse_server_message(text) {
        Some(ServerMessage::Welcome { device_id }) => {
            crate::set_status(app, "connected", Some(&format!("device {device_id}")));
        }
        Some(ServerMessage::Command { id, command_type, payload }) => {
            spawn_command(config, tx, id, command_type, payload);
        }
        None => {}
    }
}

fn spawn_command(
    config: &Config,
    tx: &mpsc::Sender<ClientMessage>,
    id: String,
    command_type: String,
    payload: Value,
) {
    let tx = tx.clone();
    let config = config.clone();
    tokio::spawn(async move {
        commands::execute(tx, config, id, command_type, payload).await;
    });
}
