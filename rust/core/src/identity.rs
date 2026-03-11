use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;

use crate::config::{AgentCardConfig, IdentityConfig};

pub struct KeyPair {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
}

impl KeyPair {
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        KeyPair {
            signing_key,
            verifying_key,
        }
    }

    pub fn from_hex(private_hex: &str) -> Result<Self> {
        let bytes = hex::decode(private_hex).context("Invalid private key hex")?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
        let signing_key = SigningKey::from_bytes(&arr);
        let verifying_key = signing_key.verifying_key();
        Ok(KeyPair {
            signing_key,
            verifying_key,
        })
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.verifying_key.as_bytes())
    }

    pub fn private_key_hex(&self) -> String {
        hex::encode(self.signing_key.as_bytes())
    }

    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        self.signing_key.sign(data).to_bytes().to_vec()
    }
}

/// Derive did:clawiverse DID from public key bytes using base58btc encoding.
/// The TS code uses multiformats base58btc which prefixes with 'z'.
pub fn derive_did(public_key_bytes: &[u8]) -> String {
    // multiformats base58btc adds a 'z' prefix
    let encoded = bs58::encode(public_key_bytes).into_string();
    format!("did:agent:z{}", encoded)
}

/// Extract raw public key bytes from a did:clawiverse DID.
#[allow(dead_code)]
pub fn extract_public_key(did: &str) -> Result<Vec<u8>> {
    let suffix = did
        .strip_prefix("did:agent:")
        .ok_or_else(|| anyhow::anyhow!("Invalid DID: must start with did:agent:"))?;
    // Strip the 'z' multibase prefix
    let b58 = suffix.strip_prefix('z').unwrap_or(suffix);
    let bytes = bs58::decode(b58)
        .into_vec()
        .context("Failed to decode base58 public key from DID")?;
    Ok(bytes)
}

/// Anonymous identity for frictionless onboarding (CVP-0021)
pub struct AnonymousIdentity {
    pub identity: IdentityConfig,
    pub agent_card: AgentCardConfig,
}

/// Generate anonymous identity for CVP-0021 frictionless onboarding
pub fn generate_anonymous_identity() -> AnonymousIdentity {
    let keypair = KeyPair::generate();
    let did = derive_did(keypair.verifying_key.as_bytes());

    // Extract last 8 characters from DID (after the 'z' multibase prefix)
    let did_suffix = did
        .split(':')
        .next_back()
        .unwrap()
        .chars()
        .skip(1)
        .collect::<String>();
    let suffix = &did_suffix[did_suffix.len().saturating_sub(8)..];

    let identity = IdentityConfig {
        did: did.clone(),
        public_key: keypair.public_key_hex(),
        private_key: keypair.private_key_hex(),
    };

    let agent_card = AgentCardConfig {
        name: format!("Agent-{}", suffix),
        description: format!("Anonymous agent {}", suffix),
        capabilities: Vec::new(),
    };

    AnonymousIdentity {
        identity,
        agent_card,
    }
}
