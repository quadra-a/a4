use crate::config::{load_config, save_config};
use crate::identity::KeyPair;
use crate::relay::connect_first_available;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct PublishOptions {
    pub relay: Option<String>,
    pub human: bool,
}

pub async fn run(opts: PublishOptions) -> Result<()> {
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
        println!("Publishing agent card to relay: {}", relay_url);
        println!("Agent: {} ({})", card.name, card.did);
    }
    session.publish_card().await?;
    let _ = session.goodbye().await;

    let status = if config.published == Some(true) {
        "updated"
    } else {
        "published"
    };

    config.published = Some(true);
    save_config(&config)?;

    if opts.human {
        match status {
            "published" => {
                println!("✓ Agent card published successfully");
                println!("Your agent is now discoverable on the relay");
            }
            "updated" => {
                println!("✓ Agent card updated successfully");
                println!("Your existing card has been refreshed");
            }
            "error" => {
                anyhow::bail!("Failed to publish card: relay error");
            }
            _ => {
                println!("Card publish status: {}", status);
            }
        }
    } else {
        LlmFormatter::section("Publish Agent Card");
        LlmFormatter::key_value("Relay", &relay_url);
        LlmFormatter::key_value("Agent DID", &card.did);
        LlmFormatter::key_value("Agent Name", &card.name);
        LlmFormatter::key_value("Status", status);
        LlmFormatter::key_value(
            "Discoverable",
            if status == "published" || status == "updated" {
                "true"
            } else {
                "false"
            },
        );
        println!();
    }

    Ok(())
}
