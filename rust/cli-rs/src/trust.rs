/// CVP-0017 EigenTrust-lite algorithm implementation.
///
/// This module implements a simplified version of the EigenTrust algorithm
/// for computing trust scores in a decentralized network of agents.
///
/// Key features:
/// - Recursive endorser credibility weighting
/// - Domain-aware time decay
/// - Collusion detection using strongly connected components
/// - Configurable recursion depth and caching
use anyhow::Result;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::{EndorsementV2, TrustConfig};

/// Trust computation engine implementing CVP-0017 EigenTrust-lite
pub struct TrustEngine {
    pub config: TrustConfig,
}

/// Trust computation result with breakdown
#[derive(Debug, Clone)]
pub struct TrustScore {
    pub score: f64,
    pub local_trust: f64,
    pub network_trust: f64,
    pub alpha: f64,
    pub endorsement_count: u32,
    pub interaction_count: u32,
    pub breakdown: TrustBreakdown,
}

#[derive(Debug, Clone)]
pub struct TrustBreakdown {
    pub capability_endorsements: u32,
    pub reliability_endorsements: u32,
    pub general_endorsements: u32,
    pub recent_activity: ActivityLevel,
    pub network_position: NetworkPosition,
}

#[derive(Debug, Clone)]
pub enum ActivityLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone)]
pub enum NetworkPosition {
    Isolated,
    Connected,
    WellConnected,
    Central,
}

impl TrustEngine {
    pub fn new(config: TrustConfig) -> Self {
        Self { config }
    }

    /// Compute trust score for a target agent from the perspective of an observer
    pub fn compute_trust_score(
        &mut self,
        target: &str,
        observer: &str,
        endorsements: &[EndorsementV2],
    ) -> Result<TrustScore> {
        // Check cache first
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

        let alpha = self.calculate_alpha(target, observer, endorsements);
        let local_trust = self.get_local_trust(target, observer);
        let network_trust = self.compute_network_trust(target, observer, endorsements)?;

        let final_score = alpha * local_trust + (1.0 - alpha) * network_trust;

        let breakdown = self.compute_breakdown(target, endorsements);
        let endorsement_count = endorsements.iter().filter(|e| e.endorsee == target).count() as u32;

        let trust_score = TrustScore {
            score: final_score,
            local_trust,
            network_trust,
            alpha,
            endorsement_count,
            interaction_count: 0, // TODO: Track actual interactions
            breakdown,
        };

        // Cache the result
        self.config
            .cache_trust_score(target.to_string(), final_score, 300); // 5 minute TTL

        Ok(trust_score)
    }

    /// Calculate alpha parameter based on direct interactions between observer and target
    fn calculate_alpha(
        &self,
        _target: &str,
        _observer: &str,
        endorsements: &[EndorsementV2],
    ) -> f64 {
        // Simple heuristic: more endorsements = rely more on network trust
        let endorsement_count = endorsements.len() as f64;
        let base_alpha = 0.3; // Base weight for local trust
        let decay_factor = 0.05;

        // As endorsement count increases, rely more on network (lower alpha)
        (base_alpha * (-decay_factor * endorsement_count).exp())
            .max(0.1)
            .min(0.9)
    }

    /// Get local trust based on direct interactions (placeholder for now)
    fn get_local_trust(&self, _target: &str, _observer: &str) -> f64 {
        // TODO: Implement based on actual interaction history
        // For now, return neutral trust
        0.5
    }

    /// Compute network trust using EigenTrust-lite algorithm
    fn compute_network_trust(
        &self,
        target: &str,
        observer: &str,
        endorsements: &[EndorsementV2],
    ) -> Result<f64> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Filter endorsements for the target and apply time decay
        let target_endorsements: Vec<_> = endorsements
            .iter()
            .filter(|e| e.endorsee == target)
            .map(|e| {
                let age_days = (now - (e.timestamp / 1000)) / (24 * 60 * 60);
                let domain = e.domain.as_deref().unwrap_or("default");
                let half_life = self
                    .config
                    .decay_half_life
                    .get(domain)
                    .or_else(|| self.config.decay_half_life.get("default"))
                    .copied()
                    .unwrap_or(90) as u64;

                let decay_factor = 0.5_f64.powf(age_days as f64 / half_life as f64);
                let decayed_strength = e.strength * decay_factor;

                (e, decayed_strength)
            })
            .collect();

