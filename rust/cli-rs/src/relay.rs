use anyhow::Result;

use crate::config::{resolve_relay_invite_token, Config};
use crate::identity::KeyPair;
use crate::protocol::AgentCard;

use quadra_a_runtime::card::build_published_prekey_bundles_from_config;
pub use quadra_a_runtime::relay::{parse_discovered_agent_card, RelaySession};

pub async fn connect_first_available(
    explicit: Option<&str>,
    config: Option<&Config>,
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
) -> Result<(RelaySession, String)> {
    let invite_token = resolve_relay_invite_token(None, config);
    let (mut session, relay_url) =
        quadra_a_runtime::relay::connect_first_available_with_invite_token(
            explicit,
            config,
            did,
            card,
            keypair,
            invite_token.as_deref(),
        )
        .await?;

    if let Some(config) = config {
        let prekey_bundles = build_published_prekey_bundles_from_config(config);
        if !prekey_bundles.is_empty() {
            session.publish_prekey_bundles(&prekey_bundles).await?;
        }
    }

    Ok((session, relay_url))
}
