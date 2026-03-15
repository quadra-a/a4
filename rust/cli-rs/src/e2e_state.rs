use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::config::{config_dir, load_config, save_config, Config};
use quadra_a_core::e2e::ensure_local_e2e_config;

const LOCK_LEASE_MS: u64 = 30_000;
const LOCK_HEARTBEAT_MS: u64 = 3_000;
const LOCK_TIMEOUT_MS: u64 = 10_000;
const LOCK_RETRY_BASE_MS: u64 = 50;
const LOCK_RETRY_JITTER_MS: u64 = 200;

#[derive(Default)]
struct ProcessLockState {
    ref_count: usize,
    stop_heartbeat: Option<oneshot::Sender<()>>,
    heartbeat_task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockOwnerMetadata {
    #[serde(rename = "holderId")]
    holder_id: String,
    runtime: String,
    pid: u32,
    #[serde(rename = "acquiredAt")]
    acquired_at: u64,
    #[serde(rename = "leaseUntil")]
    lease_until: u64,
}

fn process_lock_state() -> &'static Mutex<ProcessLockState> {
    static LOCK_STATE: OnceLock<Mutex<ProcessLockState>> = OnceLock::new();
    LOCK_STATE.get_or_init(|| Mutex::new(ProcessLockState::default()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn lock_dir() -> PathBuf {
    config_dir().join("locks").join("e2e-state.lock")
}

fn lock_owner_path() -> PathBuf {
    lock_dir().join("owner.json")
}

fn write_lock_owner_file(holder_id: &str) -> Result<()> {
    let owner = LockOwnerMetadata {
        holder_id: holder_id.to_string(),
        runtime: "rust".to_string(),
        pid: std::process::id(),
        acquired_at: now_ms(),
        lease_until: now_ms() + LOCK_LEASE_MS,
    };
    std::fs::write(
        lock_owner_path(),
        format!("{}\n", serde_json::to_string_pretty(&owner)?),
    )
    .with_context(|| format!("Failed to write {}", lock_owner_path().display()))?;
    Ok(())
}

fn read_lock_owner_file() -> Option<LockOwnerMetadata> {
    let raw = std::fs::read_to_string(lock_owner_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn remove_lock_dir(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("Failed to remove {}", path.display())),
    }
}

async fn acquire_process_lock() -> Result<()> {
    {
        let mut state = process_lock_state().lock().await;
        if state.ref_count > 0 {
            state.ref_count += 1;
            return Ok(());
        }
    }

    let path = lock_dir();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create lock dir parent {}", parent.display()))?;
    }

    let holder_id = Uuid::new_v4().to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(LOCK_TIMEOUT_MS);

    loop {
        match std::fs::create_dir(&path) {
            Ok(()) => {
                write_lock_owner_file(&holder_id)?;
                let (stop_tx, mut stop_rx) = oneshot::channel();
                let heartbeat_holder_id = holder_id.clone();
                let heartbeat_task = tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            _ = &mut stop_rx => break,
                            _ = tokio::time::sleep(Duration::from_millis(LOCK_HEARTBEAT_MS)) => {
                                let _ = write_lock_owner_file(&heartbeat_holder_id);
                            }
                        }
                    }
                });

                let mut state = process_lock_state().lock().await;
                state.ref_count = 1;
                state.stop_heartbeat = Some(stop_tx);
                state.heartbeat_task = Some(heartbeat_task);
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let owner = read_lock_owner_file();
                if owner
                    .as_ref()
                    .map(|owner| owner.lease_until < now_ms())
                    .unwrap_or(true)
                {
                    remove_lock_dir(&path)?;
                    continue;
                }

                if tokio::time::Instant::now() >= deadline {
                    anyhow::bail!(
                        "Timed out acquiring local E2E state lock at {}",
                        path.display()
                    );
                }

                let jitter = now_ms() % LOCK_RETRY_JITTER_MS.max(1);
                tokio::time::sleep(Duration::from_millis(LOCK_RETRY_BASE_MS + jitter)).await;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Failed to create lock dir {}", path.display()));
            }
        }
    }
}

async fn release_process_lock() -> Result<()> {
    let (stop_heartbeat, heartbeat_task, should_remove) = {
        let mut state = process_lock_state().lock().await;
        if state.ref_count == 0 {
            return Ok(());
        }

        state.ref_count -= 1;
        if state.ref_count > 0 {
            return Ok(());
        }

        (
            state.stop_heartbeat.take(),
            state.heartbeat_task.take(),
            true,
        )
    };

    if let Some(stop) = stop_heartbeat {
        let _ = stop.send(());
    }
    if let Some(task) = heartbeat_task {
        let _ = task.await;
    }
    if should_remove {
        remove_lock_dir(&lock_dir())?;
    }

    Ok(())
}

pub async fn with_locked_config_transaction<T, F, Fut>(callback: F) -> Result<(T, Config)>
where
    F: FnOnce(Config) -> Fut,
    Fut: Future<Output = Result<(T, Config)>>,
{
    acquire_process_lock().await?;

    let config = load_config()?;
    let before = serde_json::to_vec(&config)?;
    let result = callback(config).await;

    let save_result = if let Ok((_, final_config)) = &result {
        if serde_json::to_vec(final_config)? != before {
            save_config(final_config)
        } else {
            Ok(())
        }
    } else {
        Ok(())
    };

    let release_result = release_process_lock().await;
    save_result?;
    release_result?;

    result
}

pub async fn with_local_e2e_state_transaction<T, F, Fut>(callback: F) -> Result<(T, Config)>
where
    F: FnOnce(Config) -> Fut,
    Fut: Future<Output = Result<(T, Config)>>,
{
    with_locked_config_transaction(|mut config| async move {
        ensure_local_e2e_config(&mut config)?;
        callback(config).await
    })
    .await
}
