use anyhow::Result;

pub struct LeaveOptions {}

pub async fn run(_opts: LeaveOptions) -> Result<()> {
    // Delegate to the existing daemon stop command implementation
    crate::commands::daemon::stop(crate::commands::daemon::DaemonStopOptions {}).await
}
