use serde::Serialize;
use std::collections::{HashMap, HashSet};

use quadra_a_core::config::ReachabilityPolicy;

use crate::relay::DEFAULT_RELAY;
use crate::relay_worker::RelayWorkerEvent;

#[derive(Clone, Serialize)]
pub struct RelayFailureState {
    pub provider: String,
    pub attempts: u32,
    #[serde(rename = "lastFailureAt")]
    pub last_failure_at: u64,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct ManagedRelayState {
    pub relay_url: String,
    pub connected: bool,
    pub connected_at: u64,
    pub reachability_policy: ReachabilityPolicy,
    pub known_relays: Vec<String>,
    pub last_discovery_at: Option<u64>,
    pub relay_failures: HashMap<String, RelayFailureState>,
}

impl ManagedRelayState {
    pub fn new(reachability_policy: ReachabilityPolicy) -> Self {
        let relay_url = reachability_policy
            .bootstrap_providers
            .first()
            .cloned()
            .unwrap_or_else(|| DEFAULT_RELAY.to_string());
        let known_relays = if reachability_policy.bootstrap_providers.is_empty() {
            vec![DEFAULT_RELAY.to_string()]
        } else {
            reachability_policy.bootstrap_providers.clone()
        };

        Self {
            relay_url,
            connected: false,
            connected_at: 0,
            reachability_policy,
            known_relays,
            last_discovery_at: None,
            relay_failures: HashMap::new(),
        }
    }

    pub fn reset(&mut self, reachability_policy: ReachabilityPolicy) {
        self.reachability_policy = reachability_policy.clone();
        self.known_relays = if reachability_policy.bootstrap_providers.is_empty() {
            vec![DEFAULT_RELAY.to_string()]
        } else {
            reachability_policy.bootstrap_providers.clone()
        };
        self.relay_url = self
            .known_relays
            .first()
            .cloned()
            .unwrap_or_else(|| DEFAULT_RELAY.to_string());
        self.connected = false;
        self.connected_at = 0;
        self.last_discovery_at = None;
        self.relay_failures.clear();
    }

    pub fn candidates(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut relays = Vec::new();

        for relay_url in std::iter::once(self.relay_url.as_str())
            .chain(self.known_relays.iter().map(String::as_str))
            .chain(
                self.reachability_policy
                    .bootstrap_providers
                    .iter()
                    .map(String::as_str),
            )
        {
            let normalized = relay_url.trim();
            if normalized.is_empty() {
                continue;
            }
            if seen.insert(normalized.to_string()) {
                relays.push(normalized.to_string());
            }
        }

        if relays.is_empty() {
            relays.push(DEFAULT_RELAY.to_string());
        }

        relays
    }

    pub fn insert_known_relays<I>(&mut self, relays: I) -> bool
    where
        I: IntoIterator<Item = String>,
    {
        let mut changed = false;
        for relay_url in relays {
            let normalized = relay_url.trim();
            if normalized.is_empty() {
                continue;
            }
            if self.known_relays.iter().any(|known| known == normalized) {
                continue;
            }
            self.known_relays.push(normalized.to_string());
            changed = true;
        }
        changed
    }

    pub fn failure_snapshot(&self) -> Vec<RelayFailureState> {
        let mut failures = self.relay_failures.values().cloned().collect::<Vec<_>>();
        failures.sort_by(|left, right| left.provider.cmp(&right.provider));
        failures
    }

    pub fn record_failure(&mut self, relay_url: &str, error: String, now_ms: u64) {
        let entry = self
            .relay_failures
            .entry(relay_url.to_string())
            .or_insert(RelayFailureState {
                provider: relay_url.to_string(),
                attempts: 0,
                last_failure_at: 0,
                last_error: None,
            });
        entry.attempts = entry.attempts.saturating_add(1);
        entry.last_failure_at = now_ms;
        entry.last_error = Some(error);
    }

    pub fn clear_failure(&mut self, relay_url: &str) {
        self.relay_failures.remove(relay_url);
    }

    pub fn mark_connected(&mut self, relay_url: &str, now_ms: u64) {
        self.relay_url = relay_url.to_string();
        self.connected = true;
        self.connected_at = now_ms;
        self.insert_known_relays(std::iter::once(relay_url.to_string()));
        self.clear_failure(relay_url);
    }

    pub fn mark_disconnected(&mut self) {
        self.connected = false;
    }

    pub fn note_discovery<I>(&mut self, relays: I, now_ms: u64) -> bool
    where
        I: IntoIterator<Item = String>,
    {
        self.last_discovery_at = Some(now_ms);
        self.insert_known_relays(relays)
    }

    pub fn apply_worker_event(&mut self, event: &RelayWorkerEvent) {
        match event {
            RelayWorkerEvent::Connected {
                relay_url,
                connected_at,
            } => self.mark_connected(relay_url, *connected_at),
            RelayWorkerEvent::Disconnected { .. } => self.mark_disconnected(),
            RelayWorkerEvent::FailureRecorded {
                relay_url,
                error,
                failed_at,
            } => self.record_failure(relay_url, error.clone(), *failed_at),
            RelayWorkerEvent::FailureCleared { relay_url } => self.clear_failure(relay_url),
            RelayWorkerEvent::RelayPoolUpdated {
                discovered_relays,
                discovered_at,
                ..
            } => {
                self.note_discovery(discovered_relays.clone(), *discovered_at);
            }
            RelayWorkerEvent::EnvelopeReceived { .. }
            | RelayWorkerEvent::DeliveryReported { .. } => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ManagedRelayState;
    use crate::relay_worker::RelayWorkerEvent;
    use quadra_a_core::config::ReachabilityPolicy;

    #[test]
    fn applies_connected_event_to_runtime_state() {
        let mut state = ManagedRelayState::new(ReachabilityPolicy::default());

        state.apply_worker_event(&RelayWorkerEvent::Connected {
            relay_url: "wss://relay.example".to_string(),
            connected_at: 42,
        });

        assert!(state.connected);
        assert_eq!(state.relay_url, "wss://relay.example");
        assert_eq!(state.connected_at, 42);
        assert!(state
            .known_relays
            .contains(&"wss://relay.example".to_string()));
    }

    #[test]
    fn applies_discovery_event_even_without_new_relays() {
        let mut state = ManagedRelayState::new(ReachabilityPolicy::default());
        let existing = state.known_relays.clone();

        state.apply_worker_event(&RelayWorkerEvent::RelayPoolUpdated {
            relay_url: state.relay_url.clone(),
            discovered_relays: existing,
            discovered_at: 99,
        });

        assert_eq!(state.last_discovery_at, Some(99));
    }
}
