use anyhow::Result;

use crate::config::Config;
use crate::identity::KeyPair;
use crate::protocol::AgentCard;
use crate::relay::connect_first_available;

pub struct ResolvedTarget {
    pub did: String,
    pub matched_by: &'static str,
    pub agent: Option<AgentCard>,
}

pub async fn resolve_target(
    target: &str,
    config: &Config,
    relay: Option<&str>,
) -> Result<ResolvedTarget> {
    if let Some(did) = crate::commands::alias::resolve_did(target, config) {
        return Ok(ResolvedTarget {
            did,
            matched_by: if target.starts_with("did:") {
                "did"
            } else {
                "alias"
            },
            agent: None,
        });
    }

    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;
    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = crate::config::build_card(config, identity)?;
    let (mut session, _relay_url) =
        connect_first_available(relay, Some(config), &identity.did, &card, &keypair).await?;
    let result = crate::commands::find::discover_agents(&mut session, Some(target), None, None, 1)
        .await?
        .into_iter()
        .next();
    let _ = session.goodbye().await;

    let agent =
        result.ok_or_else(|| anyhow::anyhow!("Could not resolve '{}' to a DID.", target))?;

    Ok(ResolvedTarget {
        did: agent.did.clone(),
        matched_by: "search",
        agent: Some(agent),
    })
}
