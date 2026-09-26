use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};

use super::*;
use crate::component_manifest::{
    ComponentLicense, ComponentManifest, ComponentProvenance, TrustedKey,
};

const NOW: i64 = 1_790_000_000;
const KEY_ID: &str = "catalog-2026";
const OTHER_KEY_ID: &str = "catalog-other";
const REASONING_RUNTIME_ID: &str = "kalvoice.runtime.llama-cpp";
const REASONING_MODEL_ID: &str = "kalvoice.reasoner.qwen3-5-0-8b-q8";
const REASONING_ABI: &str = "kalvoice-llama-cpp.v1";
const SPEECH_IDS: [&str; 5] = [
    "kalvoice.speech.whisper.tiny-en",
    "kalvoice.speech.whisper.base-en",
    "kalvoice.speech.whisper.small-en",
    "kalvoice.speech.whisper.base",
    "kalvoice.speech.whisper.small",
];

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn sign<T: Serialize>(value: &T, key: &SigningKey, kid: &str, token_type: &str) -> String {
    let header = serde_json::json!({
        "alg": "EdDSA",
        "typ": token_type,
        "kid": kid,
    });
    let header = b64(&serde_json::to_vec(&header).expect("header"));
    let payload = b64(&serde_json::to_vec(value).expect("payload"));
    let input = format!("{header}.{payload}");
    let signature = key.sign(input.as_bytes());
    format!("{input}.{}", b64(&signature.to_bytes()))
}

fn corrupt_signature(token: &str) -> String {
    let mut corrupted = token.as_bytes().to_vec();
    let signature_start = token.rfind('.').expect("signature separator") + 1;
    corrupted[signature_start] = if corrupted[signature_start] == b'A' {
        b'B'
    } else {
        b'A'
    };
    String::from_utf8(corrupted).expect("compact JWS is ASCII")
}

fn make_verifier(keys: &[(&str, &SigningKey)]) -> ComponentVerifier {
    let encoded = keys
        .iter()
        .map(|(kid, key)| (*kid, b64(key.verifying_key().as_bytes())))
        .collect::<Vec<_>>();
    ComponentVerifier::from_keys(
        encoded
            .iter()
            .map(|(kid, public_key)| (*kid, public_key.as_str())),
        ["kalcoded.com"],
    )
    .expect("verifier")
}

fn contract() -> CatalogContract<'static> {
    CatalogContract {
        channel: "stable",
        platform: ComponentPlatform::Windows,
        arch: ComponentArch::X86_64,
        reasoning_runtime_id: REASONING_RUNTIME_ID,
        reasoning_model_id: REASONING_MODEL_ID,
        reasoning_abi: REASONING_ABI,
        speech_model_ids: &SPEECH_IDS,
        default_speech_model_id: SPEECH_IDS[0],
        speech_model_abi: WHISPER_GGML_ABI,
    }
}

fn component_token(
    key: &SigningKey,
    kid: &str,
    id: &str,
    kind: ComponentKind,
    abi: &str,
    seed: u8,
) -> String {
    let digest = format!("{seed:02x}").repeat(32);
    let kind_segment = match kind {
        ComponentKind::Model => "model",
        ComponentKind::Runtime => "runtime",
    };
    let manifest = ComponentManifest {
        schema_version: 1,
        component_id: id.into(),
        kind,
        version: "2026.09.1".into(),
        sequence: 1,
        platform: ComponentPlatform::Windows,
        arch: ComponentArch::X86_64,
        runtime_abi: abi.into(),
        size_bytes: 1024 + u64::from(seed),
        sha256: digest.clone(),
        artifact_url: format!(
            "https://kalcoded.com/components/v1/{kind_segment}/{id}/2026.09.1/{digest}/artifact.bin"
        ),
        licenses: vec![ComponentLicense {
            spdx_id: "Apache-2.0".into(),
            notice_sha256: "aa".repeat(32),
        }],
        provenance: ComponentProvenance {
            source_id: "kalcode/test-component".into(),
            source_revision: "revision-1".into(),
            source_integrity_sha256: "bb".repeat(32),
            build_recipe_sha256: "cc".repeat(32),
        },
        issued_at: NOW - 600,
        expires_at: NOW + 7_200,
        key_id: kid.into(),
    };
    sign(&manifest, key, kid, crate::component_manifest::TOKEN_TYPE)
}

