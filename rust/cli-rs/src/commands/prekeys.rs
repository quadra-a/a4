use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use quadra_a_core::e2e::{build_published_device_directory, LocalDeviceState, LocalE2EConfig};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::load_config;

const LOW_ONE_TIME_PREKEY_THRESHOLD: usize = 4;
const STALE_SIGNED_PREKEY_AGE_MS: u64 = 14 * 24 * 60 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrekeyWarning {
    pub code: String,
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "deviceId")]
    pub device_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LocalDevicePrekeySummary {
    pub current: bool,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "signedPreKeyCreatedAt")]
    pub signed_pre_key_created_at: u64,
    #[serde(rename = "signedPreKeyAgeMs")]
    pub signed_pre_key_age_ms: u64,
    #[serde(rename = "oneTimePreKeysTotal")]
    pub one_time_pre_keys_total: usize,
    #[serde(rename = "oneTimePreKeysRemaining")]
    pub one_time_pre_keys_remaining: usize,
    #[serde(rename = "oneTimePreKeysClaimed")]
    pub one_time_pre_keys_claimed: usize,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
    #[serde(rename = "sessionCount")]
    pub session_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PublishedDevicePrekeySummary {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "signedPreKeyId")]
    pub signed_pre_key_id: u32,
    #[serde(rename = "oneTimePreKeyCount")]
    pub one_time_pre_key_count: u32,
    #[serde(rename = "lastResupplyAt")]
    pub last_resupply_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PrekeysReport {
    pub available: bool,
    #[serde(rename = "currentDeviceId")]
    pub current_device_id: Option<String>,
    #[serde(rename = "localDeviceCount")]
    pub local_device_count: usize,
    #[serde(rename = "publishedDeviceCount")]
    pub published_device_count: usize,
    pub warnings: Vec<PrekeyWarning>,
    #[serde(rename = "localDevices")]
    pub local_devices: Vec<LocalDevicePrekeySummary>,
    #[serde(rename = "publishedDevices")]
    pub published_devices: Vec<PublishedDevicePrekeySummary>,
}

pub struct PrekeysOptions {
    pub json: bool,
    pub format: String,
}

fn summarize_local_device(
    device: &LocalDeviceState,
    current_device_id: Option<&str>,
    now_ms: u64,
) -> LocalDevicePrekeySummary {
    let one_time_pre_keys_total = device.one_time_pre_keys.len();
    let one_time_pre_keys_remaining = device
        .one_time_pre_keys
        .iter()
        .filter(|key| key.claimed_at.is_none())
        .count();

    LocalDevicePrekeySummary {
        current: current_device_id.is_some_and(|current| current == device.device_id.as_str()),
        device_id: device.device_id.clone(),
        created_at: device.created_at,
        signed_pre_key_id: device.signed_pre_key.signed_pre_key_id,
        signed_pre_key_created_at: device.signed_pre_key.created_at,
        signed_pre_key_age_ms: now_ms.saturating_sub(device.signed_pre_key.created_at),
        one_time_pre_keys_total,
        one_time_pre_keys_remaining,
        one_time_pre_keys_claimed: one_time_pre_keys_total - one_time_pre_keys_remaining,
        last_resupply_at: device.last_resupply_at,
        session_count: device.sessions.len(),
    }
}

fn format_age(age_ms: u64) -> String {
    let total_seconds = age_ms / 1000;
    if total_seconds < 60 {
        format!("{}s", total_seconds)
    } else if total_seconds < 3600 {
        format!("{}m", total_seconds / 60)
    } else if total_seconds < 86400 {
        format!("{}h", total_seconds / 3600)
    } else {
        format!("{}d", total_seconds / 86400)
    }
}

