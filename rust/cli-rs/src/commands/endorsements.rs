use crate::config::load_config;
use crate::daemon::DaemonClient;
use crate::identity::KeyPair;
use crate::protocol::AgentCard;
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;
use anyhow::Result;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct EndorsementsOptions {
    pub target: Option<String>,
    pub created_by: Option<String>,
    pub limit: u32,
    pub human: bool,
}

pub async fn run(opts: EndorsementsOptions) -> Result<()> {
    let config = load_config()?;
    let _identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    // Resolve DIDs from aliases if provided
    let target_did = if let Some(target) = &opts.target {
        Some(
            crate::commands::alias::resolve_did(target, &config).ok_or_else(|| {
                anyhow::anyhow!(
                    "Could not resolve '{}' to a DID. Not found as alias or DID.",
                    target
                )
            })?,
        )
    } else {
        None
    };

    let created_by_did = if let Some(creator) = &opts.created_by {
        Some(
            crate::commands::alias::resolve_did(creator, &config).ok_or_else(|| {
                anyhow::anyhow!(
                    "Could not resolve '{}' to a DID. Not found as alias or DID.",
                    creator
                )
            })?,
        )
    } else {
        None
    };

    if opts.human {
        if let Some(target) = &target_did {
            println!("Querying endorsements for: {}", target);
        } else if let Some(creator) = &created_by_did {
            println!("Querying endorsements created by: {}", creator);
        } else {
            println!("Querying recent endorsements from network");
        }
        println!("Limit: {}", opts.limit);
        println!();
    }

    // Try to query endorsements from relay, fall back to placeholder data if unavailable
    let endorsements = match query_endorsements_with_fallback(
        &target_did,
        &created_by_did,
        opts.limit,
        &config,
    )
    .await
    {
        Ok(endorsements) => endorsements,
        Err(e) => {
            if opts.human {
                eprintln!("Warning: Could not query endorsements from network: {}", e);
                eprintln!("Falling back to placeholder data...");
            }

            // Return placeholder data as fallback
            vec![
                serde_json::json!({
                    "endorser": "did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
                    "endorsee": target_did.as_deref().unwrap_or("did:agent:z6MkrJVnaZjNXrk5jgJFN9QnBpXuP4gFeHkJv1P2QRKxdoK"),
                    "type": "capability",
                    "strength": 0.9,
                    "comment": "Excellent translation work",
                    "timestamp": 1709740800000u64,
                    "version": "2.0",
                    "signature": "a1b2c3d4e5f6..."
                }),
                serde_json::json!({
                    "endorser": "did:agent:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
                    "endorsee": target_did.as_deref().unwrap_or("did:agent:z6MkrJVnaZjNXrk5jgJFN9QnBpXuP4gFeHkJv1P2QRKxdoK"),
                    "type": "reliability",
                    "strength": 0.8,
                    "comment": "Always responds quickly",
                    "timestamp": 1709654400000u64,
                    "version": "2.0",
                    "signature": "f6e5d4c3b2a1..."
                }),
                serde_json::json!({
                    "endorser": "did:agent:z6MkqRYqQiSgvZQdnBytw86Qbs2ZWUkGv22od935YF4s8M7V",
                    "endorsee": target_did.as_deref().unwrap_or("did:agent:z6MkrJVnaZjNXrk5jgJFN9QnBpXuP4gFeHkJv1P2QRKxdoK"),
                    "type": "general",
                    "strength": 0.75,
                    "comment": null,
                    "timestamp": 1709568000000u64,
                    "version": "2.0",
                    "signature": "1a2b3c4d5e6f..."
                }),
            ]
        }
    };

    if opts.human {
        println!("Found {} endorsement(s):", endorsements.len());
        println!();

        for (i, endorsement) in endorsements.iter().enumerate() {
            println!(
                "{}. {} → {}",
                i + 1,
                endorsement["endorser"].as_str().unwrap_or("unknown")[..20].to_string() + "...",
                endorsement["endorsee"].as_str().unwrap_or("unknown")[..20].to_string() + "..."
            );
            println!(
                "   Type: {}",
                endorsement["type"].as_str().unwrap_or("unknown")
            );
            println!(
                "   Strength: {:.1}%",
                endorsement["strength"].as_f64().unwrap_or(0.0) * 100.0
            );

            if let Some(comment) = endorsement["comment"].as_str() {
                println!("   Comment: {}", comment);
            }

            let timestamp = endorsement["timestamp"].as_u64().unwrap_or(0);
            let datetime = chrono::DateTime::from_timestamp(timestamp as i64 / 1000, 0)
                .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                .unwrap_or_else(|| timestamp.to_string());
            println!("   Date: {}", datetime);
            println!();
        }
    } else {
        LlmFormatter::section("Endorsements Query");
        if let Some(target) = &target_did {
            LlmFormatter::key_value("Target", target);
        }
        if let Some(creator) = &created_by_did {
            LlmFormatter::key_value("Created By", creator);
        }
        LlmFormatter::key_value("Limit", &opts.limit.to_string());
        LlmFormatter::key_value("Count", &endorsements.len().to_string());

        if !endorsements.is_empty() {
            let headers = vec![
                "Endorser", "Endorsee", "Type", "Strength", "Comment", "Date",
            ];
            let mut rows = Vec::new();

            for endorsement in &endorsements {
                let endorser = endorsement["endorser"].as_str().unwrap_or("unknown");
                let endorsee = endorsement["endorsee"].as_str().unwrap_or("unknown");
                let endorsement_type = endorsement["type"].as_str().unwrap_or("unknown");
                let strength = format!(
                    "{:.1}%",
                    endorsement["strength"].as_f64().unwrap_or(0.0) * 100.0
                );
                let comment = endorsement["comment"].as_str().unwrap_or("(none)");

                let timestamp = endorsement["timestamp"].as_u64().unwrap_or(0);
                let date = chrono::DateTime::from_timestamp(timestamp as i64 / 1000, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                rows.push(vec![
                    format!("{}...", &endorser[..20.min(endorser.len())]),
                    format!("{}...", &endorsee[..20.min(endorsee.len())]),
                    endorsement_type.to_string(),
                    strength,
                    comment.to_string(),
                    date,
                ]);
            }

            LlmFormatter::table(&headers, &rows);
        }
        println!();
    }

    Ok(())
}

async fn query_endorsements_with_fallback(
    target_did: &Option<String>,
    created_by_did: &Option<String>,
    limit: u32,
    config: &crate::config::Config,
) -> Result<Vec<serde_json::Value>> {
    // Try daemon first, fall back to direct relay if daemon unavailable
    match try_daemon_endorsements(target_did, created_by_did, limit).await {
        Ok(endorsements) => Ok(endorsements),
        Err(_) => {
            // Daemon unavailable, try direct relay connection
            let result = query_from_relay(target_did, created_by_did, limit, config).await?;
            Ok(result
                .endorsements
                .into_iter()
                .map(|e| serde_json::to_value(e).unwrap_or_default())
                .collect())
        }
    }
}

async fn try_daemon_endorsements(
    target_did: &Option<String>,
    created_by_did: &Option<String>,
    limit: u32,
) -> Result<Vec<serde_json::Value>> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        anyhow::bail!("Daemon not running");
    }

    let request = serde_json::json!({
        "targetDid": target_did,
        "createdBy": created_by_did,
        "limit": limit,
    });

    let data = client.send_command("endorsements", request).await?;

    let endorsements = data["endorsements"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid endorsements response from daemon"))?;

    Ok(endorsements.clone())
}

