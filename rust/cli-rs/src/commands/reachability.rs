use anyhow::{bail, Result};
use serde_json::json;

use crate::config::{
    load_config, resolve_reachability_policy, save_config, Config, ReachabilityMode,
};
use crate::daemon::{daemon_socket_path, DaemonClient};

pub enum ReachabilityAction {
    Show { json: bool },
    Mode { mode: String },
    SetBootstrap { providers: String },
    SetTarget { count: u32 },
    ResetDefault,
    OperatorLock { state: String },
}

fn notify_daemon_restart() {
    println!("Saved reachability policy. Restart the listener/daemon to apply it.");
}

fn bootstrap_from_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn ensure_policy(config: &mut Config) -> &mut crate::config::ReachabilityPolicy {
    if config.reachability_policy.is_none() {
        config.reachability_policy = Some(resolve_reachability_policy(None, None));
    }

    config
        .reachability_policy
        .as_mut()
        .expect("policy initialized")
}

pub async fn run(action: ReachabilityAction) -> Result<()> {
    let mut config = load_config()?;

    match action {
        ReachabilityAction::Show { json } => {
            let policy = resolve_reachability_policy(None, Some(&config));
            let daemon = DaemonClient::new(&daemon_socket_path());
            let daemon_status = daemon.send_command("status", json!({})).await.ok();

            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "policy": policy,
                        "daemon": daemon_status,
                    }))?
                );
            } else {
                println!("Reachability Policy");
                println!("  mode: {:?}", policy.mode);
                println!(
                    "  bootstrapProviders: {}",
                    policy.bootstrap_providers.join(", ")
                );
                println!("  targetProviderCount: {}", policy.target_provider_count);
                println!(
                    "  autoDiscoverProviders: {}",
                    policy.auto_discover_providers
                );
                println!("  operatorLock: {}", policy.operator_lock);
                if let Some(status) = daemon_status {
                    println!("  daemon: {}", status);
                }
            }
        }
        ReachabilityAction::Mode { mode } => {
            let policy = ensure_policy(&mut config);
            policy.mode = match mode.as_str() {
                "adaptive" => ReachabilityMode::Adaptive,
                "fixed" => ReachabilityMode::Fixed,
                _ => bail!("Mode must be adaptive or fixed"),
            };
            policy.auto_discover_providers = matches!(policy.mode, ReachabilityMode::Adaptive);
            save_config(&config)?;
            notify_daemon_restart();
        }
        ReachabilityAction::SetBootstrap { providers } => {
            let bootstrap_providers = bootstrap_from_csv(&providers);
            if bootstrap_providers.is_empty() {
                bail!("At least one bootstrap provider is required");
            }
            let policy = ensure_policy(&mut config);
            policy.bootstrap_providers = bootstrap_providers;
            save_config(&config)?;
            notify_daemon_restart();
        }
        ReachabilityAction::SetTarget { count } => {
            if count == 0 {
                bail!("Target provider count must be positive");
            }
            let policy = ensure_policy(&mut config);
            policy.target_provider_count = count;
            save_config(&config)?;
            notify_daemon_restart();
        }
        ReachabilityAction::ResetDefault => {
            config.reachability_policy = None;
            save_config(&config)?;
            notify_daemon_restart();
        }
        ReachabilityAction::OperatorLock { state } => {
            let enabled = match state.as_str() {
                "on" => true,
                "off" => false,
                _ => bail!("State must be on or off"),
            };
            let policy = ensure_policy(&mut config);
            policy.operator_lock = enabled;
            save_config(&config)?;
            notify_daemon_restart();
        }
    }

    Ok(())
}