fn format_timestamp(timestamp_ms: u64) -> String {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms as i64)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn build_prekeys_report(e2e: Option<&LocalE2EConfig>, now_ms: u64) -> PrekeysReport {
    let current_device_id = e2e
        .map(|config| config.current_device_id.trim())
        .filter(|device_id| !device_id.is_empty())
        .map(ToOwned::to_owned);

    let mut local_devices = e2e
        .map(|config| {
            config
                .devices
                .values()
                .map(|device| summarize_local_device(device, current_device_id.as_deref(), now_ms))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    local_devices.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then_with(|| left.device_id.cmp(&right.device_id))
    });

    let published_devices = e2e
        .map(build_published_device_directory)
        .unwrap_or_default()
        .into_iter()
        .map(|device| PublishedDevicePrekeySummary {
            device_id: device.device_id,
            signed_pre_key_id: device.signed_pre_key_id,
            one_time_pre_key_count: device.one_time_pre_key_count,
            last_resupply_at: device.last_resupply_at,
        })
        .collect::<Vec<_>>();

    let mut warnings = Vec::new();
    if let Some(current_device_id) = current_device_id.as_ref() {
        if !local_devices
            .iter()
            .any(|device| device.device_id == *current_device_id)
        {
            warnings.push(PrekeyWarning {
                code: "current-device-missing".to_string(),
                severity: "warning".to_string(),
                device_id: Some(current_device_id.clone()),
                message: format!(
                    "Current device {} is missing from local E2E state.",
                    current_device_id
                ),
            });
        }
    }

    for device in &local_devices {
        if device.one_time_pre_keys_remaining <= LOW_ONE_TIME_PREKEY_THRESHOLD {
            warnings.push(PrekeyWarning {
                code: "low-one-time-prekeys".to_string(),
                severity: "warning".to_string(),
                device_id: Some(device.device_id.clone()),
                message: format!(
                    "{} has {} one-time pre-keys remaining.",
                    device.device_id, device.one_time_pre_keys_remaining
                ),
            });
        }

        if device.signed_pre_key_age_ms >= STALE_SIGNED_PREKEY_AGE_MS {
            warnings.push(PrekeyWarning {
                code: "stale-signed-prekey".to_string(),
                severity: "warning".to_string(),
                device_id: Some(device.device_id.clone()),
                message: format!(
                    "{} signed pre-key is {} old.",
                    device.device_id,
                    format_age(device.signed_pre_key_age_ms)
                ),
            });
        }
    }

    PrekeysReport {
        available: current_device_id.is_some() && !local_devices.is_empty(),
        current_device_id,
        local_device_count: local_devices.len(),
        published_device_count: published_devices.len(),
        warnings,
        local_devices,
        published_devices,
    }
}

fn print_text_report(report: &PrekeysReport) {
    println!("\nPre-Key Health\n");
    println!(
        "  Current Device: {}",
        report.current_device_id.as_deref().unwrap_or("None")
    );
    println!("  Local Devices: {}", report.local_device_count);
    println!("  Published Devices: {}", report.published_device_count);
    println!("  Warnings: {}", report.warnings.len());

    if !report.warnings.is_empty() {
        println!("\nWarnings:");
        for warning in &report.warnings {
            println!(
                "  - {}: [{}] {}",
                warning
                    .device_id
                    .as_deref()
                    .unwrap_or(warning.code.as_str()),
                warning.severity,
                warning.message
            );
        }
    }

    println!("\nLocal Devices:");
    if report.local_devices.is_empty() {
        println!("  No local E2E devices.");
    } else {
        for device in &report.local_devices {
            println!(
                "\n  {}{}",
                device.device_id,
                if device.current { " (current)" } else { "" }
            );
            println!(
                "    Signed Pre-Key: #{} created {} ({} old)",
                device.signed_pre_key_id,
                format_timestamp(device.signed_pre_key_created_at),
                format_age(device.signed_pre_key_age_ms)
            );
            println!(
                "    One-Time Pre-Keys: {}/{} remaining ({} claimed)",
                device.one_time_pre_keys_remaining,
                device.one_time_pre_keys_total,
                device.one_time_pre_keys_claimed
            );
            println!("    Sessions: {}", device.session_count);
            println!(
                "    Device Created: {}",
                format_timestamp(device.created_at)
            );
            println!(
                "    Last Resupply: {}",
                format_timestamp(device.last_resupply_at)
            );
        }
    }

    println!("\nPublished Device Directory:");
    if report.published_devices.is_empty() {
        println!("  No published device directory entries.");
    } else {
        for device in &report.published_devices {
            println!("\n  {}", device.device_id);
            println!("    Signed Pre-Key: #{}", device.signed_pre_key_id);
            println!("    One-Time Pre-Keys: {}", device.one_time_pre_key_count);
            println!(
                "    Last Resupply: {}",
                format_timestamp(device.last_resupply_at)
            );
        }
    }
    println!();
}

