use anyhow::Result;

use crate::config::{resolve_relay_invite_token, Config};
use crate::identity::KeyPair;
use crate::protocol::AgentCard;

pub use quadra_a_runtime::relay::{parse_discovered_agent_card, RelaySession};

pub async fn connect_first_available(
    explicit: Option<&str>,
    config: Option<&Config>,
    did: &str,
    card: &AgentCard,
    keypair: &KeyPair,
) -> Result<(RelaySession, String)> {
    let invite_token = resolve_relay_invite_token(None, config);
    quadra_a_runtime::relay::connect_first_available_with_invite_token(
        explicit,
        config,
        did,
        card,
        keypair,
        invite_token.as_deref(),
    )
    .await
}
