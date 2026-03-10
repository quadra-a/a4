use anyhow::Result;

pub struct ServeOptions {
    pub port: u16,
    pub host: String,
}

pub async fn run(opts: ServeOptions) -> Result<()> {
    println!("Starting quadra-a relay server...");
    println!("Host: {}", opts.host);
    println!("Port: {}", opts.port);
    println!();

    // TODO: Implement actual relay server startup
    // For now, just show that the command was recognized
    anyhow::bail!("Relay server implementation not yet available in Rust CLI. Use the TypeScript relay server instead.");
}
