use anyhow::Result;

#[allow(dead_code)]
pub struct AskOptions {
    pub target: Option<String>,
    pub message: Option<String>,
}

#[allow(dead_code)]
pub async fn run(_opts: AskOptions) -> Result<()> {
    eprintln!("Error: 'ask' has been removed. Use: agent tell <target> <message> --wait");
    eprintln!("Tip: inspect an agent first with: a4 trust show <target>");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  agent tell alice \"What's the weather?\" --wait");
    eprintln!("  agent tell bob \"Can you help me?\" --wait 60");
    eprintln!();
    eprintln!("The --wait flag makes 'tell' block until a reply is received.");
    eprintln!("Use 'a4 trust query <target>' to inspect endorsements before messaging.");
    std::process::exit(1);
}
