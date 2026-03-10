use anyhow::{Context, Result};
use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub identity: Option<IdentityConfig>,
    #[serde(rename = "agentCard")]
    pub agent_card: Option<AgentCardConfig>,
    #[serde(default)]
    pub published: Option<bool>,
    #[serde(default, rename = "relayInviteToken")]
    pub relay_invite_token: Option<String>,
    #[serde(default)]
    pub aliases: HashMap<String, String>,
    #[serde(default, rename = "trustConfig")]
    pub trust_config: Option<TrustConfig>,
    #[serde(default, rename = "reachabilityPolicy")]
    pub reachability_policy: Option<ReachabilityPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReachabilityMode {
    Adaptive,
    Fixed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReachabilityPolicy {
    pub mode: ReachabilityMode,
    #[serde(default, rename = "bootstrapProviders")]
    pub bootstrap_providers: Vec<String>,
    #[serde(
        default = "default_target_provider_count",
        rename = "targetProviderCount"
    )]
    pub target_provider_count: u32,
    #[serde(
        default = "default_auto_discover_providers",
        rename = "autoDiscoverProviders"
    )]
    pub auto_discover_providers: bool,
    #[serde(default, rename = "operatorLock")]
    pub operator_lock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityConfig {
    pub did: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "privateKey")]
    pub private_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCardConfig {
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrustConfig {
    #[serde(default)]
    pub endorsements: HashMap<String, EndorsementV2>,
    #[serde(default)]
    pub trust_scores: HashMap<String, CachedTrustScore>,
    #[serde(default)]
    pub blocked_agents: HashSet<String>,
    #[serde(default)]
    pub seed_peers: Vec<String>,
    #[serde(default = "default_max_recursion_depth")]
    pub max_recursion_depth: u8,
    #[serde(default)]
    pub decay_half_life: HashMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndorsementV2 {
    pub endorser: String,
    pub endorsee: String,
    pub domain: Option<String>,
    #[serde(rename = "type")]
    pub endorsement_type: String,
    pub strength: f64,
    pub comment: Option<String>,
    pub timestamp: u64,
    pub expires: Option<u64>,
    pub version: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedTrustScore {
    pub score: f64,
    pub computed_at: u64,
    pub ttl: u64,
}

fn default_max_recursion_depth() -> u8 {
    3
}

fn default_target_provider_count() -> u32 {
    3
}

fn default_auto_discover_providers() -> bool {
    true
}

fn default_bootstrap_providers() -> Vec<String> {
    vec!["ws://relay-sg-1.quadra-a.com:8080".to_string()]
}

pub fn config_dir() -> PathBuf {
    let base = std::env::var("QUADRA_A_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".quadra-a")
        });
    base
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

fn normalize_optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_provider_urls(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values.into_iter().map(|value| value.trim().to_string()) {
        if value.is_empty() || normalized.iter().any(|existing| existing == &value) {
            continue;
        }
        normalized.push(value);
    }
    normalized
}

fn env_bootstrap_providers() -> Vec<String> {
    let env_value = std::env::var("QUADRA_A_RELAY_URLS")
        .ok()
        .or_else(|| std::env::var("HW1_RELAY_URLS").ok());

    let providers = env_value
        .map(|value| {
            value
                .split(',')
                .map(|entry| entry.trim().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let normalized = normalize_provider_urls(providers);
    if normalized.is_empty() {
        default_bootstrap_providers()
    } else {
        normalized
    }
}

fn env_disable_auto_relay_supplement() -> bool {
    normalize_optional_string(
        std::env::var("QUADRA_A_DISABLE_AUTO_RELAY_SUPPLEMENT")
            .ok()
            .as_deref(),
    )
    .map(|value| matches!(value.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
    .unwrap_or(false)
}

impl Default for ReachabilityPolicy {
    fn default() -> Self {
        let auto_discover_providers = !env_disable_auto_relay_supplement();
        Self {
            mode: if auto_discover_providers {
                ReachabilityMode::Adaptive
            } else {
                ReachabilityMode::Fixed
            },
            bootstrap_providers: env_bootstrap_providers(),
            target_provider_count: default_target_provider_count(),
            auto_discover_providers,
            operator_lock: false,
        }
    }
}

pub fn resolve_reachability_policy(
    explicit_relay: Option<&str>,
    config: Option<&Config>,
) -> ReachabilityPolicy {
    let mut policy = config
        .and_then(|cfg| cfg.reachability_policy.clone())
        .unwrap_or_default();

    if policy.bootstrap_providers.is_empty() {
        policy.bootstrap_providers = env_bootstrap_providers();
    } else {
        policy.bootstrap_providers = normalize_provider_urls(policy.bootstrap_providers);
    }

    if let Some(relay) = normalize_optional_string(explicit_relay) {
        policy.bootstrap_providers = vec![relay];
        policy.mode = ReachabilityMode::Fixed;
        policy.auto_discover_providers = false;
        policy.target_provider_count = 1;
    }

    if policy.target_provider_count == 0 {
        policy.target_provider_count = default_target_provider_count();
    }

    if matches!(policy.mode, ReachabilityMode::Fixed) && policy.bootstrap_providers.is_empty() {
        policy.bootstrap_providers = default_bootstrap_providers();
    }

    if policy.bootstrap_providers.is_empty() {
        policy.bootstrap_providers = default_bootstrap_providers();
    }

    policy
}

pub fn resolve_relay_invite_token(
    explicit: Option<&str>,
    config: Option<&Config>,
) -> Option<String> {
    normalize_optional_string(explicit)
        .or_else(|| {
            normalize_optional_string(std::env::var("QUADRA_A_INVITE_TOKEN").ok().as_deref())
        })
        .or_else(|| normalize_optional_string(std::env::var("HW1_INVITE_TOKEN").ok().as_deref()))
        .or_else(|| {
            config.and_then(|cfg| normalize_optional_string(cfg.relay_invite_token.as_deref()))
        })
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

    // Atomic write: write to temp file then rename
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, data)
        .with_context(|| format!("Failed to write temp config to {}", temp_path.display()))?;

    fs::rename(&temp_path, &path)
        .with_context(|| format!("Failed to rename temp config to {}", path.display()))?;

    Ok(())
}

impl TrustConfig {
    pub fn new() -> Self {
        let mut decay_half_life = HashMap::new();
        decay_half_life.insert("default".to_string(), 90);
        decay_half_life.insert("translation".to_string(), 30);
        decay_half_life.insert("research".to_string(), 180);

        Self {
            endorsements: HashMap::new(),
            trust_scores: HashMap::new(),
            blocked_agents: HashSet::new(),
            seed_peers: Vec::new(),
            max_recursion_depth: 3,
            decay_half_life,
        }
    }

    pub fn add_endorsement(&mut self, endorsement: EndorsementV2) {
        let key = format!(
            "{}:{}",
            endorsement.endorsee,
            endorsement.domain.as_deref().unwrap_or("default")
        );
        self.endorsements.insert(key, endorsement);
    }

    pub fn block_agent(&mut self, did: String) {
        self.blocked_agents.insert(did);
    }

    #[allow(dead_code)]
    pub fn unblock_agent(&mut self, did: &str) {
        self.blocked_agents.remove(did);
    }

    #[allow(dead_code)]
    pub fn is_blocked(&self, did: &str) -> bool {
        self.blocked_agents.contains(did)
    }

    pub fn cache_trust_score(&mut self, did: String, score: f64, ttl_seconds: u64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        self.trust_scores.insert(
            did,
            CachedTrustScore {
                score,
                computed_at: now,
                ttl: ttl_seconds,
            },
        );
    }

    pub fn get_cached_trust_score(&self, did: &str) -> Option<f64> {
        if let Some(cached) = self.trust_scores.get(did) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            if now - cached.computed_at < cached.ttl {
                return Some(cached.score);
            }
        }
        None
    }
}
