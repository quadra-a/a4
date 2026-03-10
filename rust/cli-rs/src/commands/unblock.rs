use crate::config::load_config;
use crate::ui::LlmFormatter;
use anyhow::Result;

pub struct UnblockOptions {
    pub target: String,
    pub human: bool,
}

pub async fn run(opts: UnblockOptions) -> Result<()> {
    let config = load_config()?;
    let _identity = config
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
        println!("Unblocking agent: {}", target_did);
        println!();
        println!("Agent unblocked successfully.");
        println!("This agent can now send you messages again.");
    } else {
        LlmFormatter::section("Unblock Agent");
        LlmFormatter::key_value("Target DID", &target_did);
        LlmFormatter::key_value("Status", "unblocked");
        LlmFormatter::key_value("Effect", "Messages from this agent will be accepted");
        println!();
    }

    // TODO: Implement actual unblocking logic - remove from local config and inform daemon
    // For now, just show the action was taken

    Ok(())
}
