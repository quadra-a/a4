mod commands;
mod config;
mod daemon;
mod identity;
mod protocol;
mod relay;
mod trust;
mod ui;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::env;

#[derive(Parser)]
#[command(
    name = "a4",
    about = "quadra-a — agent identity, discovery, and messaging",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

fn show_deprecation_warning() {
    let binary_name = env::args()
        .next()
        .and_then(|path| {
            let path_obj = std::path::Path::new(&path);
            path_obj
                .file_name()
                .and_then(|name| name.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());

    match binary_name.as_str() {
        "hw1" | "agent" | "agt" => {
            eprintln!(
                "Warning: '{}' is deprecated. Use 'a4' instead.",
                binary_name
            );
            eprintln!("Example: a4 find translate/japanese");
        }
        _ => {}
    }
}

#[derive(Subcommand)]
enum Commands {
    // ── Primary Semantic Verbs (CVP-0019) ────────────────────────────────────────
    /// Find published agents by capability or query
    Find {
        /// Capability prefix to search for
        #[arg(value_name = "CAPABILITY")]
        capability: Option<String>,
        /// Natural language query
        #[arg(long)]
        query: Option<String>,
        /// Query a specific DID
        #[arg(long)]
        did: Option<String>,
        /// Maximum number of results
        #[arg(long, default_value = "10")]
        limit: u32,
        /// Minimum trust score (0-1)
        #[arg(long)]
        min_trust: Option<f64>,
        /// Auto-alias the top result with this name
        #[arg(long)]
        alias: Option<String>,
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Send a message to a specific agent
    Tell {
        /// Recipient DID, alias, or search text
        target: String,
        /// Message text
        message: Option<String>,
        /// Raw JSON payload
        #[arg(long)]
        payload: Option<String>,
        /// Protocol identifier
        #[arg(long, default_value = "highway1/chat/1.0")]
        protocol: String,
        /// Reply to an earlier message ID
        #[arg(long)]
        reply_to: Option<String>,
        /// Continue conversation in existing thread
        #[arg(long)]
        thread: Option<String>,
        /// Start a new conversation thread
        #[arg(long)]
        new_thread: bool,
        /// Wait for a result (optional timeout in seconds)
        #[arg(long)]
        wait: Option<Option<u64>>,
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Inspect trust score for an agent
    Score {
        /// Agent DID or alias to inspect
        target: String,
        /// Show detailed trust breakdown
        #[arg(long)]
        detailed: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Trace one message through local daemon result lifecycle
    Trace {
        /// Full message ID or local suffix
        message_id: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Create an endorsement for an agent
    Vouch {
        /// Agent DID or alias to endorse
        target: String,
        /// Endorsement type (e.g., "capability", "reliability")
        #[arg(long, default_value = "general")]
        r#type: String,
        /// Endorsement strength (0.0-1.0)
        #[arg(long, default_value = "0.8")]
        strength: f64,
        /// Optional comment
        #[arg(long)]
        comment: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Query endorsements from the network
    Endorsements {
        /// Agent DID or alias to query endorsements for
        target: Option<String>,
        /// Show endorsements created by this agent
        #[arg(long)]
        created_by: Option<String>,
        /// Filter endorsements by capability domain
        #[arg(long)]
        domain: Option<String>,
        /// Maximum endorsements to show
        #[arg(long, default_value = "20")]
        limit: u32,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Legacy-style trust command group
    Trust {
        #[command(subcommand)]
        action: TrustAction,
    },

    /// Block an agent
    Block {
        /// Agent DID or alias to block
        target: String,
        /// Reason for blocking
        #[arg(long)]
        reason: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Unblock an agent
    Unblock {
        /// Agent DID or alias to unblock
        target: String,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Start daemon and stay online
    Listen {
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Invite token for private relays
        #[arg(long, env = "QUADRA_A_INVITE_TOKEN")]
        token: Option<String>,
        /// Run the listener in the background
        #[arg(long)]
        background: bool,
        /// Output messages as JSON lines (NDJSON)
        #[arg(long)]
        json: bool,
        /// Make agent discoverable with custom details
        #[arg(long)]
        discoverable: bool,
        /// Agent name (required with --discoverable)
        #[arg(long)]
        name: Option<String>,
        /// Agent description (required with --discoverable)
        #[arg(long)]
        description: Option<String>,
        /// Comma-separated capability IDs (optional with --discoverable)
        #[arg(long)]
        capabilities: Option<String>,
    },

    /// Stop daemon and leave the network
    Leave,

    /// Publish agent card to relay index
    Publish {
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Remove agent card from relay index
    Unpublish {
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    // ── Admin Commands ────────────────────────────────────────────────────────────
    /// Show inbox messages
    Inbox {
        /// Maximum messages to show
        #[arg(long, default_value = "20")]
        limit: u32,
        /// Show only unread messages
        #[arg(long)]
        unread: bool,
        /// Filter by thread ID
        #[arg(long)]
        thread: Option<String>,
        /// Wait for new messages (timeout in seconds)
        #[arg(long)]
        wait: Option<Option<u64>>,
        /// Output messages as JSON lines
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Manage agent aliases
    Alias {
        #[command(subcommand)]
        action: AliasAction,
    },

    /// Show agent card and identity
    Card {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Manage conversation threads
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },

    /// Show identity information
    Identity {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Show connected peers
    Peers {
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Start relay server
    Serve {
        /// Port to listen on
        #[arg(long, default_value = "8080")]
        port: u16,
        /// Host to bind to
        #[arg(long, default_value = "0.0.0.0")]
        host: String,
    },

    /// Stop daemon
    Stop,

    /// Manage network reachability policy
    Reachability {
        #[command(subcommand)]
        action: ReachabilityAction,
    },

    /// Show daemon and connection status
    Status {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    // ── Legacy Commands (Hidden) ──────────────────────────────────────────────────
    /// Initialize a new agent identity
    #[command(hide = true)]
    Init {
        /// Agent name
        #[arg(long, default_value = "My Agent")]
        name: String,
        /// Agent description
        #[arg(long, default_value = "")]
        description: String,
        /// Overwrite existing identity
        #[arg(long)]
        force: bool,
    },

    /// Discover agents on the relay (legacy)
    #[command(hide = true)]
    Discover {
        /// Search query (capability name, keyword, or empty for all)
        #[arg(long, default_value = "")]
        query: String,
        /// Maximum number of results
        #[arg(long)]
        limit: Option<u32>,
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Send a message to an agent (legacy)
    #[command(hide = true)]
    Send {
        /// Recipient DID, alias, or search text
        #[arg(long)]
        to: String,
        /// Message text (shorthand for --payload '{"text":"..."}')
        #[arg(long)]
        message: Option<String>,
        /// Raw JSON payload
        #[arg(long)]
        payload: Option<String>,
        /// Message type: notification, request, response
        #[arg(long, default_value = "notification")]
        r#type: String,
        /// Protocol identifier
        #[arg(long, default_value = "highway1/chat/1.0")]
        protocol: String,
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
        /// Continue conversation in existing thread (CVP-0014)
        #[arg(long)]
        thread: Option<String>,
        /// Start a new conversation thread (CVP-0014)
        #[arg(long)]
        new_thread: bool,
    },
    /// Daemon management (legacy)
    #[command(hide = true)]
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },

    // ── Removal Stubs ─────────────────────────────────────────────────────────────
    /// Removed command - use 'tell --wait' instead
    #[command(hide = true)]
    Ask {
        target: Option<String>,
        message: Option<String>,
    },

    /// Removed command - use 'find' then 'tell' instead
    #[command(hide = true)]
    Route {
        capability: Option<String>,
        message: Option<String>,
    },
}

#[derive(Subcommand)]
enum DaemonAction {
    /// Show daemon status
    Status,
    /// Stop the daemon
    Stop,
}

#[derive(Subcommand)]
enum ReachabilityAction {
    /// Show current reachability policy
    Show {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Set reachability mode
    Mode {
        /// adaptive or fixed
        mode: String,
    },
    /// Set comma-separated bootstrap providers
    SetBootstrap { providers: String },
    /// Set target provider count
    SetTarget { count: u32 },
    /// Reset reachability policy to defaults
    ResetDefault,
    /// Enable or disable operator lock
    OperatorLock {
        /// on or off
        state: String,
    },
}

#[derive(Subcommand)]
enum AliasAction {
    /// Set an alias for a DID
    Set {
        /// Alias name (lowercase alphanumeric + hyphens, max 32 chars)
        name: String,
        /// DID to alias
        did: String,
    },
    /// List all aliases
    List {
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },
    /// Get DID for an alias
    Get {
        /// Alias name
        name: String,
    },
    /// Remove an alias
    Remove {
        /// Alias name
        name: String,
    },
}

#[derive(Subcommand)]
enum SessionsAction {
    /// List all conversation threads
    List {
        /// Filter by peer DID or alias
        #[arg(long)]
        with: Option<String>,
        /// Maximum sessions to show
        #[arg(long, default_value = "50")]
        limit: u32,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },
    /// Show messages in a conversation thread
    Show {
        /// Thread ID
        thread_id: String,
        /// Maximum messages to show
        #[arg(long, default_value = "50")]
        limit: u32,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },
}

#[derive(Subcommand)]
enum TrustAction {
    /// Show trust score for an agent
    Show {
        target: String,
        #[arg(long)]
        detailed: bool,
        #[arg(long)]
        human: bool,
    },
    /// Create a general endorsement for an agent
    Endorse {
        target: String,
        #[arg(long, default_value = "0.8")]
        score: f64,
        #[arg(long, default_value = "Good collaboration")]
        reason: String,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long)]
        human: bool,
    },
    /// Show endorsement history for an agent
    History {
        target: String,
        #[arg(long, default_value = "10")]
        limit: u32,
        #[arg(long)]
        human: bool,
    },
    /// Show local trust statistics
    Stats {
        #[arg(long)]
        human: bool,
    },
    /// Query endorsements for an agent
    Query {
        target: String,
        #[arg(long)]
        domain: Option<String>,
        #[arg(long, default_value = "20")]
        limit: u32,
        #[arg(long)]
        human: bool,
    },
    /// Block an agent
    Block {
        target: String,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long)]
        human: bool,
    },
    /// Unblock an agent
    Unblock {
        target: String,
        #[arg(long)]
        human: bool,
    },
    /// List blocked agents
    ListBlocked {
        #[arg(long)]
        human: bool,
    },
    /// Add an agent to the local allowlist
    Allow {
        target: String,
        #[arg(long)]
        note: Option<String>,
        #[arg(long)]
        human: bool,
    },
    /// List allowlisted agents
    ListAllowed {
        #[arg(long)]
        human: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    show_deprecation_warning();
    let cli = Cli::parse();

    match cli.command {
        // ── Primary Semantic Verbs ────────────────────────────────────────────────
        Commands::Find {
            capability,
            query,
            did,
            limit,
            min_trust,
            alias,
            relay,
            human,
        } => {
            commands::find::run(commands::find::FindOptions {
                capability,
                query,
                did,
                limit,
                min_trust,
                alias,
                relay,
                human,
            })
            .await?;
        }

        Commands::Tell {
            target,
            message,
            payload,
            protocol,
            reply_to,
            thread,
            new_thread,
            wait,
            relay,
            human,
        } => {
            commands::tell::run(commands::tell::TellOptions {
                target,
                message,
                payload,
                protocol,
                reply_to,
                thread,
                new_thread,
                wait,
                relay,
                human,
            })
            .await?;
        }

        Commands::Score {
            target,
            detailed,
            human,
        } => {
            commands::score::run(commands::score::ScoreOptions {
                target,
                detailed,
                human,
            })
            .await?;
        }

        Commands::Trace {
            message_id,
            json,
            human,
        } => {
            commands::trace::run(commands::trace::TraceOptions {
                message_id,
                json,
                human,
            })
            .await?;
        }

        Commands::Vouch {
            target,
            r#type,
            strength,
            comment,
            human,
        } => {
            commands::vouch::run(commands::vouch::VouchOptions {
                target,
                endorsement_type: r#type,
                strength,
                comment,
                domain: None, // TODO: Add domain support to CLI args
                human,
            })
            .await?;
        }

        Commands::Endorsements {
            target,
            created_by,
            domain,
            limit,
            human,
        } => {
            commands::endorsements::run(commands::endorsements::EndorsementsOptions {
                target,
                created_by,
                domain,
                limit,
                human,
            })
            .await?;
        }

        Commands::Trust { action } => match action {
            TrustAction::Show {
                target,
                detailed,
                human,
            } => {
                commands::trust_cli::show(commands::trust_cli::TrustShowOptions {
                    target,
                    detailed,
                    human,
                })
                .await?;
            }
            TrustAction::Endorse {
                target,
                score,
                reason,
                domain,
                human,
            } => {
                commands::trust_cli::endorse(commands::trust_cli::TrustEndorseOptions {
                    target,
                    score,
                    reason,
                    domain,
                    human,
                })
                .await?;
            }
            TrustAction::History {
                target,
                limit,
                human,
            } => {
                commands::trust_cli::history(commands::trust_cli::TrustHistoryOptions {
                    target,
                    limit,
                    human,
                })
                .await?;
            }
            TrustAction::Stats { human } => {
                commands::trust_cli::stats(commands::trust_cli::TrustStatsOptions { human })
                    .await?;
            }
            TrustAction::Query {
                target,
                domain,
                limit,
                human,
            } => {
                commands::trust_cli::query(commands::trust_cli::TrustQueryOptions {
                    target,
                    domain,
                    limit,
                    human,
                })
                .await?;
            }
            TrustAction::Block {
                target,
                reason,
                human,
            } => {
                commands::trust_cli::block(target, reason, human).await?;
            }
            TrustAction::Unblock { target, human } => {
                commands::trust_cli::unblock(target, human).await?;
            }
            TrustAction::ListBlocked { human } => {
                commands::trust_cli::list_blocked(commands::trust_cli::TrustListOptions { human })
                    .await?;
            }
            TrustAction::Allow {
                target,
                note,
                human,
            } => {
                commands::trust_cli::allow(commands::trust_cli::TrustAllowOptions {
                    target,
                    note,
                    human,
                })
                .await?;
            }
            TrustAction::ListAllowed { human } => {
                commands::trust_cli::list_allowed(commands::trust_cli::TrustListOptions { human })
                    .await?;
            }
        },

        Commands::Block {
            target,
            reason,
            human,
        } => {
            commands::block::run(commands::block::BlockOptions {
                target,
                reason,
                human,
            })
            .await?;
        }

        Commands::Unblock { target, human } => {
            commands::unblock::run(commands::unblock::UnblockOptions { target, human }).await?;
        }

        Commands::Listen {
            relay,
            token,
            background,
            json,
            discoverable,
            name,
            description,
            capabilities,
        } => {
            commands::listen::run(commands::listen::ListenOptions {
                relay,
                token,
                background,
                json,
                discoverable,
                name,
                description,
                capabilities,
            })
            .await?;
        }

        Commands::Leave => {
            commands::leave::run(commands::leave::LeaveOptions {}).await?;
        }

        Commands::Publish { relay, human } => {
            commands::publish::run(commands::publish::PublishOptions { relay, human }).await?;
        }

        Commands::Unpublish { relay, human } => {
            commands::unpublish::run(commands::unpublish::UnpublishOptions { relay, human })
                .await?;
        }

        // ── Admin Commands ─────────────────────────────────────────────────────────
        Commands::Inbox {
            limit,
            unread,
            thread,
            wait,
            json,
            human,
        } => {
            commands::inbox::run(commands::inbox::InboxOptions {
                limit: Some(limit),
                unread,
                thread,
                wait,
                human,
                json,
            })
            .await?;
        }

        Commands::Alias { action } => match action {
            AliasAction::Set { name, did } => {
                commands::alias::set(commands::alias::AliasSetOptions { name, did })?;
            }
            AliasAction::List { human } => {
                commands::alias::list(commands::alias::AliasListOptions { human })?;
            }
            AliasAction::Get { name } => {
                commands::alias::get(commands::alias::AliasGetOptions { name })?;
            }
            AliasAction::Remove { name } => {
                commands::alias::remove(commands::alias::AliasRemoveOptions { name })?;
            }
        },

        Commands::Card { json, human } => {
            commands::status::run(commands::status::StatusOptions { json, human }).await?;
        }

        Commands::Sessions { action } => match action {
            SessionsAction::List { with, limit, human } => {
                commands::sessions::list(commands::sessions::SessionsListOptions {
                    with,
                    limit,
                    human,
                })
                .await?;
            }
            SessionsAction::Show {
                thread_id,
                limit,
                human,
            } => {
                commands::sessions::show(commands::sessions::SessionsShowOptions {
                    thread_id,
                    limit,
                    human,
                })
                .await?;
            }
        },

        Commands::Identity { json, human } => {
            commands::status::run(commands::status::StatusOptions { json, human }).await?;
        }

        Commands::Peers { human } => {
            commands::peers::run(commands::peers::PeersOptions { human }).await?;
        }

        Commands::Serve { port, host } => {
            commands::serve::run(commands::serve::ServeOptions { port, host }).await?;
        }

        Commands::Stop => {
            commands::daemon::stop(commands::daemon::DaemonStopOptions {}).await?;
        }

        Commands::Reachability { action } => match action {
            ReachabilityAction::Show { json } => {
                commands::reachability::run(commands::reachability::ReachabilityAction::Show {
                    json,
                })
                .await?;
            }
            ReachabilityAction::Mode { mode } => {
                commands::reachability::run(commands::reachability::ReachabilityAction::Mode {
                    mode,
                })
                .await?;
            }
            ReachabilityAction::SetBootstrap { providers } => {
                commands::reachability::run(
                    commands::reachability::ReachabilityAction::SetBootstrap { providers },
                )
                .await?;
            }
            ReachabilityAction::SetTarget { count } => {
                commands::reachability::run(
                    commands::reachability::ReachabilityAction::SetTarget { count },
                )
                .await?;
            }
            ReachabilityAction::ResetDefault => {
                commands::reachability::run(
                    commands::reachability::ReachabilityAction::ResetDefault,
                )
                .await?;
            }
            ReachabilityAction::OperatorLock { state } => {
                commands::reachability::run(
                    commands::reachability::ReachabilityAction::OperatorLock { state },
                )
                .await?;
            }
        },

        Commands::Status { json, human } => {
            commands::status::run(commands::status::StatusOptions { json, human }).await?;
        }

        // ── Legacy Commands ────────────────────────────────────────────────────────
        Commands::Init {
            name,
            description,
            force,
        } => {
            eprintln!("Warning: 'init' is deprecated. Use 'a4 listen' instead for automatic identity creation.");
            eprintln!(
                "Example: a4 listen --discoverable --name \"{}\" --description \"{}\"",
                name, description
            );
            commands::init::run(commands::init::InitOptions {
                name,
                description,
                force,
            })?;
        }

        Commands::Discover {
            query,
            limit,
            relay,
            human,
        } => {
            eprintln!("Warning: 'discover' is deprecated. Use 'find' instead.");
            eprintln!("Example: a4 find {}", query);
            commands::discover::run(commands::discover::DiscoverOptions {
                query,
                limit,
                relay,
                human,
            })
            .await?;
        }

        Commands::Send {
            to,
            message,
            payload,
            r#type,
            protocol,
            relay,
            human,
            thread,
            new_thread,
        } => {
            eprintln!("Warning: 'send' is deprecated. Use 'tell' instead.");
            eprintln!(
                "Example: a4 tell {} \"{}\"",
                to,
                message.as_deref().unwrap_or("message")
            );
            commands::send::run(commands::send::SendOptions {
                to,
                message,
                payload,
                msg_type: r#type,
                relay,
                protocol,
                human,
                thread,
                new_thread,
            })
            .await?;
        }
        Commands::Daemon { action } => match action {
            DaemonAction::Status => {
                eprintln!("Warning: 'daemon status' is deprecated. Use 'status' instead.");
                commands::daemon::status(commands::daemon::DaemonStatusOptions {}).await?;
            }
            DaemonAction::Stop => {
                eprintln!("Warning: 'daemon stop' is deprecated. Use 'stop' instead.");
                commands::daemon::stop(commands::daemon::DaemonStopOptions {}).await?;
            }
        },

        // ── Removal Stubs ──────────────────────────────────────────────────────────
        Commands::Ask { .. } => {
            eprintln!("Error: 'ask' has been removed. Use: a4 tell <target> <message> --wait");
            std::process::exit(1);
        }

        Commands::Route { .. } => {
            eprintln!("Error: 'route' has been removed. Use: a4 find <capability>, then a4 tell <target> <message>");
            std::process::exit(1);
        }
    }

    Ok(())
}
