use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{sleep, timeout, Duration};

use crate::daemon::{daemon_socket_path, DaemonClient};

const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

pub struct ServeOptions {
    pub on: Option<String>,
    pub exec: Option<String>,
    pub handlers: Option<String>,
    pub allow_from: Vec<String>,
    pub public: bool,
    pub max_concurrency: usize,
    pub timeout_secs: u64,
    pub format: String,
}

struct HandlerEntry {
    capability: String,
    exec: PathBuf,
}

pub async fn run(opts: ServeOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());
    if !daemon.is_running().await {
        bail!("Daemon not running. Start with: a4 listen --background");
    }

    let handlers = build_handlers(&opts)?;
    if handlers.is_empty() {
        bail!("No handlers specified. Use --on/--exec or --handlers <dir>");
    }

    if !opts.public {
        for did in &opts.allow_from {
            daemon
                .send_command(
                    "allowlist",
                    json!({
                        "action": "add",
                        "did": did,
                        "note": "a4 serve --allow-from",
                    }),
                )
                .await?;
        }
    }

    if opts.format != "json" {
        println!("\nServing {} handler(s):", handlers.len());
        for handler in &handlers {
            println!("  {} -> {}", handler.capability, handler.exec.display());
        }
        println!(
            "\nMax concurrency: {}, timeout: {}s",
            opts.max_concurrency, opts.timeout_secs
        );
        println!("Waiting for requests... (Ctrl+C to stop)\n");
    }

    let handlers = Arc::new(handlers);
    let active_count = Arc::new(AtomicUsize::new(0));

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                if opts.format != "json" {
                    println!("\nStopped serving.");
                }
                return Ok(());
            }
            _ = sleep(Duration::from_millis(500)) => {
                poll_once(
                    &daemon,
                    handlers.clone(),
                    active_count.clone(),
                    opts.max_concurrency,
                    opts.timeout_secs,
                    opts.format.as_str(),
                ).await?;
            }
        }
    }
}

fn build_handlers(opts: &ServeOptions) -> Result<Vec<HandlerEntry>> {
    let mut handlers = Vec::new();

    if let (Some(capability), Some(exec)) = (opts.on.as_ref(), opts.exec.as_ref()) {
        handlers.push(HandlerEntry {
            capability: capability.clone(),
            exec: PathBuf::from(exec),
        });
    }

    if let Some(dir) = &opts.handlers {
        for entry in std::fs::read_dir(dir).with_context(|| format!("Failed to read {}", dir))? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let capability = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            if capability.is_empty() {
                continue;
            }
            handlers.push(HandlerEntry {
                capability,
                exec: path,
            });
        }
    }

    Ok(handlers)
}

