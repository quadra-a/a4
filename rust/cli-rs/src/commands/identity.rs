use anyhow::{bail, Result};

use crate::config::load_config;
use crate::ui::LlmFormatter;

pub struct IdentityShowOptions {
    pub json: bool,
    pub human: bool,
}

pub async fn show(opts: IdentityShowOptions) -> Result<()> {
    let config = load_config()?;
    let identity = match &config.identity {
        Some(identity) => identity,
        None => bail!("No identity found. Run `a4 listen` to create one."),
    };

    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "did": identity.did,
                "publicKey": identity.public_key,
            }))?
        );
        return Ok(());
    }

    if opts.human {
        use colored::Colorize;

        println!();
        println!("{}", "Agent Identity".bold().cyan());
        println!();
        println!("  {}: {}", "DID".dimmed(), identity.did);
        println!("  {}: {}", "Public Key".dimmed(), identity.public_key);
        println!();
        return Ok(());
    }

    LlmFormatter::section("Agent Identity");
    LlmFormatter::key_value("DID", &identity.did);
    LlmFormatter::key_value("Public Key", &identity.public_key);
    println!();

    Ok(())
}