        if target_endorsements.is_empty() {
            return Ok(0.5); // Neutral trust for unknown agents
        }

        // Compute weighted trust score
        let mut total_weight = 0.0;
        let mut weighted_sum = 0.0;

        for (endorsement, decayed_strength) in &target_endorsements {
            // Get endorser's credibility (recursive trust computation with depth limit)
            let endorser_credibility = if endorsement.endorser == observer {
                1.0 // Observer trusts themselves completely
            } else {
                self.get_endorser_credibility(&endorsement.endorser, observer, endorsements, 0)?
            };

            let weight = endorser_credibility;
            weighted_sum += decayed_strength * weight;
            total_weight += weight;
        }

        if total_weight > 0.0 {
            Ok((weighted_sum / total_weight).max(0.0).min(1.0))
        } else {
            Ok(0.5)
        }
    }

    /// Get credibility of an endorser (recursive with depth limit)
    fn get_endorser_credibility(
        &self,
        endorser: &str,
        observer: &str,
        endorsements: &[EndorsementV2],
        depth: u8,
    ) -> Result<f64> {
        if depth >= self.config.max_recursion_depth {
            return Ok(0.5); // Neutral credibility at max depth
        }

        if endorser == observer {
            return Ok(1.0); // Observer trusts themselves
        }

        // Check if endorser is in seed peers (high trust)
        if self.config.seed_peers.contains(&endorser.to_string()) {
            return Ok(0.9);
        }

        // Recursively compute endorser's trust score
        let endorser_endorsements: Vec<_> = endorsements
            .iter()
            .filter(|e| e.endorsee == endorser)
            .cloned()
            .collect();

        if endorser_endorsements.is_empty() {
            return Ok(0.3); // Low credibility for unknown endorsers
        }

        // Simple recursive computation (could be optimized with memoization)
        let credibility = self.compute_network_trust(endorser, observer, endorsements)?;
        Ok(credibility)
    }

    /// Compute trust breakdown for display
    fn compute_breakdown(&self, target: &str, endorsements: &[EndorsementV2]) -> TrustBreakdown {
        let target_endorsements: Vec<_> = endorsements
            .iter()
            .filter(|e| e.endorsee == target)
            .collect();

        let capability_endorsements = target_endorsements
            .iter()
            .filter(|e| e.endorsement_type == "capability")
            .count() as u32;

        let reliability_endorsements = target_endorsements
            .iter()
            .filter(|e| e.endorsement_type == "reliability")
            .count() as u32;

        let general_endorsements = target_endorsements
            .iter()
            .filter(|e| e.endorsement_type == "general")
            .count() as u32;

        // Determine activity level based on recent endorsements
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let recent_endorsements = target_endorsements
            .iter()
            .filter(|e| {
                let age_days = (now - (e.timestamp / 1000)) / (24 * 60 * 60);
                age_days <= 30 // Last 30 days
            })
            .count();

        let recent_activity = match recent_endorsements {
            0..=1 => ActivityLevel::Low,
            2..=5 => ActivityLevel::Medium,
            _ => ActivityLevel::High,
        };

        // Determine network position based on endorsement count and diversity
        let total_endorsements = target_endorsements.len();
        let unique_endorsers = target_endorsements
            .iter()
            .map(|e| &e.endorser)
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

    /// Detect collusion using Tarjan's strongly connected components algorithm
    #[allow(dead_code)]
    pub fn detect_collusion(&self, endorsements: &[EndorsementV2]) -> Vec<Vec<String>> {
        let mut graph = HashMap::new();
        let mut agents = HashSet::new();

        // Build endorsement graph
        for endorsement in endorsements {
            agents.insert(endorsement.endorser.clone());
            agents.insert(endorsement.endorsee.clone());

            graph
                .entry(endorsement.endorser.clone())
                .or_insert_with(Vec::new)
                .push(endorsement.endorsee.clone());
        }

        // Run Tarjan's algorithm to find strongly connected components
        let mut tarjan = TarjanSCC::new();
        for agent in &agents {
            if !tarjan.visited.contains(agent) {
                tarjan.dfs(agent, &graph);
            }
        }

        // Filter out trivial components (single nodes)
        tarjan
            .components
            .into_iter()
            .filter(|component| component.len() > 1)
            .collect()
    }
}

