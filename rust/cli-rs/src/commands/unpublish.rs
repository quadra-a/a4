use crate::config::{load_config, save_config};
use crate::identity::KeyPair;
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct UnpublishOptions {
    pub relay: Option<String>,
    pub human: bool,
}

pub async fn run(opts: UnpublishOptions) -> Result<()> {
    let mut config = load_config()?;
    let identity = config
        .identity
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No identity found. Run `agent listen` to create one."))?;

    let keypair = KeyPair::from_hex(&identity.private_key)?;
    let card = crate::commands::discover::build_card(&config, identity)?;
    let (mut session, relay_url) =
        connect_first_available(opts.relay.as_deref(), Some(&config), &identity.did, &card, &keypair).await?;

    if opts.human {
        println!("Unpublishing agent card from relay: {}", relay_url);
        println!("Agent: {} ({})", card.name, card.did);
    }
    session.unpublish_card().await?;
    let _ = session.goodbye().await;

    let status = if config.published == Some(true) {
        "unpublished"
    } else {
        "not_found"
    };

    config.published = Some(false);
    save_config(&config)?;

    if opts.human {
        match status {
            "unpublished" => {
                println!("✓ Agent card unpublished successfully");
                println!("Your agent is no longer discoverable on the relay");
            }
            "not_found" => {
                println!("Agent card was not published on this relay");
            }
            "error" => {
                anyhow::bail!("Failed to unpublish card: relay error");
            }
            _ => {
                println!("Card unpublish status: {}", status);
            }
        }
    } else {
        LlmFormatter::section("Unpublish Agent Card");
        LlmFormatter::key_value("Relay", &relay_url);
        LlmFormatter::key_value("Agent DID", &identity.did);
        LlmFormatter::key_value("Status", status);
        LlmFormatter::key_value("Discoverable", "false");
        println!();
    }

    Ok(())
}
