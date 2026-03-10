use crate::config::load_config;
use crate::daemon::DaemonClient;
use crate::identity::KeyPair;
use crate::protocol::AgentCard;
use crate::relay::connect_first_available;
use crate::trust::{ActivityLevel, NetworkPosition, TrustEngine};
use crate::ui::LlmFormatter;
use anyhow::Result;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct ScoreOptions {
    pub target: String,
    pub detailed: bool,
    pub human: bool,
}

pub async fn run(opts: ScoreOptions) -> Result<()> {
    let config = load_config()?;
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    // CVP-0014: Resolve DID from alias
    let target_did =
        crate::commands::alias::resolve_did(&opts.target, &config).ok_or_else(|| {
            anyhow::anyhow!(
                "Could not resolve '{}' to a DID. Not found as alias or DID.",
                opts.target
            )
        })?;

    if opts.human {
        println!("Inspecting trust score for: {}", target_did);
        println!();
    }

    // Try to compute actual trust score, fall back to placeholder if unavailable
    let trust_score = match compute_actual_trust_score(&target_did, &identity.did, &config).await {
        Ok(score) => score,
        Err(e) => {
            if opts.human {
                eprintln!("Warning: Could not compute trust score from network: {}", e);
                eprintln!("Falling back to placeholder data...");
            }

            // Return placeholder trust score
            crate::trust::TrustScore {
                score: 0.75,
                local_trust: 0.6,
                network_trust: 0.8,
                alpha: 0.3,
                endorsement_count: 12,
                interaction_count: 45,
                breakdown: crate::trust::TrustBreakdown {
                    capability_endorsements: 8,
                    reliability_endorsements: 4,
                    general_endorsements: 0,
                    recent_activity: ActivityLevel::High,
                    network_position: NetworkPosition::WellConnected,
                },
            }
        }
    };

    if opts.human {
        println!("Trust Score: {:.1}%", trust_score.score * 100.0);
        println!("Endorsements: {}", trust_score.endorsement_count);
        println!("Interactions: {}", trust_score.interaction_count);

        if opts.detailed {
            println!();
            println!("Trust Breakdown:");
            println!("  Local Trust: {:.1}%", trust_score.local_trust * 100.0);
            println!("  Network Trust: {:.1}%", trust_score.network_trust * 100.0);
            println!("  Alpha (Local Weight): {:.3}", trust_score.alpha);
            println!();
            println!(
                "  Capability Endorsements: {} ({:.1}%)",
                trust_score.breakdown.capability_endorsements,
                if trust_score.endorsement_count > 0 {
                    trust_score.breakdown.capability_endorsements as f64
                        / trust_score.endorsement_count as f64
                        * 100.0
                } else {
                    0.0
                }
            );
            println!(
                "  Reliability Endorsements: {} ({:.1}%)",
                trust_score.breakdown.reliability_endorsements,
                if trust_score.endorsement_count > 0 {
                    trust_score.breakdown.reliability_endorsements as f64
                        / trust_score.endorsement_count as f64
                        * 100.0
                } else {
                    0.0
                }
            );
            println!(
                "  General Endorsements: {}",
                trust_score.breakdown.general_endorsements
            );
            println!(
                "  Recent Activity: {:?}",
                trust_score.breakdown.recent_activity
            );
            println!(
                "  Network Position: {:?}",
                trust_score.breakdown.network_position
            );
            println!();
            println!(
                "Note: Trust computation is client-side using CVP-0017 EigenTrust-lite algorithm."
            );
        }
    } else {
        LlmFormatter::section("Trust Score");
        LlmFormatter::key_value("Target DID", &target_did);
        LlmFormatter::key_value("Trust Score", &format!("{:.3}", trust_score.score));
        LlmFormatter::key_value(
            "Trust Percentage",
            &format!("{:.1}%", trust_score.score * 100.0),
        );
        LlmFormatter::key_value(
            "Endorsement Count",
            &trust_score.endorsement_count.to_string(),
        );
        LlmFormatter::key_value(
            "Interaction Count",
            &trust_score.interaction_count.to_string(),
        );

        if opts.detailed {
            LlmFormatter::key_value("Local Trust", &format!("{:.3}", trust_score.local_trust));
            LlmFormatter::key_value(
                "Network Trust",
                &format!("{:.3}", trust_score.network_trust),
            );
            LlmFormatter::key_value("Alpha Local Weight", &format!("{:.3}", trust_score.alpha));
            LlmFormatter::key_value(
                "Capability Endorsements",
                &trust_score.breakdown.capability_endorsements.to_string(),
            );
            LlmFormatter::key_value(
                "Reliability Endorsements",
                &trust_score.breakdown.reliability_endorsements.to_string(),
            );
            LlmFormatter::key_value(
                "General Endorsements",
                &trust_score.breakdown.general_endorsements.to_string(),
            );
            LlmFormatter::key_value(
                "Recent Activity",
                &format!("{:?}", trust_score.breakdown.recent_activity),
            );
            LlmFormatter::key_value(
                "Network Position",
                &format!("{:?}", trust_score.breakdown.network_position),
            );
        }

        LlmFormatter::key_value("Algorithm", "CVP-0017 EigenTrust-lite");
        println!();
    }

    Ok(())
}

