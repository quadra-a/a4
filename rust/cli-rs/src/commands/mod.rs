// Legacy commands
pub mod alias;
pub mod daemon;
pub mod discover;
pub mod inbox;
pub mod init;
pub mod send;
pub mod sessions;
pub mod status;

// Primary semantic verbs (CVP-0019)
pub mod block;
pub mod endorsements;
pub mod find;
pub mod leave;
pub mod listen;
pub mod message_lifecycle;
pub mod publish;
pub mod reachability;
pub mod score;
pub mod target_resolution;
pub mod tell;
pub mod trace;
pub mod unblock;
pub mod unpublish;
pub mod vouch;

// Admin commands
pub mod peers;
pub mod serve;

// Removal stubs (CVP-0020)
pub mod ask;
pub mod route;
