use anyhow::Result;

use crate::config::load_config;
use crate::ui::LlmFormatter;

pub struct CardShowOptions {
    pub json: bool,
    pub human: bool,
}

pub async fn show(opts: CardShowOptions) -> Result<()> {
    let config = load_config()?;
    let card = config
        .agent_card
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No Agent Card found. Run `a4 listen` to create one."))?;

    if opts.json {
        println!("{}", serde_json::to_string_pretty(card)?);
        return Ok(());
    }

    if opts.human {
        use colored::Colorize;

        println!();
        println!("{}", "Agent Card".bold().cyan());
        println!();
        println!("  {}: {}", "Name".dimmed(), card.name);
        println!("  {}: {}", "Description".dimmed(), card.description);
        println!(
            "  {}: {}",
            "Capabilities".dimmed(),
            if card.capabilities.is_empty() {
                "(none)".to_string()
            } else {
                card.capabilities.join(", ")
            }
        );
        println!();
        return Ok(());
    }

    let capabilities = if card.capabilities.is_empty() {
        "(none)".to_string()
    } else {
        card.capabilities.join(", ")
    };

    LlmFormatter::section("Agent Card");
    LlmFormatter::key_value("Name", &card.name);
    LlmFormatter::key_value("Description", &card.description);
    LlmFormatter::key_value("Capabilities", &capabilities);
    println!();

    Ok(())
}
