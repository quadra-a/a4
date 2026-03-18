use anyhow::Result;
use clap::{Parser, Subcommand};
use quadra_a_cli::commands;
use std::env;

const SERVE_AFTER_HELP: &str = "\
Handler contract:
  stdin  receives the incoming message payload JSON (not the full envelope)
  stdout JSON object becomes the reply payload as-is
  stdout non-JSON is wrapped as {\"result\":\"<stdout>\"}
  exit!=0 sends a HANDLER_ERROR reply
  timeout sends a TIMEOUT reply";

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
        /// Output as JSON
        #[arg(long)]
        json: bool,
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
        /// Message body
        #[arg(long)]
        body: Option<String>,
        /// Read message body from a file
        #[arg(long)]
        body_file: Option<String>,
        /// Read message body from stdin
        #[arg(long)]
        body_stdin: bool,
        /// Body format: text or json
        #[arg(long)]
        body_format: Option<String>,
        /// Protocol identifier
        #[arg(long, default_value = "/agent/msg/1.0.0")]
        protocol: String,
        /// Delivery mode: required, preferred, or disabled
        #[arg(long, default_value = "required")]
        delivery_mode: String,
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
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Wait for a reply or async result for a previously sent message
    Wait {
        /// Full message ID or local suffix
        message_id: String,
        /// Wait timeout in seconds
        #[arg(long, default_value = "30")]
        timeout: u64,
        /// Output as JSON
        #[arg(long)]
        json: bool,
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
        /// Output as JSON
        #[arg(long)]
        json: bool,
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
        /// Output as JSON
        #[arg(long)]
        json: bool,
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
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Block an agent
    Block {
        /// Agent DID or alias to block
        target: String,
        /// Reason for blocking
        #[arg(long)]
        reason: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Unblock an agent
    Unblock {
        /// Agent DID or alias to unblock
        target: String,
        /// Preserve interaction history (by default, history is reset to prevent auto-re-blocking)
        #[arg(long)]
        keep_history: bool,
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Allowlist an agent (bypass all defense checks)
    Allow {
        /// Agent DID or alias to allowlist
        target: String,
        /// Note about this agent
        #[arg(long)]
        note: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
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

    /// Disconnect from relays and stop the local listener
    Leave,

    /// Publish agent card to relay index
    Publish {
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Remove agent card from relay index
    Unpublish {
        /// Relay URL
        #[arg(long, env = "QUADRA_A_RELAY")]
        relay: Option<String>,
        /// Output as JSON
        #[arg(long)]
        json: bool,
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
        /// Include internal system/diagnostic messages
        #[arg(long)]
        include_system: bool,
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

    /// Manage agent card details
    Card {
        #[command(subcommand)]
        action: CardAction,
    },

    /// Manage conversation threads
    Sessions {
        #[command(subcommand)]
        action: SessionsAction,
    },

    /// Manage identity information
    Identity {
        #[command(subcommand)]
        action: IdentityAction,
    },

    /// Show connected peers
    Peers {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },

    /// Register handlers for incoming requests
    #[command(after_help = SERVE_AFTER_HELP)]
    Serve {
        /// Capability name to handle
        #[arg(long)]
        on: Option<String>,
        /// Script to execute for matching requests
        #[arg(long)]
        exec: Option<String>,
        /// Directory of handler scripts (filename = capability name)
        #[arg(long)]
        handlers: Option<String>,
        /// Only accept requests from these DIDs
        #[arg(long)]
        allow_from: Vec<String>,
        /// Accept requests from any agent
        #[arg(long)]
        public: bool,
        /// Max concurrent handler executions
        #[arg(long, default_value = "4")]
        max_concurrency: usize,
        /// Handler timeout in seconds
        #[arg(long, default_value = "60")]
        timeout: u64,
        /// Output format: text|json
        #[arg(long, default_value = "text")]
        format: String,
        /// Arguments passed to the handler after `--`
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        exec_args: Vec<String>,
    },

    /// Stop the local daemon
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

    /// Manage E2E encryption sessions
    E2e {
        #[command(subcommand)]
        action: E2eAction,
    },

    /// Show E2E pre-key and device-directory health
    Prekeys {
        /// Output format: text|json
        #[arg(long, default_value = "text")]
        format: String,
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
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
        /// Output as JSON
        #[arg(long)]
        json: bool,
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
enum CardAction {
    /// Show the current agent card
    Show {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },
}

#[derive(Subcommand)]
enum IdentityAction {
    /// Show the current identity
    Show {
        /// Output as JSON
        #[arg(long)]
        json: bool,
        /// Human-friendly output with colors
        #[arg(long)]
        human: bool,
    },
}

#[derive(Subcommand)]
enum E2eAction {
    /// Show E2E session status
    Status {
        /// Output as JSON
        #[arg(long)]
        json: bool,
    },
    /// Clear E2E sessions (for a specific peer or all)
    Reset {
        /// Peer DID to clear sessions for (omit to clear all)
        peer: Option<String>,
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
            json,
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
                json,
                human,
            })
            .await?;
        }

        Commands::Tell {
            target,
            message,
            body,
            body_file,
            body_stdin,
            body_format,
            protocol,
            delivery_mode,
            reply_to,
            thread,
            new_thread,
            wait,
            relay,
            json,
            human,
        } => {
            // Detect if --protocol was explicitly set by the user
            let protocol_explicit = std::env::args().any(|arg| arg == "--protocol");

            commands::tell::run(commands::tell::TellOptions {
                target,
                message,
                body,
                body_file,
                body_stdin,
                body_format,
                protocol,
                protocol_explicit,
                delivery_mode,
                reply_to,
                thread,
                new_thread,
                wait,
                relay,
                json,
                human,
            })
            .await?;
        }

        Commands::Wait {
            message_id,
            timeout,
            json,
            human,
        } => {
            commands::wait::run(commands::wait::WaitOptions {
                message_id,
                timeout_secs: timeout,
                json,
                human,
            })
            .await?;
        }

        Commands::Score {
            target,
            detailed,
            json,
            human,
        } => {
            commands::score::run(commands::score::ScoreOptions {
                target,
                detailed,
                json,
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
            json,
            human,
        } => {
            commands::vouch::run(commands::vouch::VouchOptions {
                target,
                endorsement_type: r#type,
                strength,
                comment,
                domain: None, // TODO: Add domain support to CLI args
                json,
                human,
            })
            .await?;
        }

        Commands::Endorsements {
            target,
            created_by,
            domain,
            limit,
            json,
            human,
        } => {
            commands::endorsements::run(commands::endorsements::EndorsementsOptions {
                target,
                created_by,
                domain,
                limit,
                json,
                human,
            })
            .await?;
        }

        Commands::Block {
            target,
            reason,
            json,
            human,
        } => {
            commands::block::run(commands::block::BlockOptions {
                target,
                reason,
                json,
                human,
            })
            .await?;
        }

        Commands::Unblock {
            target,
            keep_history,
            json,
            human,
        } => {
            commands::unblock::run(commands::unblock::UnblockOptions {
                target,
                keep_history,
                json,
                human,
            })
            .await?;
        }

        Commands::Allow {
            target,
            note,
            json,
            human,
        } => {
            commands::allow::run(commands::allow::AllowOptions {
                target,
                note,
                json,
                human,
            })
            .await?;
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

        Commands::Publish { relay, json, human } => {
            commands::publish::run(commands::publish::PublishOptions { relay, json, human })
                .await?;
        }

        Commands::Unpublish { relay, json, human } => {
            commands::unpublish::run(commands::unpublish::UnpublishOptions { relay, json, human })
                .await?;
        }

        // ── Admin Commands ─────────────────────────────────────────────────────────
        Commands::Inbox {
            limit,
            unread,
            thread,
            include_system,
            wait,
            json,
            human,
        } => {
            commands::inbox::run(commands::inbox::InboxOptions {
                limit: Some(limit),
                unread,
                thread,
                include_system,
                wait,
                human,
                json,
            })
            .await?;
        }

        Commands::Alias { action } => match action {
            AliasAction::Set { name, did, json } => {
                commands::alias::set(commands::alias::AliasSetOptions { name, did, json })?;
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

        Commands::Card { action } => match action {
            CardAction::Show { json, human } => {
                commands::card::show(commands::card::CardShowOptions { json, human }).await?;
            }
        },

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

        Commands::Identity { action } => match action {
            IdentityAction::Show { json, human } => {
                commands::identity::show(commands::identity::IdentityShowOptions { json, human })
                    .await?;
            }
        },

        Commands::Peers { json, human } => {
            commands::peers::run(commands::peers::PeersOptions { json, human }).await?;
        }

        Commands::Serve {
            on,
            exec,
            handlers,
            allow_from,
            public,
            max_concurrency,
            timeout,
            format,
            exec_args,
        } => {
            commands::serve::run(commands::serve::ServeOptions {
                on,
                exec,
                handlers,
                allow_from,
                public,
                max_concurrency,
                timeout_secs: timeout,
                format,
                exec_args,
            })
            .await?;
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

        Commands::E2e { action } => match action {
            E2eAction::Status { json } => {
                commands::e2e::e2e_status(commands::e2e::E2eStatusOptions { json }).await?;
            }
            E2eAction::Reset { peer } => {
                commands::e2e::e2e_reset(commands::e2e::E2eResetOptions { peer_did: peer }).await?;
            }
        },

        Commands::Prekeys { format, json } => {
            commands::prekeys::run(commands::prekeys::PrekeysOptions { json, format }).await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn cli_definition_passes_clap_debug_assertions() {
        Cli::command().debug_assert();
    }
}
