use anyhow::Result;
use std::collections::{BTreeSet, HashMap};

use crate::config::{load_config, save_config, TrustConfig};
use crate::ui::LlmFormatter;

pub struct TrustShowOptions {
    pub target: String,
    pub detailed: bool,
    pub human: bool,
}

pub struct TrustEndorseOptions {
    pub target: String,
    pub score: f64,
    pub reason: String,
    pub domain: Option<String>,
    pub human: bool,
}

pub struct TrustHistoryOptions {
    pub target: String,
    pub limit: u32,
    pub human: bool,
}

pub struct TrustStatsOptions {
    pub human: bool,
}

pub struct TrustQueryOptions {
    pub target: String,
    pub domain: Option<String>,
    pub limit: u32,
    pub human: bool,
}

pub struct TrustAllowOptions {
    pub target: String,
    pub note: Option<String>,
    pub human: bool,
}

pub struct TrustListOptions {
    pub human: bool,
}

pub async fn show(opts: TrustShowOptions) -> Result<()> {
    crate::commands::score::run(crate::commands::score::ScoreOptions {
        target: opts.target,
        detailed: opts.detailed,
        human: opts.human,
    })
    .await
}

pub async fn endorse(opts: TrustEndorseOptions) -> Result<()> {
    crate::commands::vouch::run(crate::commands::vouch::VouchOptions {
        target: opts.target,
        endorsement_type: "general".to_string(),
        strength: opts.score,
        comment: Some(opts.reason),
        domain: opts.domain,
        human: opts.human,
    })
    .await
}

pub async fn history(opts: TrustHistoryOptions) -> Result<()> {
    crate::commands::endorsements::run(crate::commands::endorsements::EndorsementsOptions {
        target: Some(opts.target),
        created_by: None,
        domain: None,
        limit: opts.limit,
        human: opts.human,
    })
    .await
}

pub async fn query(opts: TrustQueryOptions) -> Result<()> {
    crate::commands::endorsements::run(crate::commands::endorsements::EndorsementsOptions {
        target: Some(opts.target),
        created_by: None,
        domain: opts.domain,
        limit: opts.limit,
        human: opts.human,
    })
    .await
}

pub async fn block(target: String, reason: Option<String>, human: bool) -> Result<()> {
    crate::commands::block::run(crate::commands::block::BlockOptions {
        target,
        reason,
        human,
    })
    .await
}

pub async fn unblock(target: String, human: bool) -> Result<()> {
    crate::commands::unblock::run(crate::commands::unblock::UnblockOptions { target, human }).await
}

pub async fn allow(opts: TrustAllowOptions) -> Result<()> {
    let mut config = load_config()?;
    let target_did =
        crate::commands::alias::resolve_did(&opts.target, &config).ok_or_else(|| {
            anyhow::anyhow!(
                "Could not resolve '{}' to a DID. Not found as alias or DID.",
                opts.target
            )
        })?;

    let trust_config = config.trust_config.get_or_insert_with(TrustConfig::new);
    trust_config.allow_agent(target_did.clone(), opts.note.clone());
    save_config(&config)?;

    if opts.human {
        println!("Allowlisted agent: {}", target_did);
        if let Some(note) = opts.note {
            println!("Note: {}", note);
        }
        println!();
        println!("This agent is now marked as explicitly allowed locally.");
    } else {
        LlmFormatter::section("Allow Agent");
        LlmFormatter::key_value("Target DID", &target_did);
        if let Some(note) = opts.note {
            LlmFormatter::key_value("Note", &note);
        }
        LlmFormatter::key_value("Status", "allowlisted");
        println!();
    }

    Ok(())
}

pub async fn list_allowed(opts: TrustListOptions) -> Result<()> {
    let config = load_config()?;
    let trust_config = config.trust_config.unwrap_or_default();
    let mut allowed = trust_config.allowed_agents.into_iter().collect::<Vec<_>>();
    allowed.sort_by(|left, right| left.0.cmp(&right.0));

    if opts.human {
        if allowed.is_empty() {
            println!("No allowlisted agents.");
            return Ok(());
        }

        println!("Allowlisted agents ({}):", allowed.len());
        println!();
        for (did, entry) in allowed {
            println!("- {}", did);
            if let Some(note) = entry.note {
                println!("  {}", note);
            }
        }
    } else {
        LlmFormatter::section("Allowlisted Agents");
        LlmFormatter::key_value("Count", &allowed.len().to_string());
        for (did, entry) in allowed {
            LlmFormatter::key_value(&did, entry.note.as_deref().unwrap_or(""));
        }
        println!();
    }

    Ok(())
}

