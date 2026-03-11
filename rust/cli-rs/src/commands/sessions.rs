use crate::config::load_config;
use crate::daemon::DaemonClient;
use anyhow::{bail, Result};

pub struct SessionsListOptions {
    pub with: Option<String>,
    pub limit: u32,
    pub human: bool,
}

pub struct SessionsShowOptions {
    pub thread_id: String,
    pub limit: u32,
    pub human: bool,
}

fn format_age(timestamp_ms: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let secs = (now - timestamp_ms) / 1000;

    if secs < 60 {
        format!("{}s ago", secs)
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86400 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86400)
    }
}

fn short_thread_id(thread_id: &str) -> String {
    let parts: Vec<&str> = thread_id.split('_').collect();
    if parts.len() == 3 {
        format!("thread_...{}", parts[2])
    } else {
        thread_id.chars().take(20).collect::<String>() + "..."
    }
}

fn short_did(did: &str) -> String {
    if let Some(rest) = did.strip_prefix("did:agent:") {
        if rest.len() > 14 {
            format!("{}…", &rest[..14])
        } else {
            rest.to_string()
        }
    } else if did.len() > 30 {
        format!("{}…{}", &did[..14], &did[did.len() - 8..])
    } else {
        did.to_string()
    }
}

pub async fn list(opts: SessionsListOptions) -> Result<()> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        bail!("Daemon not running. Start with: agent listen");
    }

    // Resolve peer DID if alias provided
    let peer_did = if let Some(ref with) = opts.with {
        let config = load_config()?;
        crate::commands::alias::resolve_did(with, &config)
    } else {
        None
    };

    let request = serde_json::json!({
        "command": "sessions",
        "params": {
            "peerDid": peer_did,
            "limit": opts.limit,
        }
    });

    let data = client
        .send_command("sessions", request["params"].clone())
        .await?;

    let empty_vec = vec![];
    let sessions = data["sessions"].as_array().unwrap_or(&empty_vec);
    let total = data["total"].as_u64().unwrap_or(0);

    if opts.human {
        println!("\nSessions ({} total)\n", total);

        if sessions.is_empty() {
            println!("  No sessions.");
            return Ok(());
        }

        let config = load_config()?;
        for session in sessions {
            let thread_id = session["threadId"].as_str().unwrap_or("");
            let peer_did = session["peerDid"].as_str().unwrap_or("");
            let message_count = session["messageCount"].as_u64().unwrap_or(0);
            let last_message_at = session["lastMessageAt"].as_i64().unwrap_or(0);
            let title = session["title"].as_str().unwrap_or("(no title)");

            let short_tid = short_thread_id(thread_id);
            let peer = config
                .aliases
                .iter()
                .find(|(_, did)| did.as_str() == peer_did)
                .map(|(name, _)| name.as_str())
                .unwrap_or_else(|| peer_did);
            let short_peer = short_did(peer);
            let age = format_age(last_message_at);

            println!(
                "  {}  {}  {} msgs  {}",
                short_tid, short_peer, message_count, age
            );
            println!("    {}", title);
        }
        println!();
    } else {
        println!("SESSIONS\n");
        println!("Total: {}\n", total);

        if sessions.is_empty() {
            println!("No sessions.");
            return Ok(());
        }

        let config = load_config()?;
        for session in sessions {
            let thread_id = session["threadId"].as_str().unwrap_or("");
            let peer_did = session["peerDid"].as_str().unwrap_or("");
            let message_count = session["messageCount"].as_u64().unwrap_or(0);
            let last_message_at = session["lastMessageAt"].as_i64().unwrap_or(0);
            let title = session["title"].as_str().unwrap_or("(no title)");

            let peer = config
                .aliases
                .iter()
                .find(|(_, did)| did.as_str() == peer_did)
                .map(|(name, _)| name.as_str())
                .unwrap_or(peer_did);
            let age = format_age(last_message_at);

            println!("Thread ID: {}", thread_id);
            println!("Peer: {}", peer);
            println!("Messages: {}", message_count);
            println!("Last Activity: {}", age);
            println!("Title: {}", title);
            println!();
        }
    }

    Ok(())
}

