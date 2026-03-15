use anyhow::{Context, Result};
use dirs::home_dir;
use std::fs;
use std::path::PathBuf;

pub use quadra_a_core::config::{
    resolve_reachability_policy, resolve_relay_invite_token, AgentCardConfig, Config,
    EndorsementV2, IdentityConfig, ReachabilityMode, ReachabilityPolicy, TrustConfig,
};

pub fn config_dir() -> PathBuf {
    std::env::var("QUADRA_A_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".quadra-a")
        })
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load_config() -> Result<Config> {
    let path = config_path();
    if !path.exists() {
        return Ok(Config::default());
    }

    let data = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config at {}", path.display()))?;
    let config: Config =
        serde_json::from_str(&data).with_context(|| "Failed to parse config.json")?;
    Ok(config)
}

pub fn save_config(config: &Config) -> Result<()> {
    let dir = config_dir();
    fs::create_dir_all(&dir)
        .with_context(|| format!("Failed to create config dir {}", dir.display()))?;

    let path = config_path();
    let data = serde_json::to_string_pretty(config)?;

    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, data)
        .with_context(|| format!("Failed to write temp config to {}", temp_path.display()))?;

    fs::rename(&temp_path, &path)
        .with_context(|| format!("Failed to rename temp config to {}", path.display()))?;

    Ok(())
}

pub fn build_card(config: &Config, identity: &IdentityConfig) -> Result<crate::protocol::AgentCard> {
    quadra_a_runtime::card::build_agent_card_from_config(config, identity)
}
