use anyhow::Result;

use crate::daemon::{daemon_socket_path, DaemonClient};

pub struct DaemonStopOptions {}

pub async fn stop(_opts: DaemonStopOptions) -> Result<()> {
    let daemon = DaemonClient::new(&daemon_socket_path());

    if !daemon.is_running().await {
        println!("Daemon is not running");
        return Ok(());
    }

    daemon.stop_listener().await?;
    println!("Daemon stopped");
    Ok(())
}
