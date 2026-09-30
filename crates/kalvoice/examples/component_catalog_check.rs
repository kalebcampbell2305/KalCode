//! Release-ops check: verifies a signed KalVoice component catalog with the application's own
//! verifier code (`ComponentVerifier`, `verify_catalog`, `advance_catalog_floor`,
//! `authorize_transition`) exactly as the desktop client would, and optionally proves that the
//! candidate is a legal forward transition from a previously published catalog.
//!
//! It reads only a public key document and signed tokens. It never touches private keys, the
//! network, or the OS-held floor store.
//!
//! ```text
//! cargo run --locked -p kalcode-kalvoice --example component_catalog_check -- \
//!   --public-key-file <abs> --token <abs> --platform windows|macos \
//!   [--previous-token <abs>] [--channel stable] [--now <unix>]
//! ```
//!
//! On success it prints one JSON line and exits 0. On failure it prints one bounded JSON error
//! line and exits 1.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use kalcode_kalvoice::component_catalog::{
    CatalogContract, CatalogTransitionError, VerifiedComponentCatalog, WHISPER_GGML_ABI,
    advance_catalog_floor, verify_catalog,
};
use kalcode_kalvoice::component_manifest::{
    ComponentArch, ComponentPlatform, ComponentVerifier, RollbackAllowance, TransitionError,
    authorize_transition,
};
use kalcode_kalvoice::component_store::{
    LOCAL_REASONING_MODEL_ID, LOCAL_REASONING_RUNTIME_ABI, LOCAL_REASONING_RUNTIME_ID,
};
use serde::Deserialize;
use serde_json::json;

/// Must equal `SPEECH_COMPONENT_IDS` in `apps/desktop/src-tauri/src/kalvoice_components.rs`.
/// `tooling/release/component-renew.test.mjs` fails if the two lists drift.
const SPEECH_COMPONENT_IDS: [&str; 5] = [
    "kalvoice.speech.whisper.tiny-en",
    "kalvoice.speech.whisper.base-en",
    "kalvoice.speech.whisper.small-en",
    "kalvoice.speech.whisper.base",
    "kalvoice.speech.whisper.small",
];
const DEFAULT_SPEECH_COMPONENT_ID: &str = SPEECH_COMPONENT_IDS[0];
/// Must equal the host list in `apps/desktop/src-tauri/src/kalvoice_component_trust.rs`.
const ALLOWED_HOSTS: [&str; 1] = ["kalcoded.com"];
const MAX_TOKEN_FILE_BYTES: u64 = 192 * 1024 + 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicDocument {
    schema_version: u32,
    alg: String,
    kid: String,
    x: String,
}

struct Args {
    public_key_file: String,
    token: String,
    previous_token: Option<String>,
    channel: String,
    platform: ComponentPlatform,
    arch: ComponentArch,
    now: i64,
}

fn fail(code: &str) -> String {
    code.to_owned()
}

fn parse_args() -> Result<Args, String> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if !raw.len().is_multiple_of(2) {
        return Err(fail("usage"));
    }
    let mut map = BTreeMap::new();
    for [key, value] in raw.as_chunks::<2>().0 {
        let allowed = [
            "--public-key-file",
            "--token",
            "--previous-token",
            "--channel",
            "--platform",
            "--now",
        ];
        if !allowed.contains(&key.as_str()) || value.starts_with("--") {
            return Err(fail("usage"));
        }
        if map.insert(key.clone(), value.clone()).is_some() {
            return Err(fail("usage"));
        }
    }
    let (platform, arch) = match map.get("--platform").map(String::as_str) {
        Some("windows") => (ComponentPlatform::Windows, ComponentArch::X86_64),
        Some("macos") => (ComponentPlatform::Macos, ComponentArch::Aarch64),
        _ => return Err(fail("usage")),
    };
    let now = match map.get("--now") {
        Some(value) => value.parse::<i64>().map_err(|_| fail("usage"))?,
        None => i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| fail("clock_invalid"))?
                .as_secs(),
        )
        .map_err(|_| fail("clock_invalid"))?,
    };
    Ok(Args {
        public_key_file: map
            .get("--public-key-file")
            .cloned()
            .ok_or_else(|| fail("usage"))?,
        token: map.get("--token").cloned().ok_or_else(|| fail("usage"))?,
        previous_token: map.get("--previous-token").cloned(),
        channel: map
            .get("--channel")
            .cloned()
            .unwrap_or_else(|| "stable".to_owned()),
        platform,
        arch,
        now,
    })
}

fn read_small(path: &str, code: &str) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| fail(code))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_TOKEN_FILE_BYTES {
        return Err(fail(code));
    }
    let text = std::fs::read_to_string(path).map_err(|_| fail(code))?;
    Ok(text.trim_end_matches(['\r', '\n']).to_owned())
}

fn verifier(path: &str) -> Result<ComponentVerifier, String> {
    let document: PublicDocument =
        serde_json::from_str(&read_small(path, "public_key_unreadable")?)
            .map_err(|_| fail("public_key_invalid"))?;
    if document.schema_version != 1 || document.alg != "EdDSA" {
        return Err(fail("public_key_invalid"));
    }
    ComponentVerifier::from_keys(
        [(document.kid.as_str(), document.x.as_str())],
        ALLOWED_HOSTS,
    )
    .map_err(|_| fail("public_key_invalid"))
}

fn contract(args: &Args) -> CatalogContract<'_> {
    CatalogContract {
        channel: &args.channel,
        platform: args.platform,
        arch: args.arch,
        reasoning_runtime_id: LOCAL_REASONING_RUNTIME_ID,
        reasoning_model_id: LOCAL_REASONING_MODEL_ID,
        reasoning_abi: LOCAL_REASONING_RUNTIME_ABI,
        speech_model_ids: &SPEECH_COMPONENT_IDS,
        default_speech_model_id: DEFAULT_SPEECH_COMPONENT_ID,
        speech_model_abi: WHISPER_GGML_ABI,
    }
}