fn catalog(key: &SigningKey, kid: &str, sequence: u64) -> ComponentCatalog {
    let mut entries = vec![
        CatalogEntry {
            role: CatalogRole::ReasoningRuntime,
            token: component_token(
                key,
                kid,
                REASONING_RUNTIME_ID,
                ComponentKind::Runtime,
                REASONING_ABI,
                1,
            ),
        },
        CatalogEntry {
            role: CatalogRole::ReasoningModel,
            token: component_token(
                key,
                kid,
                REASONING_MODEL_ID,
                ComponentKind::Model,
                REASONING_ABI,
                2,
            ),
        },
    ];
    entries.extend(
        SPEECH_IDS
            .iter()
            .enumerate()
            .map(|(index, id)| CatalogEntry {
                role: CatalogRole::SpeechModel,
                token: component_token(
                    key,
                    kid,
                    id,
                    ComponentKind::Model,
                    WHISPER_GGML_ABI,
                    10 + index as u8,
                ),
            }),
    );
    ComponentCatalog {
        schema_version: 1,
        channel: "stable".into(),
        sequence,
        platform: ComponentPlatform::Windows,
        arch: ComponentArch::X86_64,
        reasoning_abi: REASONING_ABI.into(),
        speech_model_abi: WHISPER_GGML_ABI.into(),
        default_speech_component_id: SPEECH_IDS[0].into(),
        entries,
        issued_at: NOW - 300,
        expires_at: NOW + 3_600,
        key_id: kid.into(),
    }
}

fn catalog_token(catalog: &ComponentCatalog, key: &SigningKey, kid: &str) -> String {
    sign(catalog, key, kid, CATALOG_TOKEN_TYPE)
}

#[test]
fn verifies_exact_reasoning_and_all_compiled_speech_components() {
    let key = signing_key(7);
    let verifier = make_verifier(&[(KEY_ID, &key)]);
    let token = catalog_token(&catalog(&key, KEY_ID, 4), &key, KEY_ID);

    let verified = verify_catalog(&verifier, &token, NOW, contract()).expect("catalog");

    assert_eq!(verified.catalog().sequence, 4);
    assert_eq!(verified.entries().len(), 7);
    assert_eq!(verified.speech_models().count(), 5);
    assert_eq!(
        verified
            .entry(CatalogRole::ReasoningRuntime)
            .expect("runtime")
            .component()
            .manifest()
            .component_id,
        REASONING_RUNTIME_ID
    );
    assert_eq!(verified.token_sha256().len(), 64);
    assert!(!format!("{verified:?}").contains(&token));
}

#[test]
fn rejects_wrong_type_key_channel_and_target_before_catalog_use() {
    let key = signing_key(7);
    let other = signing_key(9);
    let verifier = make_verifier(&[(KEY_ID, &key)]);
    let value = catalog(&key, KEY_ID, 1);

    let wrong_type = sign(&value, &key, KEY_ID, crate::component_manifest::TOKEN_TYPE);
    assert_eq!(
        verify_catalog(&verifier, &wrong_type, NOW, contract()),
        Err(CatalogVerifyError::Signature(
            VerifyError::UnsupportedHeader
        ))
    );

    let bad_signature = corrupt_signature(&catalog_token(&value, &key, KEY_ID));
    assert_eq!(
        verify_catalog(&verifier, &bad_signature, NOW, contract()),
        Err(CatalogVerifyError::Signature(VerifyError::BadSignature))
    );

    let unknown_key_catalog = catalog(&other, OTHER_KEY_ID, 1);
    let unknown_key = catalog_token(&unknown_key_catalog, &other, OTHER_KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &unknown_key, NOW, contract()),
        Err(CatalogVerifyError::Signature(VerifyError::UnknownKey))
    );

    let mut wrong_channel = value.clone();
    wrong_channel.channel = "beta".into();
    let wrong_channel = catalog_token(&wrong_channel, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &wrong_channel, NOW, contract()),
        Err(CatalogVerifyError::WrongChannel)
    );

    let mut wrong_target = value;
    wrong_target.arch = ComponentArch::Aarch64;
    let wrong_target = catalog_token(&wrong_target, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &wrong_target, NOW, contract()),
        Err(CatalogVerifyError::WrongTarget)
    );
}