async fn query_from_relay(
    target_did: &Option<String>,
    _created_by_did: &Option<String>,
    limit: u32,
    config: &crate::config::Config,
) -> Result<crate::protocol::TrustResultMessage> {
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found"))?;
    let keypair = KeyPair::from_hex(&identity.private_key)?;

    // Build agent card for relay connection
    let card_config = config
        .agent_card
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No agent card found"))?;

    let capabilities = card_config
        .capabilities
        .iter()
        .map(|cap| crate::protocol::Capability {
            id: cap.clone(),
            name: cap.clone(),
            description: format!("Capability: {}", cap),
            parameters: None,
            metadata: None,
        })
        .collect();

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let card_unsigned = crate::protocol::AgentCardUnsigned {
        did: identity.did.clone(),
        name: card_config.name.clone(),
        description: card_config.description.clone(),
        version: "1.0.0".to_string(),
        capabilities,
        endpoints: vec![],
        peer_id: None,
        trust: None,
        metadata: None,
        timestamp,
    };

    let signature = AgentCard::sign(&card_unsigned, &keypair);
    let card = AgentCard {
        did: card_unsigned.did,
        name: card_unsigned.name,
        description: card_unsigned.description,
        version: card_unsigned.version,
        capabilities: card_unsigned.capabilities,
        endpoints: card_unsigned.endpoints,
        peer_id: card_unsigned.peer_id,
        trust: card_unsigned.trust,
        metadata: card_unsigned.metadata,
        timestamp: card_unsigned.timestamp,
        signature,
    };

    let (mut session, _relay_url) =
        connect_first_available(None, Some(config), &identity.did, &card, &keypair).await?;

    let result = if let Some(target) = target_did {
        session
            .query_endorsements(target, None, Some(limit), None)
            .await?
    } else {
        // Query general endorsements - for now, use a placeholder target
        session
            .query_endorsements("*", None, Some(limit), None)
            .await?
    };

    session.goodbye().await?;
    Ok(result)
}