/// Tarjan's strongly connected components algorithm implementation
#[allow(dead_code)]
struct TarjanSCC {
    visited: HashSet<String>,
    stack: Vec<String>,
    on_stack: HashSet<String>,
    indices: HashMap<String, usize>,
    lowlinks: HashMap<String, usize>,
    index: usize,
    components: Vec<Vec<String>>,
}

#[allow(dead_code)]
impl TarjanSCC {
    fn new() -> Self {
        Self {
            visited: HashSet::new(),
            stack: Vec::new(),
            on_stack: HashSet::new(),
            indices: HashMap::new(),
            lowlinks: HashMap::new(),
            index: 0,
            components: Vec::new(),
        }
    }

    fn dfs(&mut self, node: &str, graph: &HashMap<String, Vec<String>>) {
        self.indices.insert(node.to_string(), self.index);
        self.lowlinks.insert(node.to_string(), self.index);
        self.index += 1;
        self.stack.push(node.to_string());
        self.on_stack.insert(node.to_string());
        self.visited.insert(node.to_string());

        if let Some(neighbors) = graph.get(node) {
            for neighbor in neighbors {
                if !self.visited.contains(neighbor) {
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

        // If node is a root node, pop the stack and create an SCC
        if self.lowlinks[node] == self.indices[node] {
            let mut component = Vec::new();
            loop {
                let w = self.stack.pop().unwrap();
                self.on_stack.remove(&w);
                component.push(w.clone());
                if w == node {
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

    #[test]
    fn test_trust_computation() {
        let config = TrustConfig::new();
        let mut engine = TrustEngine::new(config);

        let endorsements = vec![EndorsementV2 {
            endorser: "did:test:alice".to_string(),
            endorsee: "did:test:bob".to_string(),
            domain: Some("translation".to_string()),
            endorsement_type: "capability".to_string(),
            strength: 0.9,
            comment: Some("Great work".to_string()),
            timestamp: 1709740800000,
            expires: Some(1717516800000),
            version: "2.0".to_string(),
            signature: "test_sig".to_string(),
        }];

        let result = engine
            .compute_trust_score("did:test:bob", "did:test:observer", &endorsements)
            .unwrap();

        assert!(result.score >= 0.0 && result.score <= 1.0);
        assert_eq!(result.endorsement_count, 1);
    }

    #[test]
    fn test_collusion_detection() {
        let config = TrustConfig::new();
        let engine = TrustEngine::new(config);

        let endorsements = vec![
            EndorsementV2 {
                endorser: "did:test:alice".to_string(),
                endorsee: "did:test:bob".to_string(),
                domain: None,
                endorsement_type: "general".to_string(),
                strength: 0.9,
                comment: None,
                timestamp: 1709740800000,
                expires: None,
                version: "2.0".to_string(),
                signature: "test_sig1".to_string(),
            },
            EndorsementV2 {
                endorser: "did:test:bob".to_string(),
                endorsee: "did:test:alice".to_string(),
                domain: None,
                endorsement_type: "general".to_string(),
                strength: 0.9,
                comment: None,
                timestamp: 1709740800000,
                expires: None,
                version: "2.0".to_string(),
                signature: "test_sig2".to_string(),
            },
        ];

        let collusion_groups = engine.detect_collusion(&endorsements);
        assert_eq!(collusion_groups.len(), 1);
        assert_eq!(collusion_groups[0].len(), 2);
    }
}
