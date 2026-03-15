use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::{fs, path::Path};

#[derive(Debug, Clone, Deserialize)]
pub struct VectorNegativeVariant {
    pub id: String,
    pub mutation: Value,
    #[serde(rename = "expectedError")]
    pub expected_error: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VectorCase {
    pub id: String,
    pub description: String,
    pub inputs: Value,
    pub expected: Value,
    #[serde(rename = "negativeVariants")]
    pub negative_variants: Option<Vec<VectorNegativeVariant>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VectorManifest {
    pub suite: String,
    pub version: u32,
    pub encoding: String,
    pub notes: Option<String>,
    pub cases: Vec<VectorCase>,
}

pub fn load_vector_manifest_from_path(path: impl AsRef<Path>) -> Result<VectorManifest> {
    let json = fs::read_to_string(path.as_ref())
        .with_context(|| format!("Failed to read vector manifest {}", path.as_ref().display()))?;
    serde_json::from_str(&json).context("Failed to parse vector manifest JSON")
}

pub fn get_str<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .with_context(|| format!("Missing string field {}", field))
}

pub fn get_u64(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .with_context(|| format!("Missing integer field {}", field))
}

pub fn get_optional_u64(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

pub fn get_hex(value: &Value, field: &str) -> Result<Vec<u8>> {
    let raw = get_str(value, field)?;
    hex::decode(raw).with_context(|| format!("Field {} is not valid hex", field))
}
