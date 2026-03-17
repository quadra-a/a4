use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Mutex;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{sleep, timeout, Duration};

use crate::config::{build_card, load_config};
use crate::daemon::{daemon_socket_path, DaemonClient};

const MAX_PAYLOAD_BYTES: usize = 256 * 1024;
const INBOX_POLL_LIMIT: usize = 100;

pub struct ServeOptions {
    pub on: Option<String>,
    pub exec: Option<String>,
    pub exec_args: Vec<String>,
    pub handlers: Option<String>,
    pub allow_from: Vec<String>,
    pub public: bool,
    pub max_concurrency: usize,
    pub timeout_secs: u64,
    pub format: String,
}

#[derive(Debug)]
struct HandlerEntry {
    capability: String,
    exec: PathBuf,
    exec_args: Vec<String>,
}

fn normalize_capability_id(capability: &str) -> String {
    capability.trim().trim_matches('/').to_string()
}

fn capability_protocol(capability: &str) -> String {
    format!("/capability/{}", normalize_capability_id(capability))
}

fn protocol_matches_capability(protocol: &str, capability: &str) -> bool {
    let p = protocol.trim();
    let cap = normalize_capability_id(capability);
    let prefixed = capability_protocol(capability);
    p == prefixed || p == cap
}

fn handler_filename_to_capability(path: &Path) -> Option<String> {
    let capability = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .replace("__", "/");
    let capability = normalize_capability_id(&capability);
    if capability.is_empty() {
        None
    } else {
        Some(capability)
    }
}

fn validate_handlers_against_local_card(
    handlers: &[HandlerEntry],
    card: &crate::protocol::AgentCard,
) -> Result<()> {
    let declared_capabilities = card
        .capabilities
        .iter()
        .map(|capability| normalize_capability_id(&capability.id))
        .collect::<HashSet<_>>();
    if declared_capabilities.is_empty() {
        bail!("Local Agent Card has no declared capabilities. Update it before running serve.");
    }

    let missing = handlers
        .iter()
        .map(|handler| handler.capability.clone())
        .filter(|capability| !declared_capabilities.contains(&normalize_capability_id(capability)))
        .collect::<Vec<_>>();

    if !missing.is_empty() {
        bail!(
            "Serve handlers must match local Agent Card capabilities. Missing: {}",
            missing.join(", ")
        );
    }

    Ok(())
}

fn handler_command_display(handler: &HandlerEntry) -> String {
    if handler.exec_args.is_empty() {
        handler.exec.display().to_string()
    } else {
        format!(
            "{} {}",
            handler.exec.display(),
            handler.exec_args.join(" ")
        )
    }
}

pub async fn run(opts: ServeOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());
    if !daemon.is_running().await {
        bail!("Daemon not running. Start with: a4 listen --background");
    }

    let config = load_config()?;
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `a4 listen` to create one."))?;
    let local_card = build_card(&config, identity)?;
    let handlers = build_handlers(&opts)?;
    if handlers.is_empty() {
        bail!("No handlers specified. Use --on/--exec or --handlers <dir>");
    }
    validate_handlers_against_local_card(&handlers, &local_card)?;

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
            println!(
                "  {} -> {}",
                handler.capability,
                handler_command_display(handler)
            );
        }
        println!(
            "\nMax concurrency: {}, timeout: {}s",
            opts.max_concurrency, opts.timeout_secs
        );
        println!("Waiting for requests... (Ctrl+C to stop)\n");
    }

    let handlers = Arc::new(handlers);
    let active_count = Arc::new(AtomicUsize::new(0));
    let claimed_message_ids = Arc::new(Mutex::new(HashSet::<String>::new()));

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                if opts.format != "json" {
                    println!("\nStopped serving.");
                }
                return Ok(());
            }
            _ = sleep(Duration::from_millis(500)) => {
                if let Err(error) = poll_once(
                    &daemon,
                    handlers.clone(),
                    active_count.clone(),
                    claimed_message_ids.clone(),
                    opts.max_concurrency,
                    opts.timeout_secs,
                    opts.format.as_str(),
                ).await {
                    eprintln!("serve poll warning: {error:#}");
                }
            }
        }
    }
}