#[test]
fn rejects_expired_oversized_and_unknown_field_catalogs() {
    let key = signing_key(7);
    let verifier = make_verifier(&[(KEY_ID, &key)]);
    let value = catalog(&key, KEY_ID, 1);
    let token = catalog_token(&value, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, value.expires_at, contract()),
        Err(CatalogVerifyError::Signature(VerifyError::Expired))
    );
    assert_eq!(
        verify_catalog(
            &verifier,
            &token,
            value.issued_at - crate::component_manifest::CLOCK_SKEW_SECONDS - 1,
            contract()
        ),
        Err(CatalogVerifyError::Signature(VerifyError::NotYetValid))
    );
    assert_eq!(
        verify_catalog(
            &verifier,
            &"x".repeat(MAX_CATALOG_TOKEN_LENGTH + 1),
            NOW,
            contract()
        ),
        Err(CatalogVerifyError::Signature(VerifyError::Malformed))
    );

    let mut document = serde_json::to_value(value).expect("value");
    document.as_object_mut().expect("object").insert(
        "downloadUrl".into(),
        serde_json::json!("https://evil.invalid"),
    );
    let token = sign(&document, &key, KEY_ID, CATALOG_TOKEN_TYPE);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::InvalidDocument)
    );
}

#[test]
fn nested_tokens_are_independent_role_target_abi_and_identity_authorities() {
    let key = signing_key(7);
    let verifier = make_verifier(&[(KEY_ID, &key)]);

    let mut substituted = catalog(&key, KEY_ID, 1);
    substituted.entries[1].token = substituted.entries[0].token.clone();
    let token = catalog_token(&substituted, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::ComponentMismatch)
    );

    let mut corrupt_nested = catalog(&key, KEY_ID, 1);
    corrupt_nested.entries[2].token = corrupt_signature(&corrupt_nested.entries[2].token);
    let token = catalog_token(&corrupt_nested, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::NestedComponent(
            VerifyError::BadSignature
        ))
    );

    let mut wrong_abi = catalog(&key, KEY_ID, 1);
    wrong_abi.entries[2].token = component_token(
        &key,
        KEY_ID,
        SPEECH_IDS[0],
        ComponentKind::Model,
        "kalvoice-whisper-gguf.v1",
        10,
    );
    let token = catalog_token(&wrong_abi, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::ComponentMismatch)
    );

    let other = signing_key(9);
    let verifier = make_verifier(&[(KEY_ID, &key), (OTHER_KEY_ID, &other)]);
    let mut mixed_key = catalog(&key, KEY_ID, 1);
    mixed_key.entries[2].token = component_token(
        &other,
        OTHER_KEY_ID,
        SPEECH_IDS[0],
        ComponentKind::Model,
        WHISPER_GGML_ABI,
        10,
    );
    let token = catalog_token(&mixed_key, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::ComponentMismatch)
    );
}

#[test]
fn exact_compiled_speech_set_and_default_cannot_be_removed_or_substituted() {
    let key = signing_key(7);
    let verifier = make_verifier(&[(KEY_ID, &key)]);

    let mut missing = catalog(&key, KEY_ID, 1);
    missing.entries.pop();
    let token = catalog_token(&missing, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::ComponentMismatch)
    );

    let mut wrong_default = catalog(&key, KEY_ID, 1);
    wrong_default.default_speech_component_id = SPEECH_IDS[1].into();
    let token = catalog_token(&wrong_default, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::ComponentMismatch)
    );

    let mut duplicate = catalog(&key, KEY_ID, 1);
    duplicate.entries[3].token = duplicate.entries[2].token.clone();
    let token = catalog_token(&duplicate, &key, KEY_ID);
    assert_eq!(
        verify_catalog(&verifier, &token, NOW, contract()),
        Err(CatalogVerifyError::ComponentMismatch)
    );
}

