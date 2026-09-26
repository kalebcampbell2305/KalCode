//! The signed-component trust root is embedded at build time, never learned from downloads.
use kalcode_kalvoice::component_manifest::ComponentVerifier;
use serde::Deserialize;

const PUBLIC_DOCUMENT: &str = include_str!("../../../../tooling/release/component-public-key.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicDocument {
    schema_version: u32,
    alg: String,
    kid: String,
    x: String,
}

pub(crate) fn production_verifier() -> Result<ComponentVerifier, &'static str> {
    verifier_from_document(PUBLIC_DOCUMENT)
}

fn verifier_from_document(document: &str) -> Result<ComponentVerifier, &'static str> {
    let key: PublicDocument =
        serde_json::from_str(document).map_err(|_| "component_trust_invalid")?;
    if key.schema_version != 1 || key.alg != "EdDSA" {
        return Err("component_trust_invalid");
    }
    ComponentVerifier::from_keys([(key.kid.as_str(), key.x.as_str())], ["kalcoded.com"])
        .map_err(|_| "component_trust_invalid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_production_public_document_constructs_the_verifier() {
        assert!(production_verifier().is_ok());
    }

    #[test]
    fn malformed_or_substituted_document_contract_fails_closed() {
        let valid: serde_json::Value = serde_json::from_str(PUBLIC_DOCUMENT).unwrap();
        for (field, value) in [
            ("schemaVersion", serde_json::json!(2)),
            ("alg", serde_json::json!("none")),
            ("x", serde_json::json!("invalid")),
            ("kid", serde_json::json!("")),
            ("downloadHost", serde_json::json!("attacker.invalid")),
        ] {
            let mut changed = valid.clone();
            changed[field] = value;
            assert!(verifier_from_document(&changed.to_string()).is_err());
        }
    }
}
