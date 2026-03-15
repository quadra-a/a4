use anyhow::{anyhow, Context, Result};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X25519KeyPair {
    pub public_key: [u8; 32],
    pub private_key: [u8; 32],
}

pub fn array32(bytes: &[u8], label: &str) -> Result<[u8; 32]> {
    bytes
        .try_into()
        .map_err(|_| anyhow!("{} must be 32 bytes", label))
}

pub fn array24(bytes: &[u8], label: &str) -> Result<[u8; 24]> {
    bytes
        .try_into()
        .map_err(|_| anyhow!("{} must be 24 bytes", label))
}

pub fn generate_x25519_key_pair() -> X25519KeyPair {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    X25519KeyPair {
        public_key: public.to_bytes(),
        private_key: secret.to_bytes(),
    }
}

pub fn derive_x25519_public_key(private_key: &[u8]) -> Result<[u8; 32]> {
    let secret = StaticSecret::from(array32(private_key, "X25519 private key")?);
    Ok(PublicKey::from(&secret).to_bytes())
}

pub fn diffie_hellman_x25519(private_key: &[u8], public_key: &[u8]) -> Result<[u8; 32]> {
    let secret = StaticSecret::from(array32(private_key, "X25519 private key")?);
    let public = PublicKey::from(array32(public_key, "X25519 public key")?);
    Ok(secret.diffie_hellman(&public).to_bytes())
}

pub fn hkdf_sha256(
    input_key_material: &[u8],
    salt: &[u8],
    info: &[u8],
    length: usize,
) -> Result<Vec<u8>> {
    let hk = Hkdf::<Sha256>::new(Some(salt), input_key_material);
    let mut output = vec![0u8; length];
    hk.expand(info, &mut output)
        .map_err(|_| anyhow!("Failed to expand HKDF-SHA256 output"))?;
    Ok(output)
}

pub fn encrypt_xchacha20poly1305(
    key: &[u8],
    nonce: &[u8],
    plaintext: &[u8],
    associated_data: &[u8],
) -> Result<Vec<u8>> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).context("Invalid XChaCha20-Poly1305 key")?;
    let nonce = array24(nonce, "XChaCha20-Poly1305 nonce")?;
    cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: associated_data,
            },
        )
        .map_err(|_| anyhow!("Failed to encrypt with XChaCha20-Poly1305"))
}

pub fn decrypt_xchacha20poly1305(
    key: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    associated_data: &[u8],
) -> Result<Vec<u8>> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).context("Invalid XChaCha20-Poly1305 key")?;
    let nonce = array24(nonce, "XChaCha20-Poly1305 nonce")?;
    cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: associated_data,
            },
        )
        .map_err(|_| anyhow!("Failed to decrypt with XChaCha20-Poly1305"))
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut output = vec![0u8; length];
    OsRng.fill_bytes(&mut output);
    output
}