pub async fn show(opts: SessionsShowOptions) -> Result<()> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        bail!("Daemon not running. Start with: agent listen");
    }

    let request = serde_json::json!({
        "threadId": opts.thread_id,
        "limit": opts.limit,
    });

    let data = client.send_command("session_messages", request).await?;

    let empty_messages = vec![];
    let messages = data["messages"].as_array().unwrap_or(&empty_messages);

    if messages.is_empty() {
        println!("No messages in this thread.");
        return Ok(());
    }

    let config = load_config()?;

    // Get session metadata
    let sessions_request = serde_json::json!({ "limit": 1000 });
    let sessions_data = client.send_command("sessions", sessions_request).await?;
    let empty_sessions = vec![];
    let sessions = sessions_data["sessions"]
        .as_array()
        .unwrap_or(&empty_sessions);
    let session = sessions
        .iter()
        .find(|s| s["threadId"].as_str() == Some(&opts.thread_id));

    if opts.human {
        println!("\n{}", "─".repeat(60));
        println!("Thread: {}", opts.thread_id);

        if let Some(session) = session {
            let peer_did = session["peerDid"].as_str().unwrap_or("");
            let peer = config
                .aliases
                .iter()
                .find(|(_, did)| did.as_str() == peer_did)
                .map(|(name, _)| name.as_str())
                .unwrap_or(peer_did);
            let started_at = session["startedAt"].as_i64().unwrap_or(0);
            let message_count = session["messageCount"].as_u64().unwrap_or(0);

            println!("Peer: {}", peer);
            println!(
                "Started: {}",
                chrono::DateTime::from_timestamp_millis(started_at)
                    .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            println!("Messages: {}", message_count);
        }

        println!("{}", "─".repeat(60));
        println!();

        for msg in messages {
            let envelope = &msg["envelope"];
            let direction = msg["direction"].as_str().unwrap_or("");
            let timestamp = msg
                .get("receivedAt")
                .or_else(|| msg.get("sentAt"))
                .and_then(|v| v.as_i64())
                .or_else(|| envelope["timestamp"].as_i64())
                .unwrap_or(0);

            let from = if direction == "outbound" {
                "you".to_string()
            } else {
                let from_did = envelope["from"].as_str().unwrap_or("");
                config
                    .aliases
                    .iter()
                    .find(|(_, did)| did.as_str() == from_did)
                    .map(|(name, _)| name.clone())
                    .unwrap_or_else(|| short_did(from_did))
            };

            let payload = &envelope["payload"];
            let text = payload["text"]
                .as_str()
                .or_else(|| payload["message"].as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_default());

            let dt = chrono::DateTime::from_timestamp_millis(timestamp)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| "unknown".to_string());

            println!("[{}] {}", dt, from);
            println!("{}", text);
            println!();
        }
    } else {
        println!("SESSION DETAILS\n");
        println!("Thread ID: {}", opts.thread_id);

        if let Some(session) = session {
            let peer_did = session["peerDid"].as_str().unwrap_or("");
            let peer = config
                .aliases
                .iter()
                .find(|(_, did)| did.as_str() == peer_did)
                .map(|(name, _)| name.as_str())
                .unwrap_or(peer_did);
            let started_at = session["startedAt"].as_i64().unwrap_or(0);
            let last_message_at = session["lastMessageAt"].as_i64().unwrap_or(0);
            let message_count = session["messageCount"].as_u64().unwrap_or(0);

            println!("Peer: {}", peer);
            println!("Peer DID: {}", peer_did);
            println!(
                "Started: {}",
                chrono::DateTime::from_timestamp_millis(started_at)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            println!(
                "Last Activity: {}",
                chrono::DateTime::from_timestamp_millis(last_message_at)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| "unknown".to_string())
            );
            println!("Messages: {}", message_count);
        }

        println!("\nMESSAGES\n");

        for msg in messages {
            let envelope = &msg["envelope"];
            let direction = msg["direction"].as_str().unwrap_or("");
            let timestamp = msg
                .get("receivedAt")
                .or_else(|| msg.get("sentAt"))
                .and_then(|v| v.as_i64())
                .or_else(|| envelope["timestamp"].as_i64())
                .unwrap_or(0);

            let from = if direction == "outbound" {
                "you".to_string()
            } else {
                let from_did = envelope["from"].as_str().unwrap_or("");
                config
                    .aliases
                    .iter()
                    .find(|(_, did)| did.as_str() == from_did)
                    .map(|(name, _)| name.clone())
                    .unwrap_or_else(|| from_did.to_string())
            };

            let payload = &envelope["payload"];
            let text = payload["text"]
                .as_str()
                .or_else(|| payload["message"].as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_default());

            let dt = chrono::DateTime::from_timestamp_millis(timestamp)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "unknown".to_string());

            println!("[{}] {}", dt, from);
            println!("{}", text);
            println!();
        }
    }

    Ok(())
}
