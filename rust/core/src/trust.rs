use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{EndorsementV2, TrustConfig};

pub const FAST_DOMAINS: &[&str] = &["translation", "transcription", "data-entry", "moderation"];
pub const SLOW_DOMAINS: &[&str] = &["research", "architecture", "security-audit", "legal-review"];

pub struct TrustEngine {
    pub config: TrustConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustScore {
    pub score: f64,
    pub local_trust: f64,
    pub network_trust: f64,
    pub alpha: f64,
    pub endorsement_count: u32,
    pub interaction_count: u32,
    pub breakdown: TrustBreakdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustBreakdown {
    pub capability_endorsements: u32,
    pub reliability_endorsements: u32,
    pub general_endorsements: u32,
    pub recent_activity: ActivityLevel,
    pub network_position: NetworkPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActivityLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkPosition {
    Isolated,
    Connected,
    WellConnected,
    Central,
}

impl TrustEngine {
    pub fn new(mut config: TrustConfig) -> Self {
        if config.max_recursion_depth > 6 {
            config.max_recursion_depth = 6;
        }
        Self { config }
    }

    pub fn compute_trust_score(
        &mut self,
        target: &str,
        observer: &str,
        endorsements: &[EndorsementV2],
    ) -> Result<TrustScore> {
        if let Some(cached_score) = self.config.get_cached_trust_score(target) {
            return Ok(TrustScore {
                score: cached_score,
                local_trust: 0.0,
                network_trust: cached_score,
                alpha: 0.0,
                endorsement_count: 0,
                interaction_count: 0,
                breakdown: TrustBreakdown {
                    capability_endorsements: 0,
                    reliability_endorsements: 0,
                    general_endorsements: 0,
                    recent_activity: ActivityLevel::Medium,
                    network_position: NetworkPosition::Connected,
                },
            });
        }

        let active_endorsements: Vec<EndorsementV2> = endorsements
            .iter()
            .filter(|endorsement| !self.is_expired(endorsement))
            .cloned()
            .collect();

        let endorsements_by_target = self.build_endorsement_index(&active_endorsements);
        self.ensure_collusion_penalty_cache(&active_endorsements);

        let interaction_count = 0;
        let local_trust = self.get_local_trust(target, observer);
        let alpha = (interaction_count as f64 / 20.0).min(0.8);
        let network_trust =
            self.compute_network_trust(target, &endorsements_by_target, 0, HashSet::new());

        let final_score = (alpha * local_trust + (1.0 - alpha) * network_trust).clamp(0.0, 1.0);
        let breakdown = self.compute_breakdown(target, &active_endorsements);
        let endorsement_count = active_endorsements
            .iter()
            .filter(|endorsement| endorsement.endorsee == target)
            .count() as u32;

        self.config.cache_trust_score(
            target.to_string(),
            final_score,
            self.config.trust_cache_ttl_seconds,
        );

        Ok(TrustScore {
            score: final_score,
            local_trust,
            network_trust,
            alpha,
            endorsement_count,
            interaction_count,
            breakdown,
        })
    }

    pub fn detect_collusion(&self, endorsements: &[EndorsementV2]) -> Vec<Vec<String>> {
        let graph = self.build_graph(endorsements);
        let mut tarjan = TarjanScc::new();

        for node in graph.keys() {
            if !tarjan.indices.contains_key(node) {
                tarjan.dfs(node, &graph);
            }
        }

        tarjan
            .components
            .into_iter()
            .filter(|component| component.len() > 1)
            .collect()
    }

    fn get_local_trust(&self, _target: &str, _observer: &str) -> f64 {
        0.0
    }

    fn compute_network_trust(
        &self,
        target: &str,
        endorsements_by_target: &HashMap<String, Vec<EndorsementV2>>,
        depth: u8,
        mut visited: HashSet<String>,
    ) -> f64 {
        let target_endorsements = match endorsements_by_target.get(target) {
            Some(endorsements) if !endorsements.is_empty() => endorsements,
            _ => return 0.0,
        };

        if depth >= self.config.max_recursion_depth {
            return 0.1;
        }

        if !visited.insert(target.to_string()) {
            return 0.1;
        }

        let mut weighted_sum = 0.0;
        let mut total_weight = 0.0;

        for endorsement in target_endorsements {
            let endorser_weight = self.get_endorser_weight(
                &endorsement.endorser,
                endorsements_by_target,
                depth + 1,
                visited.clone(),
            );
            let time_decay = self.compute_time_decay(endorsement);
            let collusion_penalty = self.get_collusion_penalty(&endorsement.endorser);
            let base_weight = endorser_weight * collusion_penalty;

            weighted_sum += endorsement.strength * time_decay * base_weight;
            total_weight += base_weight;
        }

        if total_weight > 0.0 {
            (weighted_sum / total_weight).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    fn get_endorser_weight(
        &self,
        endorser: &str,
        endorsements_by_target: &HashMap<String, Vec<EndorsementV2>>,
        depth: u8,
        visited: HashSet<String>,
    ) -> f64 {
        if self.config.seed_peers.iter().any(|peer| peer == endorser) {
            return 1.0;
        }

        if depth >= self.config.max_recursion_depth {
            return 0.1;
        }

        if visited.contains(endorser) {
            return 0.1;
        }

        let Some(endorser_endorsements) = endorsements_by_target.get(endorser) else {
            return 0.1;
        };
        if endorser_endorsements.is_empty() {
            return 0.1;
        }

        let endorser_score =
            self.compute_network_trust(endorser, endorsements_by_target, depth, visited);

        0.1 + endorser_score * 0.9
    }

    fn compute_time_decay(&self, endorsement: &EndorsementV2) -> f64 {
        let now_millis = current_unix_millis();
        let age_millis = now_millis.saturating_sub(endorsement.timestamp);
        let age_days = age_millis as f64 / (24.0 * 60.0 * 60.0 * 1000.0);
        let half_life = self.get_decay_half_life(endorsement.domain.as_deref()) as f64;
        if half_life <= 0.0 {
            return 1.0;
        }
        (-age_days / half_life).exp()
    }

    fn get_decay_half_life(&self, domain: Option<&str>) -> u32 {
        match domain {
            None => *self.config.decay_half_life.get("default").unwrap_or(&90),
            Some(domain) if FAST_DOMAINS.contains(&domain) => {
                *self.config.decay_half_life.get(domain).unwrap_or(&30)
            }
            Some(domain) if SLOW_DOMAINS.contains(&domain) => {
                *self.config.decay_half_life.get(domain).unwrap_or(&180)
            }
            Some(domain) => self
                .config
                .decay_half_life
                .get(domain)
                .copied()
                .or_else(|| self.config.decay_half_life.get("default").copied())
                .unwrap_or(90),
        }
    }

    fn compute_breakdown(&self, target: &str, endorsements: &[EndorsementV2]) -> TrustBreakdown {
        let target_endorsements: Vec<&EndorsementV2> = endorsements
            .iter()
            .filter(|endorsement| endorsement.endorsee == target)
            .collect();

        let capability_endorsements = target_endorsements
            .iter()
            .filter(|endorsement| endorsement.endorsement_type == "capability")
            .count() as u32;
        let reliability_endorsements = target_endorsements
            .iter()
            .filter(|endorsement| endorsement.endorsement_type == "reliability")
            .count() as u32;
        let general_endorsements = target_endorsements
            .iter()
            .filter(|endorsement| endorsement.endorsement_type == "general")
            .count() as u32;

        let now_secs = current_unix_seconds();
        let recent_endorsements = target_endorsements
            .iter()
            .filter(|endorsement| {
                let age_days =
                    now_secs.saturating_sub(endorsement.timestamp / 1000) / (24 * 60 * 60);
                age_days <= 30
            })
            .count();

        let recent_activity = match recent_endorsements {
            0..=1 => ActivityLevel::Low,
            2..=5 => ActivityLevel::Medium,
            _ => ActivityLevel::High,
        };

        let total_endorsements = target_endorsements.len();
        let unique_endorsers = target_endorsements
            .iter()
            .map(|endorsement| endorsement.endorser.as_str())
            .collect::<HashSet<_>>()
            .len();

        let network_position = match (total_endorsements, unique_endorsers) {
            (0..=2, _) => NetworkPosition::Isolated,
            (3..=5, 1..=2) => NetworkPosition::Connected,
            (6..=15, 3..=8) => NetworkPosition::WellConnected,
            _ => NetworkPosition::Central,
        };

        TrustBreakdown {
            capability_endorsements,
            reliability_endorsements,
            general_endorsements,
            recent_activity,
            network_position,
        }
    }

    fn ensure_collusion_penalty_cache(&mut self, endorsements: &[EndorsementV2]) {
        let agents: HashSet<String> = endorsements
            .iter()
            .flat_map(|endorsement| [endorsement.endorser.clone(), endorsement.endorsee.clone()])
            .collect();

        if !agents.is_empty()
            && agents
                .iter()
                .all(|did| self.config.get_cached_collusion_penalty(did).is_some())
        {
            return;
        }

        self.rebuild_collusion_penalty_cache(endorsements, &agents);
    }

    fn rebuild_collusion_penalty_cache(
        &mut self,
        endorsements: &[EndorsementV2],
        agents: &HashSet<String>,
    ) {
        self.config.collusion_penalties.clear();

        for agent in agents {
            self.config.cache_collusion_penalty(
                agent.clone(),
                1.0,
                self.config.scc_cache_ttl_seconds,
            );
        }

        for component in self.detect_collusion(endorsements) {
            if component.len() < self.config.collusion_min_cluster_size {
                continue;
            }

            let members = component.iter().map(String::as_str).collect::<HashSet<_>>();
            let mut internal_edges = 0usize;
            let mut external_edges = 0usize;

            for endorsement in endorsements {
                if members.contains(endorsement.endorser.as_str()) {
                    if members.contains(endorsement.endorsee.as_str()) {
                        internal_edges += 1;
                    } else {
                        external_edges += 1;
                    }
                }
            }

            let ratio = external_edges as f64 / internal_edges.max(1) as f64;
            if ratio < self.config.collusion_external_ratio_threshold {
                for did in component {
                    self.config.cache_collusion_penalty(
                        did,
                        0.1,
                        self.config.scc_cache_ttl_seconds,
                    );
                }
            }
        }
    }

    fn get_collusion_penalty(&self, endorser: &str) -> f64 {
        self.config
            .get_cached_collusion_penalty(endorser)
            .unwrap_or(1.0)
    }

    fn build_endorsement_index(
        &self,
        endorsements: &[EndorsementV2],
    ) -> HashMap<String, Vec<EndorsementV2>> {
        let mut index = HashMap::new();
        for endorsement in endorsements {
            index
                .entry(endorsement.endorsee.clone())
                .or_insert_with(Vec::new)
                .push(endorsement.clone());
        }
        index
    }

    fn build_graph(&self, endorsements: &[EndorsementV2]) -> HashMap<String, Vec<String>> {
        let mut graph = HashMap::new();
        for endorsement in endorsements {
            graph
                .entry(endorsement.endorser.clone())
                .or_insert_with(Vec::new)
                .push(endorsement.endorsee.clone());
            graph
                .entry(endorsement.endorsee.clone())
                .or_insert_with(Vec::new);
        }
        graph
    }

    fn is_expired(&self, endorsement: &EndorsementV2) -> bool {
        endorsement
            .expires
            .map(|expires| expires < current_unix_millis())
            .unwrap_or(false)
    }
}

fn current_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn current_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct TarjanScc {
    index: usize,
    indices: HashMap<String, usize>,
    lowlinks: HashMap<String, usize>,
    stack: Vec<String>,
    on_stack: HashSet<String>,
    components: Vec<Vec<String>>,
}

impl TarjanScc {
    fn new() -> Self {
        Self {
            index: 0,
            indices: HashMap::new(),
            lowlinks: HashMap::new(),
            stack: Vec::new(),
            on_stack: HashSet::new(),
            components: Vec::new(),
        }
    }

    fn dfs(&mut self, node: &str, graph: &HashMap<String, Vec<String>>) {
        self.indices.insert(node.to_string(), self.index);
        self.lowlinks.insert(node.to_string(), self.index);
        self.index += 1;
        self.stack.push(node.to_string());
        self.on_stack.insert(node.to_string());

        if let Some(neighbors) = graph.get(node) {
            for neighbor in neighbors {
                if !self.indices.contains_key(neighbor) {
                    self.dfs(neighbor, graph);
                    let neighbor_lowlink = self.lowlinks[neighbor];
                    let current_lowlink = self.lowlinks[node];
                    self.lowlinks
                        .insert(node.to_string(), current_lowlink.min(neighbor_lowlink));
                } else if self.on_stack.contains(neighbor) {
                    let neighbor_index = self.indices[neighbor];
                    let current_lowlink = self.lowlinks[node];
                    self.lowlinks
                        .insert(node.to_string(), current_lowlink.min(neighbor_index));
                }
            }
        }

        if self.lowlinks[node] == self.indices[node] {
            let mut component = Vec::new();
            loop {
                let member = self.stack.pop().expect("stack member");
                self.on_stack.remove(&member);
                component.push(member.clone());
                if member == node {
                    break;
                }
            }
            self.components.push(component);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endorsement(
        endorser: &str,
        endorsee: &str,
        domain: Option<&str>,
        endorsement_type: &str,
        strength: f64,
        age_days: u64,
    ) -> EndorsementV2 {
        let now = current_unix_millis();
        EndorsementV2 {
            endorser: endorser.to_string(),
            endorsee: endorsee.to_string(),
            domain: domain.map(str::to_string),
            endorsement_type: endorsement_type.to_string(),
            strength,
            comment: Some("test".to_string()),
            timestamp: now - age_days * 24 * 60 * 60 * 1000,
            expires: Some(now + 24 * 60 * 60 * 1000),
            version: "2.0".to_string(),
            signature: "sig".to_string(),
        }
    }

    #[test]
    fn test_trust_computation() {
        let config = TrustConfig::new();
        let mut engine = TrustEngine::new(config);

        let endorsements = vec![endorsement(
            "did:test:alice",
            "did:test:bob",
            Some("translation"),
            "capability",
            0.9,
            1,
        )];

        let result = engine
            .compute_trust_score("did:test:bob", "did:test:observer", &endorsements)
            .unwrap();

        assert!(result.score > 0.0 && result.score <= 1.0);
        assert_eq!(result.endorsement_count, 1);
    }

    #[test]
    fn test_collusion_detection() {
        let engine = TrustEngine::new(TrustConfig::new());
        let endorsements = vec![
            endorsement("did:test:alice", "did:test:bob", None, "general", 0.9, 1),
            endorsement("did:test:bob", "did:test:alice", None, "general", 0.9, 1),
        ];

        let collusion_groups = engine.detect_collusion(&endorsements);
        assert_eq!(collusion_groups.len(), 1);
        assert_eq!(collusion_groups[0].len(), 2);
    }

    #[test]
    fn test_seed_peer_maps_to_full_weight() {
        let mut config = TrustConfig::new();
        config.seed_peers.push("did:test:seed".to_string());
        let mut engine = TrustEngine::new(config);

        let endorsements = vec![endorsement(
            "did:test:seed",
            "did:test:target",
            None,
            "general",
            0.8,
            1,
        )];

        let result = engine
            .compute_trust_score("did:test:target", "did:test:observer", &endorsements)
            .unwrap();

        assert!(result.network_trust > 0.7);
    }

    #[test]
    fn test_fast_domains_decay_faster_than_slow_domains() {
        let config = TrustConfig::new();
        let mut engine = TrustEngine::new(config);

        let fast = vec![endorsement(
            "did:test:alice",
            "did:test:target-fast",
            Some("translation"),
            "capability",
            1.0,
            90,
        )];
        let slow = vec![endorsement(
            "did:test:alice",
            "did:test:target-slow",
            Some("research"),
            "capability",
            1.0,
            90,
        )];

        let fast_score = engine
            .compute_trust_score("did:test:target-fast", "did:test:observer", &fast)
            .unwrap();
        let slow_score = engine
            .compute_trust_score("did:test:target-slow", "did:test:observer", &slow)
            .unwrap();

        assert!(slow_score.network_trust > fast_score.network_trust);
    }

    #[test]
    fn test_collusion_penalty_cache_is_populated() {
        let mut config = TrustConfig::new();
        config.collusion_min_cluster_size = 4;
        config.collusion_external_ratio_threshold = 0.3;
        let mut engine = TrustEngine::new(config);

        let endorsements = vec![
            endorsement("a", "b", None, "general", 0.9, 1),
            endorsement("b", "c", None, "general", 0.9, 1),
            endorsement("c", "d", None, "general", 0.9, 1),
            endorsement("d", "a", None, "general", 0.9, 1),
            endorsement("a", "target", None, "general", 0.9, 1),
        ];

        let _ = engine
            .compute_trust_score("target", "observer", &endorsements)
            .unwrap();

        assert_eq!(engine.config.get_cached_collusion_penalty("a"), Some(0.1));
        assert_eq!(
            engine.config.get_cached_collusion_penalty("target"),
            Some(1.0)
        );
    }
}