fn check_transitions(
    previous: &VerifiedComponentCatalog,
    candidate: &VerifiedComponentCatalog,
    now: i64,
) -> Result<serde_json::Value, String> {
    // The OS-held floor the client stores after installing from `previous`.
    let previous_floor = previous.floor();
    let advanced = advance_catalog_floor(Some(&previous_floor), candidate, now).map_err(
        |error| match error {
            CatalogTransitionError::RollbackDenied => fail("floor_rollback_denied"),
            CatalogTransitionError::ConflictingSequence => fail("floor_conflicting_sequence"),
            CatalogTransitionError::DifferentTrack => fail("floor_different_track"),
            CatalogTransitionError::Expired => fail("floor_candidate_expired"),
            CatalogTransitionError::NotYetValid => fail("floor_candidate_not_yet_valid"),
            CatalogTransitionError::InvalidFloor => fail("floor_invalid"),
        },
    )?;
    if advanced.sequence() != candidate.catalog().sequence
        || advanced.sequence() <= previous_floor.sequence()
        || advanced.token_sha256() != candidate.token_sha256()
    {
        return Err(fail("floor_not_advanced"));
    }
    // Once the candidate floor is stored, the previous catalog must be refused as a rollback.
    let reverse = advance_catalog_floor(Some(&advanced), previous, previous.catalog().issued_at);
    if reverse != Err(CatalogTransitionError::RollbackDenied) {
        return Err(fail("floor_reverse_not_denied"));
    }

    let mut manifests = Vec::new();
    for entry in candidate.entries() {
        let next = entry.component();
        let id = &next.manifest().component_id;
        let prior = previous
            .entries()
            .iter()
            .find(|candidate| &candidate.component().manifest().component_id == id)
            .ok_or_else(|| fail("manifest_missing_in_previous"))?
            .component();
        authorize_transition(Some(prior), next, RollbackAllowance::Disallow).map_err(|error| {
            match error {
                TransitionError::ConflictingRevision => fail("manifest_conflicting_revision"),
                TransitionError::DowngradeDenied => fail("manifest_downgrade_denied"),
                TransitionError::DifferentTrack => fail("manifest_different_track"),
                TransitionError::RollbackMismatch => fail("manifest_rollback_mismatch"),
            }
        })?;
        if authorize_transition(Some(next), prior, RollbackAllowance::Disallow)
            != Err(TransitionError::DowngradeDenied)
        {
            return Err(fail("manifest_reverse_not_denied"));
        }
        if prior.manifest().sha256 != next.manifest().sha256
            || prior.manifest().size_bytes != next.manifest().size_bytes
            || prior.manifest().artifact_url != next.manifest().artifact_url
        {
            return Err(fail("manifest_artifact_changed"));
        }
        manifests.push(json!({
            "componentId": id,
            "previousSequence": prior.manifest().sequence,
            "sequence": next.manifest().sequence,
        }));
    }
    Ok(json!({
        "previousSequence": previous_floor.sequence(),
        "previousTokenSha256": previous_floor.token_sha256(),
        "floorAdvancedTo": advanced.sequence(),
        "reverseRollbackDenied": true,
        "manifests": manifests,
    }))
}

fn run() -> Result<serde_json::Value, String> {
    let args = parse_args()?;
    let verifier = verifier(&args.public_key_file)?;
    let token = read_small(&args.token, "token_unreadable")?;
    let candidate = verify_catalog(&verifier, &token, args.now, contract(&args))
        .map_err(|error| format!("catalog_rejected:{error:?}"))?;
    let catalog = candidate.catalog();
    let mut report = json!({
        "ok": true,
        "verifier": "kalcode_kalvoice::component_catalog::verify_catalog",
        "channel": catalog.channel,
        "platform": args.platform,
        "arch": args.arch,
        "sequence": catalog.sequence,
        "issuedAt": catalog.issued_at,
        "expiresAt": catalog.expires_at,
        "tokenSha256": candidate.token_sha256(),
        "entries": candidate.entries().len(),
    });
    if let Some(previous_path) = &args.previous_token {
        let previous_token = read_small(previous_path, "previous_token_unreadable")?;
        // The previous catalog may have expired by now. It is verified at its own issue time:
        // this proves it is authentic under the same trust root and yields the floor a client
        // that installed it holds today (expiry never erases a floor).
        let previous_issued_at = unverified_issued_at(&previous_token)?;
        let previous = verify_catalog(
            &verifier,
            &previous_token,
            previous_issued_at,
            contract(&args),
        )
        .map_err(|error| format!("previous_catalog_rejected:{error:?}"))?;
        report["transition"] = check_transitions(&previous, &candidate, args.now)?;
    }
    Ok(report)
}

/// Reads `issuedAt` from an unverified payload only to choose the evaluation time; the value is
/// then fully verified by `verify_catalog`, which rejects any token whose signature is invalid.
fn unverified_issued_at(token: &str) -> Result<i64, String> {
    use base64::Engine as _;
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| fail("previous_token_malformed"))?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| fail("previous_token_malformed"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| fail("previous_token_malformed"))?;
    value["issuedAt"]
        .as_i64()
        .ok_or_else(|| fail("previous_token_malformed"))
}

fn main() -> ExitCode {
    match run() {
        Ok(report) => {
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(code) => {
            println!("{}", json!({ "ok": false, "error": code }));
            ExitCode::FAILURE
        }
    }
}