fn build_handlers(opts: &ServeOptions) -> Result<Vec<HandlerEntry>> {
    let mut handlers = Vec::new();

    if let (Some(capability), Some(exec)) = (opts.on.as_ref(), opts.exec.as_ref()) {
        if opts.exec_args.is_empty()
            && exec.split_whitespace().nth(1).is_some()
            && !Path::new(exec).exists()
        {
            bail!(
                "`--exec` expects a single program path or name. Pass handler arguments after `--`, for example: a4 serve --on {} --exec python -- gpu_handler.py",
                capability
            );
        }
        handlers.push(HandlerEntry {
            capability: normalize_capability_id(capability),
            exec: PathBuf::from(exec),
            exec_args: opts.exec_args.clone(),
        });
    }

    if let Some(dir) = &opts.handlers {
        for entry in fs::read_dir(dir).with_context(|| format!("Failed to read {}", dir))? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(capability) = handler_filename_to_capability(&path) else {
                continue;
            };
            handlers.push(HandlerEntry {
                capability,
                exec: path,
                exec_args: Vec::new(),
            });
        }
    }

    Ok(handlers)
}

async fn poll_once(
    daemon: &DaemonClient,
    handlers: Arc<Vec<HandlerEntry>>,
    active_count: Arc<AtomicUsize>,
    claimed_message_ids: Arc<Mutex<HashSet<String>>>,
    max_concurrency: usize,
    timeout_secs: u64,
    format: &str,
) -> Result<()> {
    let page = daemon
        .send_command(
            "inbox",
            json!({
                "limit": INBOX_POLL_LIMIT,
                "unread": true,
                "pagination": { "limit": INBOX_POLL_LIMIT },
                "filter": {
                    "direction": "inbound",
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
        let dir = message.get("direction").and_then(|value| value.as_str()).unwrap_or("?");
        if dir != "inbound" {
            continue;
        }

        let envelope = message.get("envelope").cloned().unwrap_or(Value::Null);
        let etype = envelope.get("type").and_then(|value| value.as_str()).unwrap_or("?");
        if etype != "message" {
            continue;
        }

        let protocol = envelope
            .get("protocol")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let payload = envelope.get("payload").cloned().unwrap_or(Value::Null);

        let Some(handler) = handlers.iter().find(|entry| {
            protocol_matches_capability(protocol, &entry.capability)
                || payload.get("capability").and_then(|value| value.as_str())
                    == Some(entry.capability.as_str())
        }) else {
            continue;
        };

        let envelope_id = envelope
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if envelope_id.is_empty() {
            continue;
        }
        if !claim_message(&claimed_message_ids, envelope_id).await {
            continue;
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
            let reply_result = send_reply(
                daemon,
                &envelope,
                json!({ "error": "BUSY", "message": "Server at capacity, try again later" }),
            )
            .await;
            if let Err(error) = reply_result {
                eprintln!("serve busy reply warning for {envelope_id}: {error:#}");
            } else {
                mark_read(daemon, envelope_id).await;
            }
            release_message_claim(&claimed_message_ids, envelope_id).await;
            continue;
        }

        let payload_str = serde_json::to_string(&payload)?;
        if payload_str.len() > MAX_PAYLOAD_BYTES {
            let reply_result = send_reply(
                daemon,
                &envelope,
                json!({
                    "error": "PAYLOAD_TOO_LARGE",
                    "message": format!("Max payload is {} bytes", MAX_PAYLOAD_BYTES),
                }),
            )
            .await;
            if let Err(error) = reply_result {
                eprintln!("serve payload-too-large reply warning for {envelope_id}: {error:#}");
            } else {
                mark_read(daemon, envelope_id).await;
            }
            release_message_claim(&claimed_message_ids, envelope_id).await;
            continue;
        }

        active_count.fetch_add(1, Ordering::SeqCst);
        let daemon = DaemonClient::new(&daemon_socket_path());
        let envelope_clone = envelope.clone();
        let exec_path = handler.exec.clone();
        let exec_args = handler.exec_args.clone();
        let capability = handler.capability.clone();
        let from = envelope
            .get("from")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string();
        let envelope_id = envelope_id.to_string();
        let active_count = active_count.clone();
        let claimed_message_ids = claimed_message_ids.clone();
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
            let result = execute_handler(&exec_path, &exec_args, &payload, timeout_secs).await;
            let latency_ms = started_at.elapsed().as_millis();

            let reply_result = match &result {
                Ok(reply_payload) => {
                    send_reply(&daemon, &envelope_clone, reply_payload.clone()).await
                }
                Err(error) => {
                    let is_timeout = error.to_string().contains("timeout");
                    send_reply(
                        &daemon,
                        &envelope_clone,
                        json!({
                            "error": if is_timeout { "TIMEOUT" } else { "HANDLER_ERROR" },
                            "message": error.to_string(),
                        }),
                    )
                    .await
                }
            };

            match (&result, &reply_result) {
                (Ok(_), Ok(())) => {
                    mark_read(&daemon, &envelope_id).await;
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
                (Err(error), Ok(())) => {
                    mark_read(&daemon, &envelope_id).await;
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
                (Ok(_), Err(error)) => {
                    eprintln!("serve reply warning for {envelope_id}: {error:#}");
                }
                (Err(handler_error), Err(reply_error)) => {
                    eprintln!(
                        "serve handler+reply warning for {envelope_id}: handler={handler_error:#}; reply={reply_error:#}"
                    );
                }
            }

            active_count.fetch_sub(1, Ordering::SeqCst);
            release_message_claim(&claimed_message_ids, &envelope_id).await;
        });
    }

    Ok(())
}

async fn claim_message(claimed_message_ids: &Arc<Mutex<HashSet<String>>>, message_id: &str) -> bool {
    let mut claimed = claimed_message_ids.lock().await;
    claimed.insert(message_id.to_string())
}

async fn release_message_claim(claimed_message_ids: &Arc<Mutex<HashSet<String>>>, message_id: &str) {
    let mut claimed = claimed_message_ids.lock().await;
    claimed.remove(message_id);
}

async fn mark_read(daemon: &DaemonClient, envelope_id: &str) {
    if let Err(error) = daemon
        .send_command("mark_read", json!({ "id": envelope_id }))
        .await
    {
        eprintln!("serve mark_read warning for {envelope_id}: {error:#}");
    }
}

async fn execute_handler(
    script_path: &Path,
    exec_args: &[String],
    payload: &Value,
    timeout_secs: u64,
) -> Result<Value> {
    let mut child = Command::new(script_path)
        .args(exec_args)
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

#[cfg(test)]
mod tests {
    use super::{
        build_handlers, handler_filename_to_capability, protocol_matches_capability, ServeOptions,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn base_opts() -> ServeOptions {
        ServeOptions {
            on: None,
            exec: None,
            exec_args: Vec::new(),
            handlers: None,
            allow_from: Vec::new(),
            public: false,
            max_concurrency: 4,
            timeout_secs: 60,
            format: "text".to_string(),
        }
    }

    #[test]
    fn protocol_matching_uses_exact_capability_protocols() {
        assert!(protocol_matches_capability("/capability/gpu/compute", "gpu/compute"));
        assert!(protocol_matches_capability("/capability/gpu", "gpu"));
        assert!(!protocol_matches_capability(
            "/capability/gpu/compute/v2",
            "gpu/compute"
        ));
        assert!(!protocol_matches_capability(
            "/capability/gpu-compute",
            "gpu/compute"
        ));
    }

    #[test]
    fn build_handlers_keeps_exec_args_separate() {
        let mut opts = base_opts();
        opts.on = Some("gpu".to_string());
        opts.exec = Some("python".to_string());
        opts.exec_args = vec!["gpu_handler.py".to_string(), "--json".to_string()];

        let handlers = build_handlers(&opts).expect("handlers build");
        assert_eq!(handlers.len(), 1);
        assert_eq!(handlers[0].exec, std::path::PathBuf::from("python"));
        assert_eq!(
            handlers[0].exec_args,
            vec!["gpu_handler.py".to_string(), "--json".to_string()]
        );
    }

    #[test]
    fn build_handlers_rejects_unsplit_multi_word_exec_value() {
        let mut opts = base_opts();
        opts.on = Some("gpu".to_string());
        opts.exec = Some("python gpu_handler.py".to_string());

        let error = build_handlers(&opts).expect_err("invalid exec value should fail");
        assert!(error.to_string().contains("Pass handler arguments after `--`"));
    }

    #[test]
    fn handler_filename_maps_double_underscore_to_slash() {
        assert_eq!(
            handler_filename_to_capability(Path::new("gpu__compute.py")).as_deref(),
            Some("gpu/compute")
        );
    }

    #[test]
    fn build_handlers_maps_directory_entries_to_slash_capabilities() {
        let temp_dir = std::env::temp_dir().join(format!("a4-serve-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        let handler_path = temp_dir.join("gpu__compute.py");
        fs::write(&handler_path, "#!/usr/bin/env python3\n").expect("write temp handler");

        let mut opts = base_opts();
        opts.handlers = Some(temp_dir.display().to_string());

        let handlers = build_handlers(&opts).expect("handlers build");
        assert_eq!(handlers.len(), 1);
        assert_eq!(handlers[0].capability, "gpu/compute");
        assert_eq!(handlers[0].exec, PathBuf::from(&handler_path));

        let _ = fs::remove_file(&handler_path);
        let _ = fs::remove_dir(&temp_dir);
    }
}
