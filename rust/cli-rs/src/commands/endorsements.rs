use crate::config::load_config;
use crate::daemon::DaemonClient;
use crate::identity::KeyPair;
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct EndorsementsOptions {
    pub target: Option<String>,
    pub created_by: Option<String>,
    pub domain: Option<String>,
    pub limit: u32,
    pub json: bool,
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
        opts.domain.as_deref(),
        opts.limit,
        &config,
    )
    .await
    {
        Ok(endorsements) => endorsements,
        Err(e) => {
            if opts.human {
                eprintln!("Could not query endorsements: {}", e);
                eprintln!("Ensure daemon is running (a4 listen) or relay is reachable.");
            }
            anyhow::bail!("Endorsements unavailable: {}", e);
        }
    };

    let endorsements = if let Some(domain) = opts.domain.as_deref() {
        endorsements
            .into_iter()
            .filter(|endorsement| {
                endorsement["domain"].is_null()
                    || endorsement["domain"].as_str() == Some(domain)
                    || endorsement["domain"].as_str() == Some("*")
            })
            .collect::<Vec<_>>()
    } else {
        endorsements
    };

    if opts.json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "target": target_did,
            "createdBy": created_by_did,
            "domain": opts.domain,
            "count": endorsements.len(),
            "endorsements": endorsements,
        }))?);
        return Ok(());
    }

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
        if let Some(domain) = &opts.domain {
            LlmFormatter::key_value("Domain", domain);
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
    domain: Option<&str>,
    limit: u32,
    config: &crate::config::Config,
) -> Result<Vec<serde_json::Value>> {
    // Try daemon first, fall back to direct relay if daemon unavailable
    match try_daemon_endorsements(target_did, created_by_did, domain, limit).await {
        Ok(endorsements) => Ok(endorsements),
        Err(_) => {
            // Daemon unavailable, try direct relay connection
            let result =
                query_from_relay(target_did, created_by_did, domain, limit, config).await?;
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
    domain: Option<&str>,
    limit: u32,
) -> Result<Vec<serde_json::Value>> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        anyhow::bail!("Daemon not running");
    }

    let request = serde_json::json!({
        "targetDid": target_did,
        "createdBy": created_by_did,
        "domain": domain,
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
    domain: Option<&str>,
    limit: u32,
    config: &crate::config::Config,
) -> Result<crate::protocol::TrustResultMessage> {
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found"))?;
    let keypair = KeyPair::from_hex(&identity.private_key)?;

    let card = crate::config::build_card(config, identity)?;

    let (mut session, _relay_url) =
        connect_first_available(None, Some(config), &identity.did, &card, &keypair).await?;

    let result = if let Some(target) = target_did {
        session
            .query_endorsements(target, domain, Some(limit), None)
            .await?
    } else {
        // Query general endorsements - for now, use a placeholder target
        session
            .query_endorsements("*", domain, Some(limit), None)
            .await?
    };

    session.goodbye().await?;
    Ok(result)
}