pub async fn list_blocked(opts: TrustListOptions) -> Result<()> {
    let config = load_config()?;
    let trust_config = config.trust_config.unwrap_or_default();
    let mut blocked = trust_config
        .blocked_agents
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    blocked.sort();

    if opts.human {
        if blocked.is_empty() {
            println!("No blocked agents.");
            return Ok(());
        }

        println!("Blocked agents ({}):", blocked.len());
        println!();
        for did in blocked {
            println!("- {}", did);
            if let Some(reason) = trust_config.blocked_reason(&did) {
                println!("  {}", reason);
            }
        }
    } else {
        LlmFormatter::section("Blocked Agents");
        LlmFormatter::key_value("Count", &blocked.len().to_string());
        for did in blocked {
            LlmFormatter::key_value(&did, trust_config.blocked_reason(&did).unwrap_or(""));
        }
        println!();
    }

    Ok(())
}

pub async fn stats(opts: TrustStatsOptions) -> Result<()> {
    let config = load_config()?;
    let trust_config = config.trust_config.unwrap_or_default();

    let mut all_agents = BTreeSet::new();
    let mut by_target: HashMap<String, (usize, f64)> = HashMap::new();

    for endorsement in trust_config.endorsements.values() {
        all_agents.insert(endorsement.endorser.clone());
        all_agents.insert(endorsement.endorsee.clone());

        let entry = by_target
            .entry(endorsement.endorsee.clone())
            .or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += endorsement.strength;
    }

    for did in &trust_config.blocked_agents {
        all_agents.insert(did.clone());
    }
    for did in trust_config.allowed_agents.keys() {
        all_agents.insert(did.clone());
    }

    let mut leaders = by_target
        .into_iter()
        .map(|(did, (count, total_strength))| (did, count, total_strength / count as f64))
        .collect::<Vec<_>>();
    leaders.sort_by(|left, right| {
        right
            .2
            .partial_cmp(&left.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| left.0.cmp(&right.0))
    });

    if opts.human {
        println!("Trust statistics");
        println!("Agents tracked: {}", all_agents.len());
        println!("Local endorsements: {}", trust_config.endorsements.len());
        println!("Blocked agents: {}", trust_config.blocked_agents.len());
        println!("Allowed agents: {}", trust_config.allowed_agents.len());
        println!("Cached trust scores: {}", trust_config.trust_scores.len());
        println!(
            "Cached SCC penalties: {}",
            trust_config.collusion_penalties.len()
        );

        if !leaders.is_empty() {
            println!();
            println!("Top local trust targets:");
            for (did, count, average_score) in leaders.into_iter().take(5) {
                println!(
                    "- {:.1}%  {}  ({} endorsement{})",
                    average_score * 100.0,
                    did,
                    count,
                    if count == 1 { "" } else { "s" }
                );
            }
        }
    } else {
        LlmFormatter::section("Trust Statistics");
        LlmFormatter::key_value("Agents Tracked", &all_agents.len().to_string());
        LlmFormatter::key_value(
            "Local Endorsements",
            &trust_config.endorsements.len().to_string(),
        );
        LlmFormatter::key_value(
            "Blocked Agents",
            &trust_config.blocked_agents.len().to_string(),
        );
        LlmFormatter::key_value(
            "Allowed Agents",
            &trust_config.allowed_agents.len().to_string(),
        );
        LlmFormatter::key_value(
            "Cached Scores",
            &trust_config.trust_scores.len().to_string(),
        );
        LlmFormatter::key_value(
            "Cached SCC Penalties",
            &trust_config.collusion_penalties.len().to_string(),
        );
        println!();
    }

    Ok(())
}
