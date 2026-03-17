use crate::config::load_config;
use crate::daemon::DaemonClient;
use crate::identity::KeyPair;
use crate::relay::connect_first_available;
use crate::trust::{ActivityLevel, NetworkPosition, TrustEngine};
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct ScoreOptions {
    pub target: String,
    pub detailed: bool,
    pub json: bool,
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
                eprintln!("Could not compute trust score: {}", e);
                eprintln!("Ensure daemon is running (a4 listen) or relay is reachable.");
            }
            anyhow::bail!("Trust score unavailable: {}", e);
        }
    };

    if opts.json {
        let mut result = serde_json::json!({
            "target": target_did,
            "score": trust_score.score,
            "scorePercent": format!("{:.1}%", trust_score.score * 100.0),
            "endorsementCount": trust_score.endorsement_count,
            "interactionCount": trust_score.interaction_count,
        });
        if opts.detailed {
            result["localTrust"] = serde_json::json!(trust_score.local_trust);
            result["networkTrust"] = serde_json::json!(trust_score.network_trust);
            result["alpha"] = serde_json::json!(trust_score.alpha);
            result["breakdown"] = serde_json::json!({
                "capabilityEndorsements": trust_score.breakdown.capability_endorsements,
                "reliabilityEndorsements": trust_score.breakdown.reliability_endorsements,
                "generalEndorsements": trust_score.breakdown.general_endorsements,
                "recentActivity": format!("{:?}", trust_score.breakdown.recent_activity),
                "networkPosition": format!("{:?}", trust_score.breakdown.network_position),
            });
        }
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }

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

    parse_daemon_trust_score(&data)
}

fn parse_activity_level(value: &str) -> ActivityLevel {
    match value {
        "Low" => ActivityLevel::Low,
        "High" => ActivityLevel::High,
        _ => ActivityLevel::Medium,
    }
}

fn parse_network_position(value: &str) -> NetworkPosition {
    match value {
        "Isolated" => NetworkPosition::Isolated,
        "WellConnected" => NetworkPosition::WellConnected,
        "Central" => NetworkPosition::Central,
        _ => NetworkPosition::Connected,
    }
}

fn parse_daemon_trust_score(data: &serde_json::Value) -> Result<crate::trust::TrustScore> {
    if let Some(score_data) = data.get("score").and_then(|value| value.as_object()) {
        let score = score_data
            .get("interactionScore")
            .and_then(|value| value.as_f64())
            .ok_or_else(|| anyhow::anyhow!("Invalid JS daemon trust score response"))?;
        let endorsement_count = score_data
            .get("endorsements")
            .and_then(|value| value.as_u64())
            .unwrap_or_else(|| {
                data.get("endorsements")
                    .and_then(|value| value.as_array())
                    .map(|endorsements| endorsements.len() as u64)
                    .unwrap_or(0)
            }) as u32;
        let interaction_count = score_data
            .get("totalInteractions")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as u32;
        let local_trust = score_data
            .get("completionRate")
            .and_then(|value| value.as_f64())
            .unwrap_or(score);
        let network_trust = score_data
            .get("endorsementScore")
            .and_then(|value| value.as_f64())
            .unwrap_or(score);
        let recent_success_rate = score_data
            .get("recentSuccessRate")
            .and_then(|value| value.as_f64())
            .unwrap_or(local_trust);
        let alpha = (interaction_count as f64 / 20.0).min(0.8);
        let breakdown = crate::trust::TrustBreakdown {
            capability_endorsements: 0,
            reliability_endorsements: 0,
            general_endorsements: endorsement_count,
            recent_activity: if recent_success_rate >= 0.8 {
                ActivityLevel::High
            } else if recent_success_rate <= 0.4 {
                ActivityLevel::Low
            } else {
                ActivityLevel::Medium
            },
            network_position: match endorsement_count {
                0 => NetworkPosition::Isolated,
                1..=4 => NetworkPosition::Connected,
                5..=9 => NetworkPosition::WellConnected,
                _ => NetworkPosition::Central,
            },
        };

        return Ok(crate::trust::TrustScore {
            score,
            local_trust,
            network_trust,
            alpha,
            endorsement_count,
            interaction_count,
            breakdown,
        });
    }

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
        recent_activity: parse_activity_level(
            breakdown_data["recentActivity"]
                .as_str()
                .unwrap_or("Medium"),
        ),
        network_position: parse_network_position(
            breakdown_data["networkPosition"]
                .as_str()
                .unwrap_or("Connected"),
        ),
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

    let card = crate::config::build_card(config, identity)?;

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

#[cfg(test)]
mod tests {
    use super::parse_daemon_trust_score;
    use crate::trust::{ActivityLevel, NetworkPosition};
    use serde_json::json;

    #[test]
    fn parses_rust_daemon_trust_score_shape() {
        let parsed = parse_daemon_trust_score(&json!({
            "score": 0.91,
            "localTrust": 0.8,
            "networkTrust": 0.95,
            "alpha": 0.3,
            "endorsementCount": 4,
            "interactionCount": 7,
            "breakdown": {
                "capabilityEndorsements": 1,
                "reliabilityEndorsements": 1,
                "generalEndorsements": 2,
                "recentActivity": "High",
                "networkPosition": "WellConnected"
            }
        }))
        .expect("parses rust daemon response");

        assert_eq!(parsed.score, 0.91);
        assert_eq!(parsed.endorsement_count, 4);
        assert_eq!(parsed.interaction_count, 7);
        assert!(matches!(
            parsed.breakdown.recent_activity,
            ActivityLevel::High
        ));
        assert!(matches!(
            parsed.breakdown.network_position,
            NetworkPosition::WellConnected
        ));
    }

    #[test]
    fn parses_js_daemon_trust_score_shape() {
        let parsed = parse_daemon_trust_score(&json!({
            "score": {
                "interactionScore": 0.72,
                "endorsements": 3,
                "endorsementScore": 0.66,
                "completionRate": 0.8,
                "totalInteractions": 12,
                "recentSuccessRate": 0.9
            },
            "endorsements": [
                { "from": "did:a", "to": "did:b", "score": 0.7, "reason": "solid", "timestamp": 1 }
            ]
        }))
        .expect("parses js daemon response");

        assert_eq!(parsed.score, 0.72);
        assert_eq!(parsed.local_trust, 0.8);
        assert_eq!(parsed.network_trust, 0.66);
        assert_eq!(parsed.endorsement_count, 3);
        assert_eq!(parsed.interaction_count, 12);
        assert!(matches!(
            parsed.breakdown.recent_activity,
            ActivityLevel::High
        ));
        assert!(matches!(
            parsed.breakdown.network_position,
            NetworkPosition::Connected
        ));
    }
}
