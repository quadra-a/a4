use anyhow::Result;

#[allow(dead_code)]
pub struct RouteOptions {
    pub capability: Option<String>,
    pub message: Option<String>,
}

#[allow(dead_code)]
pub async fn run(_opts: RouteOptions) -> Result<()> {
    eprintln!("Error: 'route' has been removed. Use: agent find <capability>, then agent tell <target> <message>");
    eprintln!("Tip: compare candidates with 'a4 trust show <target> --detailed'.");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  agent find translate/japanese");
    eprintln!("  agent tell alice \"Translate: Hello world\"");
    eprintln!();
    eprintln!("Or combine with --wait for blocking behavior:");
    eprintln!("  agent find translate/japanese --alias translator");
    eprintln!("  agent tell translator \"Translate: Hello world\" --wait");
    eprintln!();
    eprintln!("This two-step approach gives you more control over agent selection.");
    eprintln!("You can also inspect network endorsements with 'a4 trust query <target>'.");
    std::process::exit(1);
}