async fn poll_once(
    daemon: &DaemonClient,
    handlers: Arc<Vec<HandlerEntry>>,
    active_count: Arc<AtomicUsize>,
    max_concurrency: usize,
    timeout_secs: u64,
    format: &str,
) -> Result<()> {
    let page = daemon
        .send_command(
            "inbox",
            json!({
                "limit": 10,
                "unread": true,
                "pagination": { "limit": 10 },
                "filter": {
                    "unreadOnly": true,
                    "status": "pending",
                    "type": "message",
                },
            }),
        )
        .await?;
    let messages = page
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    for message in messages {
        if message.get("direction").and_then(|value| value.as_str()) != Some("inbound") {
            continue;
        }

        let envelope = message.get("envelope").cloned().unwrap_or(Value::Null);
        if envelope.get("type").and_then(|value| value.as_str()) != Some("message") {
            continue;
        }

        let protocol = envelope
            .get("protocol")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);

        let Some(handler) = handlers.iter().find(|entry| {
            protocol.contains(&entry.capability)
                || payload.get("capability").and_then(|value| value.as_str())
                    == Some(entry.capability.as_str())
        }) else {
            continue;
        };

        let envelope_id = envelope
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !envelope_id.is_empty() {
            let _ = daemon
                .send_command("mark_read", json!({ "id": envelope_id }))
                .await;
        }

        let current = active_count.load(Ordering::SeqCst);
        if current >= max_concurrency {
            if format != "json" {
                eprintln!(
                    "[BUSY] Rejected {} from {}",
                    envelope_id,
                    envelope
                        .get("from")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown"),
                );
            }
            send_reply(
                daemon,
                &envelope,
                json!({ "error": "BUSY", "message": "Server at capacity, try again later" }),
            )
            .await?;
            continue;
        }

        let payload_str = serde_json::to_string(&payload)?;
        if payload_str.len() > MAX_PAYLOAD_BYTES {
            send_reply(
                daemon,
                &envelope,
                json!({
                    "error": "PAYLOAD_TOO_LARGE",
                    "message": format!("Max payload is {} bytes", MAX_PAYLOAD_BYTES),
                }),
            )
            .await?;
            continue;
        }

        active_count.fetch_add(1, Ordering::SeqCst);
        let daemon = DaemonClient::new(&daemon_socket_path());
        let envelope_clone = envelope.clone();
        let exec_path = handler.exec.clone();
        let capability = handler.capability.clone();
        let from = envelope
            .get("from")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string();
        let active_count = active_count.clone();
        let format = format.to_string();

        if format != "json" {
            println!(
                "[{}] {} <- {}",
                chrono::Local::now().format("%H:%M:%S"),
                capability,
                from
            );
        }

        tokio::spawn(async move {
            let started_at = std::time::Instant::now();
            let result = execute_handler(&exec_path, &payload, timeout_secs).await;
            let latency_ms = started_at.elapsed().as_millis();

            match result {
                Ok(reply_payload) => {
                    let _ = send_reply(&daemon, &envelope_clone, reply_payload).await;
                    if format == "json" {
                        println!(
                            "{}",
                            json!({
                                "event": "handled",
                                "capability": capability,
                                "from": envelope_clone.get("from").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "latencyMs": latency_ms,
                                "success": true,
                            })
                        );
                    } else {
                        println!("  -> responded in {}ms", latency_ms);
                    }
                }
                Err(error) => {
                    let is_timeout = error.to_string().contains("timeout");
                    let _ = send_reply(
                        &daemon,
                        &envelope_clone,
                        json!({
                            "error": if is_timeout { "TIMEOUT" } else { "HANDLER_ERROR" },
                            "message": error.to_string(),
                        }),
                    )
                    .await;
                    if format == "json" {
                        println!(
                            "{}",
                            json!({
                                "event": "error",
                                "capability": capability,
                                "from": envelope_clone.get("from").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "latencyMs": latency_ms,
                                "error": error.to_string(),
                            })
                        );
                    } else {
                        eprintln!("  -> error after {}ms: {}", latency_ms, error);
                    }
                }
            }

            active_count.fetch_sub(1, Ordering::SeqCst);
        });
    }

    Ok(())
}

async fn execute_handler(script_path: &Path, payload: &Value, timeout_secs: u64) -> Result<Value> {
    let mut child = Command::new(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Failed to execute handler {}", script_path.display()))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(serde_json::to_string(payload)?.as_bytes())
            .await?;
    }
    child.stdin.take();

    let output = timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| anyhow::anyhow!("Handler timeout after {}ms", timeout_secs * 1000))??;

    if !output.status.success() {
        bail!(
            "Handler exited with code {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim(),
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!({ "result": "" }));
    }

    Ok(serde_json::from_str(&stdout).unwrap_or_else(|_| json!({ "result": stdout })))
}

async fn send_reply(daemon: &DaemonClient, envelope: &Value, payload: Value) -> Result<()> {
    let mut params = json!({
        "to": envelope.get("from").and_then(|value| value.as_str()).unwrap_or(""),
        "protocol": envelope.get("protocol").and_then(|value| value.as_str()).unwrap_or("/agent/msg/1.0.0"),
        "payload": payload,
        "type": "reply",
        "replyTo": envelope.get("id").and_then(|value| value.as_str()).unwrap_or(""),
    });

    if let Some(thread_id) = envelope.get("threadId").and_then(|value| value.as_str()) {
        params["threadId"] = json!(thread_id);
    }

    daemon.send_command("send", params).await?;
    Ok(())
}
