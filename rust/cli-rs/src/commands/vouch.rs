use anyhow::Result;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{load_config, save_config, EndorsementV2, TrustConfig};
use crate::identity::KeyPair;
use crate::protocol::relay_unsigned_endorsement_value;
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;

pub struct VouchOptions {
    pub target: String,
    pub endorsement_type: String,
    pub strength: f64,
    pub comment: Option<String>,
    pub domain: Option<String>,
    pub human: bool,
}

pub async fn run(opts: VouchOptions) -> Result<()> {
    let mut config = load_config()?;
    let identity = config
        .identity
        .clone()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    // CVP-0014: Resolve DID from alias
    let target_did =
        crate::commands::alias::resolve_did(&opts.target, &config).ok_or_else(|| {
            anyhow::anyhow!(
                "Could not resolve '{}' to a DID. Not found as alias or DID.",
                opts.target
            )
        })?;

    // Validate strength
    if opts.strength < 0.0 || opts.strength > 1.0 {
        anyhow::bail!("Endorsement strength must be between 0.0 and 1.0");
    }

    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // Calculate expiration (default 90 days, domain-specific if configured)
    let expires = timestamp + (90 * 24 * 60 * 60 * 1000); // 90 days in milliseconds

    let mut signed_endorsement = EndorsementV2 {
        endorser: identity.did.clone(),
        endorsee: target_did.clone(),
        domain: opts.domain.clone(),
        endorsement_type: opts.endorsement_type.clone(),
        strength: opts.strength,
        comment: opts.comment.clone(),
        timestamp,
        expires: Some(expires),
        version: "2.0".to_string(),
        signature: String::new(),
    };

    let endorsement_json =
        serde_json::to_string(&relay_unsigned_endorsement_value(&signed_endorsement))?;
    let signature_bytes = keypair.sign(endorsement_json.as_bytes());
    let signature = hex::encode(signature_bytes);
    signed_endorsement.signature = signature.clone();

    // Store endorsement locally
    if config.trust_config.is_none() {
        config.trust_config = Some(TrustConfig::new());
    }

    if let Some(ref mut trust_config) = config.trust_config {
        trust_config.add_endorsement(signed_endorsement.clone());
    }

    save_config(&config)?;

    // Try to publish endorsement to relay (optional, don't fail if relay is unavailable)
    if let Err(e) = publish_to_relay(&signed_endorsement, &identity, &config).await {
        eprintln!("Warning: Could not publish endorsement to relay: {}", e);
    }

    if opts.human {
        println!("Creating endorsement for: {}", target_did);
        println!("Type: {}", opts.endorsement_type);
        if let Some(domain) = &opts.domain {
            println!("Domain: {}", domain);
        }
        println!("Strength: {:.1}%", opts.strength * 100.0);
        if let Some(comment) = &opts.comment {
            println!("Comment: {}", comment);
        }
        println!();
        println!("Endorsement created, signed, and stored locally.");
        println!("Signature: {}...", &signature[..16]);
        println!();
        println!("Note: To publish this endorsement to the network,");
        println!("use a relay that supports CVP-0017 endorsement protocol.");
    } else {
        LlmFormatter::section("Endorsement Created");
        LlmFormatter::key_value("Endorser", &identity.did);
        LlmFormatter::key_value("Endorsee", &target_did);
        if let Some(domain) = &opts.domain {
            LlmFormatter::key_value("Domain", domain);
        }
        LlmFormatter::key_value("Type", &opts.endorsement_type);
        LlmFormatter::key_value("Strength", &opts.strength.to_string());
        LlmFormatter::key_value(
            "Strength Percentage",
            &format!("{:.1}%", opts.strength * 100.0),
        );
        if let Some(comment) = &opts.comment {
            LlmFormatter::key_value("Comment", comment);
        }
        LlmFormatter::key_value("Timestamp", &timestamp.to_string());
        LlmFormatter::key_value("Expires", &expires.to_string());
        LlmFormatter::key_value("Version", "2.0");
        LlmFormatter::key_value("Signature", &signature);
        LlmFormatter::key_value("Status", "signed_and_stored_locally");
        println!();
    }

    Ok(())
}

async fn publish_to_relay(
    endorsement: &EndorsementV2,
    identity: &crate::config::IdentityConfig,
    config: &crate::config::Config,
) -> Result<()> {
    let keypair = KeyPair::from_hex(&identity.private_key)?;

    let card = crate::commands::discover::build_card(config, identity)?;

    let (mut session, _relay_url) =
        connect_first_available(None, Some(config), &identity.did, &card, &keypair).await?;
    session.publish_endorsement(endorsement).await?;
    session.goodbye().await?;

    Ok(())
}