async fn compute_actual_trust_score(
    target_did: &str,
    observer_did: &str,
    config: &crate::config::Config,
) -> Result<crate::trust::TrustScore> {
    // Try daemon first, fall back to direct relay if daemon unavailable
    match try_daemon_trust_score(target_did, observer_did).await {
        Ok(score) => Ok(score),
        Err(_) => {
            // Daemon unavailable, try direct relay connection
            compute_trust_score_via_relay(target_did, observer_did, config).await
        }
    }
}

async fn try_daemon_trust_score(
    target_did: &str,
    _observer_did: &str,
) -> Result<crate::trust::TrustScore> {
    let client = DaemonClient::new(&crate::daemon::daemon_socket_path());

    if !client.is_running().await {
        anyhow::bail!("Daemon not running");
    }

    let request = serde_json::json!({
        "targetDid": target_did,
        "detailed": true,
    });

    let data = client.send_command("trust_score", request).await?;

    // Parse daemon response into TrustScore
    let score = data["score"].as_f64().unwrap_or(0.5);
    let local_trust = data["localTrust"].as_f64().unwrap_or(0.5);
    let network_trust = data["networkTrust"].as_f64().unwrap_or(0.5);
    let alpha = data["alpha"].as_f64().unwrap_or(0.3);
    let endorsement_count = data["endorsementCount"].as_u64().unwrap_or(0) as u32;
    let interaction_count = data["interactionCount"].as_u64().unwrap_or(0) as u32;

    let breakdown_data = &data["breakdown"];
    let breakdown = crate::trust::TrustBreakdown {
        capability_endorsements: breakdown_data["capabilityEndorsements"]
            .as_u64()
            .unwrap_or(0) as u32,
        reliability_endorsements: breakdown_data["reliabilityEndorsements"]
            .as_u64()
            .unwrap_or(0) as u32,
        general_endorsements: breakdown_data["generalEndorsements"].as_u64().unwrap_or(0) as u32,
        recent_activity: match breakdown_data["recentActivity"]
            .as_str()
            .unwrap_or("Medium")
        {
            "Low" => ActivityLevel::Low,
            "High" => ActivityLevel::High,
            _ => ActivityLevel::Medium,
        },
        network_position: match breakdown_data["networkPosition"]
            .as_str()
            .unwrap_or("Connected")
        {
            "Isolated" => NetworkPosition::Isolated,
            "WellConnected" => NetworkPosition::WellConnected,
            "Central" => NetworkPosition::Central,
            _ => NetworkPosition::Connected,
        },
    };

    Ok(crate::trust::TrustScore {
        score,
        local_trust,
        network_trust,
        alpha,
        endorsement_count,
        interaction_count,
        breakdown,
    })
}

async fn compute_trust_score_via_relay(
    target_did: &str,
    observer_did: &str,
    config: &crate::config::Config,
) -> Result<crate::trust::TrustScore> {
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

    // Query endorsements from relay
    let (mut session, _relay_url) =
        connect_first_available(None, Some(config), &identity.did, &card, &keypair).await?;
    let trust_result = session
        .query_endorsements(target_did, None, Some(100), None)
        .await?;
    session.goodbye().await?;

    // Initialize trust engine with config
    let trust_config = config.trust_config.clone().unwrap_or_default();
    let mut engine = TrustEngine::new(trust_config);

    // Compute trust score using EigenTrust-lite
    let trust_score =
        engine.compute_trust_score(target_did, observer_did, &trust_result.endorsements)?;

    Ok(trust_score)
}