#[test]
fn monotonic_floor_accepts_higher_or_exact_identity_and_rejects_rollback_conflict_and_expiry() {
    let key = signing_key(7);
    let verifier = make_verifier(&[(KEY_ID, &key)]);
    let token_two = catalog_token(&catalog(&key, KEY_ID, 2), &key, KEY_ID);
    let verified_two = verify_catalog(&verifier, &token_two, NOW, contract()).expect("sequence 2");
    let floor_two = advance_catalog_floor(None, &verified_two, NOW).expect("first floor");
    assert_eq!(
        advance_catalog_floor(Some(&floor_two), &verified_two, NOW),
        Ok(floor_two.clone())
    );

    let token_three = catalog_token(&catalog(&key, KEY_ID, 3), &key, KEY_ID);
    let verified_three =
        verify_catalog(&verifier, &token_three, NOW, contract()).expect("sequence 3");
    assert_eq!(
        advance_catalog_floor(Some(&floor_two), &verified_three, NOW)
            .expect("higher sequence")
            .sequence(),
        3
    );

    let token_one = catalog_token(&catalog(&key, KEY_ID, 1), &key, KEY_ID);
    let verified_one = verify_catalog(&verifier, &token_one, NOW, contract()).expect("sequence 1");
    assert_eq!(
        advance_catalog_floor(Some(&floor_two), &verified_one, NOW),
        Err(CatalogTransitionError::RollbackDenied)
    );

    let mut conflict = catalog(&key, KEY_ID, 2);
    conflict.expires_at -= 1;
    let conflict_token = catalog_token(&conflict, &key, KEY_ID);
    let conflict = verify_catalog(&verifier, &conflict_token, NOW, contract()).expect("conflict");
    assert_eq!(
        advance_catalog_floor(Some(&floor_two), &conflict, NOW),
        Err(CatalogTransitionError::ConflictingSequence)
    );
    assert_eq!(
        advance_catalog_floor(
            Some(&floor_two),
            &verified_two,
            verified_two.catalog().expires_at
        ),
        Err(CatalogTransitionError::Expired)
    );
}

#[test]
fn corrupted_or_cross_target_floor_fails_closed_without_erasing_the_high_water_mark() {
    let key = signing_key(7);
    let verifier = make_verifier(&[(KEY_ID, &key)]);
    let token = catalog_token(&catalog(&key, KEY_ID, 2), &key, KEY_ID);
    let verified = verify_catalog(&verifier, &token, NOW, contract()).expect("catalog");

    let mut corrupt = verified.floor();
    corrupt.token_sha256 = "not-a-digest".into();
    assert_eq!(
        advance_catalog_floor(Some(&corrupt), &verified, NOW),
        Err(CatalogTransitionError::InvalidFloor)
    );

    let mut other_target = verified.floor();
    other_target.arch = ComponentArch::Aarch64;
    assert_eq!(
        advance_catalog_floor(Some(&other_target), &verified, NOW),
        Err(CatalogTransitionError::DifferentTrack)
    );
}

#[test]
fn production_trust_inputs_remain_external_to_catalog_documents() {
    let key = signing_key(7);
    let encoded = b64(key.verifying_key().as_bytes());
    let trusted = [TrustedKey {
        kid: KEY_ID,
        x: Box::leak(encoded.into_boxed_str()),
    }];
    let verifier = ComponentVerifier::from_trusted(&trusted, &["kalcoded.com"]).expect("verifier");
    let token = catalog_token(&catalog(&key, KEY_ID, 1), &key, KEY_ID);
    let verified = verify_catalog(&verifier, &token, NOW, contract()).expect("catalog");
    let serialized = serde_json::to_string(verified.catalog()).expect("catalog json");

    assert!(!serialized.contains("publicKey"));
    assert!(!serialized.contains("allowedHost"));
    assert!(!serialized.contains("artifactUrl"));
    assert!(!format!("{verified:?}").contains(&token));
}
