use crate::e2e::LocalE2EConfig;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub identity: Option<IdentityConfig>,
    #[serde(default, rename = "deviceIdentity")]
    pub device_identity: Option<DeviceIdentityConfig>,
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
    #[serde(default)]
    pub e2e: Option<LocalE2EConfig>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceIdentityConfig {
    pub seed: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCardConfig {
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustConfig {
    #[serde(default)]
    pub endorsements: HashMap<String, EndorsementV2>,
    #[serde(default)]
    pub trust_scores: HashMap<String, CachedTrustScore>,
    #[serde(default)]
    pub blocked_agents: HashSet<String>,
    #[serde(default)]
    pub blocked_reasons: HashMap<String, String>,
    #[serde(default)]
    pub allowed_agents: HashMap<String, AllowedAgent>,
    #[serde(default)]
    pub collusion_penalties: HashMap<String, CachedCollusionPenalty>,
    #[serde(default)]
    pub seed_peers: Vec<String>,
    #[serde(default = "default_max_recursion_depth")]
    pub max_recursion_depth: u8,
    #[serde(default)]
    pub decay_half_life: HashMap<String, u32>,
    #[serde(default = "default_collusion_external_ratio_threshold")]
    pub collusion_external_ratio_threshold: f64,
    #[serde(default = "default_collusion_min_cluster_size")]
    pub collusion_min_cluster_size: usize,
    #[serde(default = "default_trust_cache_ttl_seconds")]
    pub trust_cache_ttl_seconds: u64,
    #[serde(default = "default_scc_cache_ttl_seconds")]
    pub scc_cache_ttl_seconds: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedCollusionPenalty {
    pub penalty: f64,
    pub computed_at: u64,
    pub ttl: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AllowedAgent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, rename = "addedAt", skip_serializing_if = "Option::is_none")]
    pub added_at: Option<u64>,
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

fn default_collusion_external_ratio_threshold() -> f64 {
    0.2
}

fn default_collusion_min_cluster_size() -> usize {
    4
}

fn default_trust_cache_ttl_seconds() -> u64 {
    300
}

fn default_scc_cache_ttl_seconds() -> u64 {
    300
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

fn current_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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

impl Default for TrustConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl TrustConfig {
    pub fn new() -> Self {
        let mut decay_half_life = HashMap::new();
        decay_half_life.insert("default".to_string(), 90);
        decay_half_life.insert("translation".to_string(), 30);
        decay_half_life.insert("transcription".to_string(), 30);
        decay_half_life.insert("data-entry".to_string(), 30);
        decay_half_life.insert("moderation".to_string(), 30);
        decay_half_life.insert("research".to_string(), 180);
        decay_half_life.insert("architecture".to_string(), 180);
        decay_half_life.insert("security-audit".to_string(), 180);
        decay_half_life.insert("legal-review".to_string(), 180);

        Self {
            endorsements: HashMap::new(),
            trust_scores: HashMap::new(),
            blocked_agents: HashSet::new(),
            blocked_reasons: HashMap::new(),
            allowed_agents: HashMap::new(),
            collusion_penalties: HashMap::new(),
            seed_peers: Vec::new(),
            max_recursion_depth: default_max_recursion_depth(),
            decay_half_life,
            collusion_external_ratio_threshold: default_collusion_external_ratio_threshold(),
            collusion_min_cluster_size: default_collusion_min_cluster_size(),
            trust_cache_ttl_seconds: default_trust_cache_ttl_seconds(),
            scc_cache_ttl_seconds: default_scc_cache_ttl_seconds(),
        }
    }

    pub fn add_endorsement(&mut self, endorsement: EndorsementV2) {
        self.endorsements
            .insert(endorsement_cache_key(&endorsement), endorsement);
    }

    pub fn block_agent(&mut self, did: String) {
        self.blocked_agents.insert(did.clone());
        self.allowed_agents.remove(&did);
    }

    pub fn block_agent_with_reason(&mut self, did: String, reason: Option<String>) {
        self.block_agent(did.clone());
        if let Some(reason) = reason.map(|value| value.trim().to_string()) {
            if !reason.is_empty() {
                self.blocked_reasons.insert(did, reason);
            }
        }
    }

    pub fn unblock_agent(&mut self, did: &str) {
        self.blocked_agents.remove(did);
        self.blocked_reasons.remove(did);
    }

    pub fn is_blocked(&self, did: &str) -> bool {
        self.blocked_agents.contains(did)
    }

    pub fn blocked_reason(&self, did: &str) -> Option<&str> {
        self.blocked_reasons.get(did).map(String::as_str)
    }

    pub fn allow_agent(&mut self, did: String, note: Option<String>) {
        self.unblock_agent(&did);
        self.allowed_agents.insert(
            did,
            AllowedAgent {
                note: note
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                added_at: Some(current_unix_seconds()),
            },
        );
    }

    pub fn is_allowed(&self, did: &str) -> bool {
        self.allowed_agents.contains_key(did)
    }

    pub fn cache_trust_score(&mut self, did: String, score: f64, ttl_seconds: u64) {
        self.trust_scores.insert(
            did,
            CachedTrustScore {
                score,
                computed_at: current_unix_seconds(),
                ttl: ttl_seconds,
            },
        );
    }

    pub fn get_cached_trust_score(&self, did: &str) -> Option<f64> {
        self.trust_scores.get(did).and_then(|cached| {
            let now = current_unix_seconds();
            if now.saturating_sub(cached.computed_at) < cached.ttl {
                Some(cached.score)
            } else {
                None
            }
        })
    }

    pub fn cache_collusion_penalty(&mut self, did: String, penalty: f64, ttl_seconds: u64) {
        self.collusion_penalties.insert(
            did,
            CachedCollusionPenalty {
                penalty,
                computed_at: current_unix_seconds(),
                ttl: ttl_seconds,
            },
        );
    }

    pub fn get_cached_collusion_penalty(&self, did: &str) -> Option<f64> {
        self.collusion_penalties.get(did).and_then(|cached| {
            let now = current_unix_seconds();
            if now.saturating_sub(cached.computed_at) < cached.ttl {
                Some(cached.penalty)
            } else {
                None
            }
        })
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

pub fn endorsement_cache_key(endorsement: &EndorsementV2) -> String {
    format!(
        "{}:{}:{}:{}",
        endorsement.endorser,
        endorsement.endorsee,
        endorsement.domain.as_deref().unwrap_or("*"),
        endorsement.endorsement_type
    )
}

#[cfg(test)]
mod tests {
    use super::Config;
    use crate::e2e::ensure_local_e2e_config;
    use crate::identity::{derive_did, KeyPair};
    use serde_json::json;

    #[test]
    fn parses_empty_e2e_config_and_rebuilds_valid_state() {
        let keypair = KeyPair::generate();
        let did = derive_did(keypair.verifying_key.as_bytes());
        let mut config: Config = serde_json::from_value(json!({
            "identity": {
                "did": did,
                "publicKey": keypair.public_key_hex(),
                "privateKey": keypair.private_key_hex(),
            },
            "e2e": {}
        }))
        .expect("config parses");

        assert!(config.e2e.as_ref().is_some_and(|e2e| !e2e.is_valid()));

        let created = ensure_local_e2e_config(&mut config).expect("e2e config rebuilt");
        assert!(created);
        assert!(config.e2e.as_ref().is_some_and(|e2e| e2e.is_valid()));
        assert!(config
            .device_identity
            .as_ref()
            .is_some_and(|device_identity| !device_identity.seed.is_empty()
                && !device_identity.device_id.is_empty()));
    }

    #[test]
    fn backfills_device_identity_from_existing_device_id() {
        let keypair = KeyPair::generate();
        let did = derive_did(keypair.verifying_key.as_bytes());
        let device_id = "device-existing".to_string();
        let mut config: Config = serde_json::from_value(json!({
            "identity": {
                "did": did,
                "publicKey": keypair.public_key_hex(),
                "privateKey": keypair.private_key_hex(),
            },
            "e2e": {
                "currentDeviceId": device_id,
                "devices": {
                    "device-existing": {
                        "deviceId": "device-existing",
                        "createdAt": 1,
                        "identityKey": {
                            "publicKey": "11",
                            "privateKey": "22"
                        },
                        "signedPreKey": {
                            "signedPreKeyId": 1,
                            "publicKey": "33",
                            "privateKey": "44",
                            "signature": "55",
                            "createdAt": 1
                        },
                        "oneTimePreKeys": [],
                        "lastResupplyAt": 1,
                        "sessions": {}
                    }
                }
            }
        }))
        .expect("config parses");

        let created = ensure_local_e2e_config(&mut config).expect("device identity backfilled");
        assert!(!created);
        assert_eq!(
            config
                .device_identity
                .as_ref()
                .expect("device identity present")
                .device_id,
            "device-existing"
        );
    }
}
