use anyhow::Result;
use serde_json::json;
use std::time::Duration;

use crate::daemon::{daemon_socket_path, DaemonClient};
use crate::ui::LlmFormatter;

pub struct InboxOptions {
    pub limit: Option<u32>,
    pub unread: bool,
    pub thread: Option<String>,
    pub wait: Option<Option<u64>>,
    pub human: bool,
    pub json: bool,
}

pub async fn run(opts: InboxOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());

    if !daemon.is_running().await {
        anyhow::bail!("Daemon is not running. Start it with: agent listen");
    }

    let wait_timeout_secs = match opts.wait {
        Some(Some(secs)) => Some(secs),
        Some(None) => Some(30),
        None => None,
    };

    if let Some(timeout_secs) = wait_timeout_secs {
        if opts.human {
            println!("Waiting for new messages ({}s timeout)...", timeout_secs);
        }

        let start_time = std::time::SystemTime::now();
        let timeout_duration = Duration::from_secs(timeout_secs);

        loop {
            if start_time.elapsed().unwrap_or_default() > timeout_duration {
                render_wait_timeout(timeout_secs, &opts);
                return Ok(());
            }

            let messages = fetch_messages(&daemon, &opts).await?;
            if !messages.is_empty() {
                render_messages(&messages, &opts);
                return Ok(());
            }

            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
    } else {
        let messages = fetch_messages(&daemon, &opts).await?;
        render_messages(&messages, &opts);
    }

    Ok(())
}

async fn fetch_messages(
    daemon: &DaemonClient,
    opts: &InboxOptions,
) -> Result<Vec<serde_json::Value>> {
    let mut params = json!({
        "limit": opts.limit.unwrap_or(20),
        "unread": opts.unread,
    });

    if let Some(thread_id) = &opts.thread {
        params["threadId"] = json!(thread_id);
    }

    let data = daemon.send_command("inbox", params).await?;
    Ok(data
        .get("messages")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_else(|| data.as_array().cloned().unwrap_or_default()))
}

fn render_wait_timeout(timeout_secs: u64, opts: &InboxOptions) {
    if opts.json {
        println!(
            "{}",
            json!({
                "event": "timeout",
                "timeout": timeout_secs,
            })
        );
        return;
    }

    if opts.human {
        println!("No new messages within {}s", timeout_secs);
    } else {
        LlmFormatter::section("Inbox Wait");
        LlmFormatter::key_value("Status", "timeout");
        LlmFormatter::key_value("Timeout", &format!("{}s", timeout_secs));
        println!();
    }
}

fn render_messages(messages: &[serde_json::Value], opts: &InboxOptions) {
    if opts.json {
        for msg in messages {
            let envelope = msg.get("envelope").unwrap_or(msg);
            println!(
                "{}",
                serde_json::to_string(envelope).unwrap_or_else(|_| "{}".to_string())
            );
        }
        return;
    }

    if messages.is_empty() {
        if opts.human {
            if opts.thread.is_some() {
                println!("No messages in thread");
            } else {
                println!("No messages in inbox");
            }
        } else {
            LlmFormatter::section("Inbox");
            LlmFormatter::key_value("Total", "0");
            if let Some(thread_id) = &opts.thread {
                LlmFormatter::key_value("Thread Filter", thread_id);
            }
            println!();
        }
        return;
    }

    if opts.human {
        use colored::Colorize;
        println!("{} message(s):", messages.len());
        if let Some(thread_id) = &opts.thread {
            println!("Thread: {}", thread_id);
        }
        println!();

        for msg in messages {
            let envelope = msg.get("envelope").unwrap_or(msg);
            let id = envelope.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let from = envelope
                .get("from")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let timestamp = envelope
                .get("timestamp")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let payload = envelope.get("payload");
            let thread_id = envelope.get("threadId").and_then(|v| v.as_str());
            let reply_to = envelope.get("replyTo").and_then(|v| v.as_str());

            let dt = chrono::DateTime::from_timestamp_millis(timestamp as i64)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| timestamp.to_string());

            println!("  {} {} {}", "[".dimmed(), id.bold(), "]".dimmed());
            println!("    From: {}", from);
            println!("    Time: {}", dt);

            if let Some(tid) = thread_id {
                println!("    Thread: {}", tid);
            }

            if let Some(reply_id) = reply_to {
                println!("    Reply to: {}", reply_id);
            }

            if let Some(p) = payload {
                if let Some(text) = p.get("text").and_then(|v| v.as_str()) {
                    println!("    {}", text);
                } else {
                    println!("    {}", p);
                }
            }
            println!();
        }
    } else {
        LlmFormatter::section("Inbox");
        LlmFormatter::key_value("Total", &messages.len().to_string());
        LlmFormatter::key_value("Showing", &messages.len().to_string());
        if let Some(thread_id) = &opts.thread {
            LlmFormatter::key_value("Thread Filter", thread_id);
        }
        println!();

        let headers = vec!["ID", "From", "Time", "Thread", "Preview"];
        let rows: Vec<Vec<String>> = messages
            .iter()
            .map(|msg| {
                let envelope = msg.get("envelope").unwrap_or(msg);
                let id = envelope
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string();
                let from = envelope
                    .get("from")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let timestamp = envelope
                    .get("timestamp")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let payload = envelope.get("payload");
                let thread_id = envelope
                    .get("threadId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let dt = chrono::DateTime::from_timestamp_millis(timestamp as i64)
                    .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                    .unwrap_or_else(|| timestamp.to_string());

                let preview = if let Some(p) = payload {
                    if let Some(text) = p.get("text").and_then(|v| v.as_str()) {
                        if text.len() > 50 {
                            format!("{}...", &text[..50])
                        } else {
                            text.to_string()
                        }
                    } else {
                        p.to_string()
                    }
                } else {
                    String::new()
                };

                vec![id, from, dt, thread_id, preview]
            })
            .collect();

        LlmFormatter::table(&headers, &rows);
        println!();
    }
}