pub async fn run(opts: PrekeysOptions) -> Result<()> {
    let config = load_config()?;
    if config.identity.is_none() {
        bail!("No identity found. Run `a4 listen` to initialize.");
    }

    let report = build_prekeys_report(config.e2e.as_ref(), now_ms());
    let format = if opts.json {
        "json".to_string()
    } else {
        opts.format.to_lowercase()
    };

    match format.as_str() {
        "json" => println!("{}", serde_json::to_string_pretty(&report)?),
        "text" => print_text_report(&report),
        other => bail!("Unsupported format '{}'. Use text or json.", other),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::build_prekeys_report;
    use quadra_a_core::e2e::{
        LocalDeviceKeyPair, LocalE2EConfig, LocalOneTimePreKeyState, LocalSignedPreKeyState,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    fn device(
        device_id: &str,
        signed_pre_key_created_at: u64,
        one_time_pre_keys: Vec<LocalOneTimePreKeyState>,
    ) -> quadra_a_core::e2e::LocalDeviceState {
        let mut sessions = BTreeMap::new();
        sessions.insert(
            "did:agent:zpeer:device-1".to_string(),
            json!({"sessionId": "s1"}),
        );
        quadra_a_core::e2e::LocalDeviceState {
            device_id: device_id.to_string(),
            created_at: signed_pre_key_created_at.saturating_sub(DAY_MS),
            identity_key: LocalDeviceKeyPair {
                public_key: "aa".to_string(),
                private_key: "bb".to_string(),
            },
            signed_pre_key: LocalSignedPreKeyState {
                signed_pre_key_id: 9,
                public_key: "cc".to_string(),
                private_key: "dd".to_string(),
                signature: "ee".to_string(),
                created_at: signed_pre_key_created_at,
            },
            one_time_pre_keys,
            last_resupply_at: signed_pre_key_created_at.saturating_sub(DAY_MS),
            sessions,
        }
    }

    #[test]
    fn build_prekeys_report_flags_low_inventory_and_stale_signed_prekeys() {
        let now = 2_000_000_000_000;
        let stale_device = device(
            "device-a",
            now - (20 * DAY_MS),
            vec![
                LocalOneTimePreKeyState {
                    key_id: 1,
                    public_key: "01".to_string(),
                    private_key: "11".to_string(),
                    created_at: now - (20 * DAY_MS),
                    claimed_at: Some(now - DAY_MS),
                },
                LocalOneTimePreKeyState {
                    key_id: 2,
                    public_key: "02".to_string(),
                    private_key: "12".to_string(),
                    created_at: now - (20 * DAY_MS),
                    claimed_at: None,
                },
            ],
        );
        let mut devices = BTreeMap::new();
        devices.insert(stale_device.device_id.clone(), stale_device);
        let report = build_prekeys_report(
            Some(&LocalE2EConfig {
                current_device_id: "device-a".to_string(),
                devices,
            }),
            now,
        );

        let warning_codes = report
            .warnings
            .iter()
            .map(|warning| warning.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            warning_codes,
            vec!["low-one-time-prekeys", "stale-signed-prekey"]
        );
        assert_eq!(report.local_devices[0].one_time_pre_keys_claimed, 1);
        assert_eq!(report.published_devices[0].one_time_pre_key_count, 1);
    }

    #[test]
    fn build_prekeys_report_warns_when_current_device_is_missing() {
        let report = build_prekeys_report(
            Some(&LocalE2EConfig {
                current_device_id: "device-missing".to_string(),
                devices: BTreeMap::new(),
            }),
            2_000_000_000_000,
        );

        assert!(!report.available);
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(report.warnings[0].code, "current-device-missing");
    }
}
