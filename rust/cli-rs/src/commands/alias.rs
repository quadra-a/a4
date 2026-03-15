use crate::config::{load_config, save_config};
use anyhow::{bail, Result};

pub struct AliasSetOptions {
    pub name: String,
    pub did: String,
    pub json: bool,
}

pub struct AliasListOptions {
    pub human: bool,
}

pub struct AliasGetOptions {
    pub name: String,
}

pub struct AliasRemoveOptions {
    pub name: String,
}

/// Validate alias name according to CVP-0014 rules
fn validate_alias_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("Alias name cannot be empty");
    }

    if name.len() > 32 {
        bail!("Alias name cannot exceed 32 characters");
    }

    if name.starts_with("did:") {
        bail!("Alias name cannot start with 'did:' (reserved for DID prefix)");
    }

    // Check lowercase alphanumeric + hyphens
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        bail!("Alias name must contain only lowercase letters, numbers, and hyphens");
    }

    // Cannot start with hyphen
    if name.starts_with('-') {
        bail!("Alias name cannot start with a hyphen");
    }

    Ok(())
}

pub fn set(opts: AliasSetOptions) -> Result<()> {
    validate_alias_name(&opts.name)?;

    let mut config = load_config()?;
    config.aliases.insert(opts.name.clone(), opts.did.clone());
    save_config(&config)?;

    if opts.json {
        println!(
            "{}",
            serde_json::json!({
                "name": opts.name,
                "did": opts.did,
            })
        );
    } else {
        println!("ALIAS SET\n");
        println!("Name: {}", opts.name);
        println!("DID: {}", opts.did);
        println!();
    }

    Ok(())
}

pub fn list(opts: AliasListOptions) -> Result<()> {
    let config = load_config()?;

    if config.aliases.is_empty() {
        if opts.human {
            println!("\nNo aliases configured.\n");
        } else {
            println!("ALIASES\n");
            println!("Total: 0\n");
        }
        return Ok(());
    }

    if opts.human {
        println!("\nAliases ({} total)\n", config.aliases.len());
        for (name, did) in config.aliases.iter() {
            let short_did = if did.len() > 40 {
                format!("{}...{}", &did[..20], &did[did.len() - 8..])
            } else {
                did.clone()
            };
            println!("  {} → {}", name, short_did);
        }
        println!();
    } else {
        println!("ALIASES\n");
        println!("Total: {}\n", config.aliases.len());

        // Sort by name for consistent output
        let mut aliases: Vec<_> = config.aliases.iter().collect();
        aliases.sort_by_key(|(name, _)| *name);

        for (name, did) in aliases {
            println!("Name: {}", name);
            println!("DID: {}", did);
            println!();
        }
    }

    Ok(())
}

pub fn get(opts: AliasGetOptions) -> Result<()> {
    let config = load_config()?;

    match config.aliases.get(&opts.name) {
        Some(did) => {
            println!("ALIAS\n");
            println!("Name: {}", opts.name);
            println!("DID: {}", did);
            println!();
            Ok(())
        }
        None => {
            bail!("Alias not found: {}", opts.name);
        }
    }
}

pub fn remove(opts: AliasRemoveOptions) -> Result<()> {
    let mut config = load_config()?;

    if config.aliases.remove(&opts.name).is_some() {
        save_config(&config)?;
        println!("ALIAS REMOVED\n");
        println!("Name: {}", opts.name);
        println!();
        Ok(())
    } else {
        bail!("Alias not found: {}", opts.name);
    }
}

/// Resolve a DID from an alias or return the input if it's already a DID
pub fn resolve_did(input: &str, config: &crate::config::Config) -> Option<String> {
    // If it starts with "did:", return as-is
    if input.starts_with("did:") {
        return Some(input.to_string());
    }

    // Try to resolve as alias
    config.aliases.get(input).cloned()
}
