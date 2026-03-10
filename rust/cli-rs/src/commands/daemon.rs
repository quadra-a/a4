use anyhow::Result;
use serde_json::json;

use crate::daemon::{daemon_socket_path, DaemonClient};

pub struct DaemonStatusOptions {}
pub struct DaemonStopOptions {}

pub async fn status(_opts: DaemonStatusOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());

    if !daemon.is_running().await {
        println!("Daemon is not running");
        return Ok(());
    }

    let data = daemon.send_command("status", json!({})).await?;
    println!("Daemon is running");
    if let Some(obj) = data.as_object() {
        for (k, v) in obj {
            println!("  {}: {}", k, v);
        }
    }

    Ok(())
}

pub async fn stop(_opts: DaemonStopOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());

    if !daemon.is_running().await {
        println!("Daemon is not running");
        return Ok(());
    }

    daemon.send_command("stop", json!({})).await?;
    println!("Daemon stopped");
    Ok(())
}
