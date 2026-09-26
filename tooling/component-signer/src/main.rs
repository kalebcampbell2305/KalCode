use std::collections::BTreeSet;
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use zeroize::{Zeroize as _, Zeroizing};

const STORE_MAGIC: &[u8] = b"KALCODE-COMPONENT-DISTRIBUTION-KEY-V1\0";
const DEFAULT_STORE_FILE: &str = "component-distribution-signing.dpapi";
const COMPONENT_TYPE: &str = "kalcode-local-component.v1";
const CATALOG_TYPE: &str = "kalcode-local-component-catalog.v1";
const ALGORITHM: &str = "EdDSA";
const COMPONENT_ORIGIN: &str = "https://kalcoded.com";
const MAX_STORE_BYTES: u64 = 16 * 1024;
const MAX_JSON_BYTES: u64 = 192 * 1024;
const MAX_COMPONENT_TOKEN_BYTES: usize = 32 * 1024;
const MAX_CATALOG_TOKEN_BYTES: usize = 192 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_URL_BYTES: usize = 2048;
const MAX_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS: i64 = 5 * 60;

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ComponentKind {
    Model,
    Runtime,
}

impl ComponentKind {
    fn segment(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Runtime => "runtime",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ComponentPlatform {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ComponentArch {
    X86_64,
    Aarch64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentLicense {
    spdx_id: String,
    notice_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentProvenance {
    source_id: String,
    source_revision: String,
    source_integrity_sha256: String,
    build_recipe_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentManifest {
    schema_version: u32,
    component_id: String,
    kind: ComponentKind,
    version: String,
    sequence: u64,
    platform: ComponentPlatform,
    arch: ComponentArch,
    runtime_abi: String,
    size_bytes: u64,
    sha256: String,
    artifact_url: String,
    licenses: Vec<ComponentLicense>,
    provenance: ComponentProvenance,
    issued_at: i64,
    expires_at: i64,
    key_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CatalogRole {
    ReasonRuntime,
    ReasonModel,
    SpeechModel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogEntry {
    role: CatalogRole,
    token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComponentCatalog {
    schema_version: u32,
    channel: String,
    sequence: u64,
    platform: ComponentPlatform,
    arch: ComponentArch,
    reasoning_abi: String,
    speech_model_abi: String,
    default_speech_component_id: String,
    entries: Vec<CatalogEntry>,
    issued_at: i64,
    expires_at: i64,
    key_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicKeyDocument {
    schema_version: u32,
    alg: String,
    kid: String,
    x: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusDocument {
    configured: bool,
    kid: Option<String>,
}

fn usage() -> &'static str {
    "usage: kalcode-component-signer init|status|public-key|sign-manifest|verify-manifest|sign-catalog|verify-catalog [options]"
}

fn option(args: &[String], name: &str) -> Result<String> {
    let indexes: Vec<_> = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (value == name).then_some(index))
        .collect();
    if indexes.len() != 1 {
        return Err(format!("{name} must be specified exactly once"));
    }
    args.get(indexes[0] + 1)
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("{name} needs a value"))
}

fn optional_option(args: &[String], name: &str) -> Result<Option<String>> {
    if args.iter().any(|value| value == name) {
        option(args, name).map(Some)
    } else {
        Ok(None)
    }
}

fn ensure_options(args: &[String], allowed: &[&str]) -> Result<()> {
    if !args.len().is_multiple_of(2) {
        return Err("every component signer option needs one value".to_owned());
    }
    for pair in args.chunks_exact(2) {
        if !allowed.contains(&pair[0].as_str()) || pair[1].starts_with("--") {
            return Err("component signer received an unsupported option".to_owned());
        }
    }
    Ok(())
}

fn default_store() -> Result<PathBuf> {
    let local = env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_owned())?;
    Ok(PathBuf::from(local)
        .join("KalCode")
        .join("ReleaseKeys")
        .join(DEFAULT_STORE_FILE))
}

fn store_path(args: &[String]) -> Result<PathBuf> {
    Ok(optional_option(args, "--store")?
        .map(PathBuf::from)
        .unwrap_or(default_store()?))
}

fn is_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
        && value.as_bytes()[0].is_ascii_lowercase()
}

fn safe_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn safe_source_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("..")
        && !value.contains("://")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
}

fn safe_file_name(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "component artifact file name is invalid".to_owned())?;
    if name.is_empty()
        || name.len() > 160
        || name.contains("..")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("component artifact file name is unsafe".to_owned());
    }
    Ok(name.to_owned())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn current_unix() -> Result<i64> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is invalid".to_owned())?
        .as_secs();
    i64::try_from(value).map_err(|_| "system clock is invalid".to_owned())
}

fn time_window_is_valid(issued_at: i64, expires_at: i64) -> bool {
    issued_at >= 0
        && expires_at > issued_at
        && expires_at.saturating_sub(issued_at) <= MAX_LIFETIME_SECONDS
}

fn check_current_time(issued_at: i64, expires_at: i64, now: i64) -> Result<()> {
    if now.saturating_add(CLOCK_SKEW_SECONDS) < issued_at {
        return Err("signed component document is not valid yet".to_owned());
    }
    if now >= expires_at {
        return Err("signed component document has expired".to_owned());
    }
    Ok(())
}

fn validate_manifest(manifest: &ComponentManifest) -> Result<()> {
    if manifest.schema_version != 1
        || !safe_token(&manifest.component_id, 128)
        || !safe_token(&manifest.version, 64)
        || manifest.sequence == 0
        || !safe_token(&manifest.runtime_abi, 128)
        || !(1..=MAX_ARTIFACT_BYTES).contains(&manifest.size_bytes)
        || !is_sha256(&manifest.sha256)
        || manifest.artifact_url.len() > MAX_ARTIFACT_URL_BYTES
        || manifest.licenses.is_empty()
        || manifest.licenses.len() > 16
        || !time_window_is_valid(manifest.issued_at, manifest.expires_at)
        || !is_key_id(&manifest.key_id)
    {
        return Err("component manifest document is invalid".to_owned());
    }
    let mut licenses = BTreeSet::new();
    if manifest.licenses.iter().any(|license| {
        !safe_token(&license.spdx_id, 64)
            || !is_sha256(&license.notice_sha256)
            || !licenses.insert(license.spdx_id.as_str())
    }) {
        return Err("component manifest license evidence is invalid".to_owned());
    }
    if !safe_source_id(&manifest.provenance.source_id)
        || !safe_token(&manifest.provenance.source_revision, 128)
        || !is_sha256(&manifest.provenance.source_integrity_sha256)
        || !is_sha256(&manifest.provenance.build_recipe_sha256)
    {
        return Err("component manifest provenance is invalid".to_owned());
    }
    let expected_prefix = format!(
        "{COMPONENT_ORIGIN}/components/v1/{}/{}/{}/{}/",
        manifest.kind.segment(),
        manifest.component_id,
        manifest.version,
        manifest.sha256,
    );
    let Some(file_name) = manifest.artifact_url.strip_prefix(&expected_prefix) else {
        return Err("component manifest artifact URL is invalid".to_owned());
    };
    if file_name.is_empty()
        || file_name.len() > 160
        || file_name.contains("..")
        || !file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("component manifest artifact URL is invalid".to_owned());
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(u64, String)> {
    let mut file = regular_file(path, "component artifact", MAX_ARTIFACT_BYTES)?;
    let size = file
        .metadata()
        .map_err(|_| "component artifact metadata is unavailable".to_owned())?
        .len();
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "component artifact could not be read".to_owned())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}

fn validate_manifest_artifact(manifest: &ComponentManifest, artifact: &Path) -> Result<()> {
    validate_manifest(manifest)?;
    let name = safe_file_name(artifact)?;
    let (size, digest) = hash_file(artifact)?;
    let expected_url = format!(
        "{COMPONENT_ORIGIN}/components/v1/{}/{}/{}/{digest}/{name}",
        manifest.kind.segment(),
        manifest.component_id,
        manifest.version,
    );
    if manifest.size_bytes != size
        || manifest.sha256 != digest
        || manifest.artifact_url != expected_url
    {
        return Err("component manifest does not bind the exact artifact".to_owned());
    }
    Ok(())
}

fn validate_catalog_shape(catalog: &ComponentCatalog) -> Result<()> {
    if catalog.schema_version != 1
        || !matches!(catalog.channel.as_str(), "stable" | "beta" | "dev")
        || catalog.sequence == 0
        || !safe_token(&catalog.reasoning_abi, 128)
        || !safe_token(&catalog.speech_model_abi, 128)
        || !safe_token(&catalog.default_speech_component_id, 128)
        || !(3..=7).contains(&catalog.entries.len())
        || !time_window_is_valid(catalog.issued_at, catalog.expires_at)
        || !is_key_id(&catalog.key_id)
    {
        return Err("component catalog document is invalid".to_owned());
    }
    Ok(())
}

fn validate_catalog_entries(
    catalog: &ComponentCatalog,
    public: &VerifyingKey,
    expected_kid: &str,
) -> Result<Vec<ComponentManifest>> {
    validate_catalog_shape(catalog)?;
    if catalog.key_id != expected_kid {
        return Err("component catalog key binding is invalid".to_owned());
    }
    let mut reason_runtime = 0;
    let mut reason_model = 0;
    let mut speech_models = 0;
    let mut speech_ids = BTreeSet::new();
    let mut component_ids = BTreeSet::new();
    let mut tokens = BTreeSet::new();
    let mut manifests = Vec::with_capacity(catalog.entries.len());
    for entry in &catalog.entries {
        if entry.token.len() > MAX_COMPONENT_TOKEN_BYTES {
            return Err("component catalog entry token is too large".to_owned());
        }
        if !tokens.insert(entry.token.clone()) {
            return Err("component catalog entry token is duplicated".to_owned());
        }
        let manifest: ComponentManifest =
            verify_document(&entry.token, COMPONENT_TYPE, public, expected_kid)?;
        validate_manifest(&manifest)?;
        if manifest.key_id != catalog.key_id
            || !component_ids.insert(manifest.component_id.clone())
            || manifest.platform != catalog.platform
            || manifest.arch != catalog.arch
            || manifest.issued_at > catalog.issued_at
            || manifest.expires_at < catalog.expires_at
        {
            return Err(
                "component catalog entry does not match the catalog target or time window"
                    .to_owned(),
            );
        }
        match entry.role {
            CatalogRole::ReasonRuntime => {
                reason_runtime += 1;
                if manifest.kind != ComponentKind::Runtime
                    || manifest.runtime_abi != catalog.reasoning_abi
                {
                    return Err("reason runtime catalog entry is invalid".to_owned());
                }
            }
            CatalogRole::ReasonModel => {
                reason_model += 1;
                if manifest.kind != ComponentKind::Model
                    || manifest.runtime_abi != catalog.reasoning_abi
                {
                    return Err("reason model catalog entry is invalid".to_owned());
                }
            }
            CatalogRole::SpeechModel => {
                speech_models += 1;
                if manifest.kind != ComponentKind::Model
                    || manifest.runtime_abi != catalog.speech_model_abi
                    || !speech_ids.insert(manifest.component_id.clone())
                {
                    return Err("speech model catalog entries are invalid".to_owned());
                }
            }
        }
        manifests.push(manifest);
    }
    if reason_runtime != 1
        || reason_model != 1
        || !(1..=5).contains(&speech_models)
        || !speech_ids.contains(&catalog.default_speech_component_id)
    {
        return Err("component catalog roles are invalid".to_owned());
    }
    Ok(manifests)
}

fn regular_file(path: &Path, label: &str, max: u64) -> Result<File> {
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("{label} is missing"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!("{label} must be a non-empty regular file"));
    }
    if metadata.len() > max {
        return Err(format!("{label} exceeds its safety limit"));
    }
    File::open(path).map_err(|_| format!("{label} could not be opened"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T> {
    let file = regular_file(path, label, MAX_JSON_BYTES)?;
    serde_json::from_reader(file).map_err(|_| format!("{label} is invalid"))
}

fn read_token(path: &Path, max: usize) -> Result<String> {
    let mut file = regular_file(path, "component token", max as u64 + 2)?;
    let mut value = String::new();
    file.read_to_string(&mut value)
        .map_err(|_| "component token could not be read".to_owned())?;
    let token = value.trim_end_matches(['\r', '\n']);
    if token.len() > max || token.trim() != token {
        return Err("component token is malformed".to_owned());
    }
    Ok(token.to_owned())
}

fn resolved_path_with_missing_tail(path: &Path, label: &str) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        env::current_dir()
            .map_err(|_| format!("{label} could not be resolved"))?
            .join(path)
    };
    let mut cursor = absolute.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut resolved) => {
                for component in missing.into_iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let component = cursor
                    .file_name()
                    .ok_or_else(|| format!("{label} could not be resolved"))?;
                missing.push(component.to_owned());
                cursor = cursor
                    .parent()
                    .ok_or_else(|| format!("{label} could not be resolved"))?;
            }
            Err(_) => return Err(format!("{label} could not be resolved")),
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn file_identity(path: &Path, label: &str) -> Result<(u32, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let file = File::open(path).map_err(|_| format!("{label} could not be inspected"))?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns the valid handle while Windows initializes `information`.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(format!("{label} could not be inspected"));
    }
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok((information.dwVolumeSerialNumber, index))
}

#[cfg(unix)]
fn file_identity(path: &Path, label: &str) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt as _;
    let metadata = fs::metadata(path).map_err(|_| format!("{label} could not be inspected"))?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_path: &Path, _label: &str) -> Result<(u8, u8)> {
    Err("component signer file identity checks are unavailable".to_owned())
}

#[cfg(windows)]
fn same_resolved_path(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn same_resolved_path(left: &Path, right: &Path) -> bool {
    left == right
}

fn ensure_distinct_paths(paths: &[(&Path, &str)]) -> Result<()> {
    let resolved: Vec<_> = paths
        .iter()
        .map(|(path, label)| resolved_path_with_missing_tail(path, label))
        .collect::<Result<_>>()?;
    for left in 0..paths.len() {
        for right in left + 1..paths.len() {
            if same_resolved_path(&resolved[left], &resolved[right]) {
                return Err("component signer input and output paths must be distinct".to_owned());
            }
            if paths[left].0.exists()
                && paths[right].0.exists()
                && file_identity(paths[left].0, paths[left].1)?
                    == file_identity(paths[right].0, paths[right].1)?
            {
                return Err("component signer input and output paths must be distinct".to_owned());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn protect_current_user(cleartext: &[u8]) -> Result<Vec<u8>> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    if cleartext.is_empty() || cleartext.len() > u32::MAX as usize {
        return Err("component private key material is invalid".to_owned());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: cleartext.len() as u32,
        pbData: cleartext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input borrows `cleartext`; Windows allocates output, which is copied then freed.
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() || output.cbData == 0 {
        return Err("Windows could not protect the component signing key".to_owned());
    }
    // SAFETY: the successful call initialized `cbData` bytes at `pbData`.
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: CryptProtectData allocated this pointer and it has not been freed.
    let _ = unsafe { LocalFree(output.pbData.cast()) };
    Ok(encrypted)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn unprotect_current_user(ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };
    if ciphertext.is_empty() || ciphertext.len() > u32::MAX as usize {
        return Err("encrypted component signing key is invalid".to_owned());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input borrows `ciphertext`; Windows allocates output, which is copied then freed.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() || output.cbData == 0 {
        return Err("Windows could not unlock the component signing key for this user".to_owned());
    }
    // SAFETY: the successful call initialized `cbData` writable bytes at `pbData`.
    let output_slice =
        unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let cleartext = Zeroizing::new(output_slice.to_vec());
    output_slice.zeroize();
    // SAFETY: CryptUnprotectData allocated this pointer and it has not been freed.
    let _ = unsafe { LocalFree(output.pbData.cast()) };
    Ok(cleartext)
}

#[cfg(not(windows))]
fn protect_current_user(_cleartext: &[u8]) -> Result<Vec<u8>> {
    Err("component signing key custody is available only on Windows".to_owned())
}

#[cfg(not(windows))]
fn unprotect_current_user(_ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Err("component signing key custody is available only on Windows".to_owned())
}

fn write_atomic_new(path: &Path, bytes: &[u8], label: &str) -> Result<()> {
    if path.exists() {
        return Err(format!("{label} already exists"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|_| format!("{label} directory could not be created"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("{label} file name is invalid"))?;
    let temp = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| format!("temporary {label} could not be created"))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| format!("{label} could not be written"))?;
        fs::rename(&temp, path).map_err(|_| format!("{label} could not be committed"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn initialize(path: &Path, kid: &str) -> Result<PublicKeyDocument> {
    if !is_key_id(kid) {
        return Err("component signing key id is invalid".to_owned());
    }
    if kid.len() > u8::MAX as usize {
        return Err("component signing key id is invalid".to_owned());
    }
    let key = SigningKey::generate(&mut OsRng);
    let secret = Zeroizing::new(key.to_bytes());
    let mut payload = Zeroizing::new(Vec::with_capacity(
        STORE_MAGIC.len() + 1 + kid.len() + secret.len(),
    ));
    payload.extend_from_slice(STORE_MAGIC);
    payload.push(kid.len() as u8);
    payload.extend_from_slice(kid.as_bytes());
    payload.extend_from_slice(secret.as_slice());
    let encrypted = protect_current_user(payload.as_slice())?;
    write_atomic_new(path, &encrypted, "component signing key store")?;
    Ok(public_key_document(kid, &key.verifying_key()))
}

fn load_key(path: &Path) -> Result<(String, SigningKey)> {
    let mut file = regular_file(path, "component signing key store", MAX_STORE_BYTES)?;
    let mut encrypted = Zeroizing::new(Vec::new());
    file.read_to_end(encrypted.as_mut())
        .map_err(|_| "component signing key store could not be read".to_owned())?;
    let cleartext = unprotect_current_user(encrypted.as_slice())?;
    if !cleartext.starts_with(STORE_MAGIC) || cleartext.len() <= STORE_MAGIC.len() {
        return Err("component signing key store has an unsupported purpose or format".to_owned());
    }
    let kid_len = usize::from(cleartext[STORE_MAGIC.len()]);
    let kid_start = STORE_MAGIC.len() + 1;
    let seed_start = kid_start + kid_len;
    if cleartext.len() != seed_start + 32 {
        return Err("component signing key store is corrupt".to_owned());
    }
    let kid = std::str::from_utf8(&cleartext[kid_start..seed_start])
        .map_err(|_| "component signing key store is corrupt".to_owned())?;
    if !is_key_id(kid) {
        return Err("component signing key store is corrupt".to_owned());
    }
    let seed = Zeroizing::new(
        cleartext[seed_start..]
            .try_into()
            .map_err(|_| "component signing key store is corrupt".to_owned())?,
    );
    Ok((kid.to_owned(), SigningKey::from_bytes(&seed)))
}

fn public_key_document(kid: &str, public: &VerifyingKey) -> PublicKeyDocument {
    PublicKeyDocument {
        schema_version: 1,
        alg: ALGORITHM.to_owned(),
        kid: kid.to_owned(),
        x: URL_SAFE_NO_PAD.encode(public.as_bytes()),
    }
}

fn parse_public_key(path: &Path) -> Result<(String, VerifyingKey)> {
    let document: PublicKeyDocument = read_json(path, "component public key")?;
    if document.schema_version != 1 || document.alg != ALGORITHM || !is_key_id(&document.kid) {
        return Err("component public key is invalid".to_owned());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(&document.x)
        .map_err(|_| "component public key is invalid".to_owned())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != document.x {
        return Err("component public key is not canonical".to_owned());
    }
    let bytes: [u8; 32] = decoded
        .try_into()
        .map_err(|_| "component public key is invalid".to_owned())?;
    let key = VerifyingKey::from_bytes(&bytes)
        .ok()
        .filter(|key| !key.is_weak())
        .ok_or_else(|| "component public key is invalid".to_owned())?;
    Ok((document.kid, key))
}

fn sign_document<T: Serialize>(
    value: &T,
    typ: &str,
    kid: &str,
    key: &SigningKey,
) -> Result<String> {
    let header = Header {
        alg: ALGORITHM.to_owned(),
        typ: typ.to_owned(),
        kid: kid.to_owned(),
    };
    let header = serde_json::to_vec(&header)
        .map_err(|_| "component JWS header could not be encoded".to_owned())?;
    let payload = serde_json::to_vec(value)
        .map_err(|_| "component JWS payload could not be encoded".to_owned())?;
    let header = URL_SAFE_NO_PAD.encode(header);
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let input = format!("{header}.{payload}");
    let signature = key.sign(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

fn verify_document<T: for<'de> Deserialize<'de>>(
    token: &str,
    typ: &str,
    public: &VerifyingKey,
    expected_kid: &str,
) -> Result<T> {
    let segments: Vec<_> = token.split('.').collect();
    let [header, payload, signature] = segments.as_slice() else {
        return Err("component JWS is malformed".to_owned());
    };
    let header_bytes = URL_SAFE_NO_PAD
        .decode(header)
        .map_err(|_| "component JWS header is malformed".to_owned())?;
    if URL_SAFE_NO_PAD.encode(&header_bytes) != *header {
        return Err("component JWS header is not canonical".to_owned());
    }
    let decoded_header: Header = serde_json::from_slice(&header_bytes)
        .map_err(|_| "component JWS header is invalid".to_owned())?;
    if decoded_header.alg != ALGORITHM
        || decoded_header.typ != typ
        || decoded_header.kid != expected_kid
    {
        return Err("component JWS domain or key binding is invalid".to_owned());
    }
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "component JWS payload is malformed".to_owned())?;
    if URL_SAFE_NO_PAD.encode(&payload_bytes) != *payload {
        return Err("component JWS payload is not canonical".to_owned());
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "component JWS signature is malformed".to_owned())?;
    if URL_SAFE_NO_PAD.encode(&signature_bytes) != *signature {
        return Err("component JWS signature is not canonical".to_owned());
    }
    let signature: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| "component JWS signature is malformed".to_owned())?;
    let signing_input = format!("{header}.{payload}");
    public
        .verify_strict(signing_input.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| "component JWS signature is invalid".to_owned())?;
    serde_json::from_slice(&payload_bytes)
        .map_err(|_| "component JWS payload document is invalid".to_owned())
}

fn sign_manifest(store: &Path, input: &Path, artifact: &Path, output: &Path) -> Result<()> {
    ensure_distinct_paths(&[
        (store, "component key store"),
        (input, "component manifest input"),
        (artifact, "component artifact"),
        (output, "component manifest output"),
    ])?;
    if output.exists() {
        return Err("component manifest output already exists".to_owned());
    }
    let manifest: ComponentManifest = read_json(input, "component manifest input")?;
    validate_manifest_artifact(&manifest, artifact)?;
    check_current_time(manifest.issued_at, manifest.expires_at, current_unix()?)?;
    let (kid, key) = load_key(store)?;
    if manifest.key_id != kid {
        return Err("component manifest key id does not match the component key store".to_owned());
    }
    let token = sign_document(&manifest, COMPONENT_TYPE, &kid, &key)?;
    if token.len() > MAX_COMPONENT_TOKEN_BYTES {
        return Err("component manifest token exceeds its safety limit".to_owned());
    }
    let verified: ComponentManifest =
        verify_document(&token, COMPONENT_TYPE, &key.verifying_key(), &kid)?;
    if verified != manifest {
        return Err("new component manifest token failed verification".to_owned());
    }
    write_atomic_new(
        output,
        format!("{token}\n").as_bytes(),
        "component manifest output",
    )
}

fn verify_manifest(public_key: &Path, token_path: &Path, artifact: &Path) -> Result<()> {
    ensure_distinct_paths(&[
        (public_key, "component public key"),
        (token_path, "component manifest token"),
        (artifact, "component artifact"),
    ])?;
    let (kid, public) = parse_public_key(public_key)?;
    let token = read_token(token_path, MAX_COMPONENT_TOKEN_BYTES)?;
    let manifest: ComponentManifest = verify_document(&token, COMPONENT_TYPE, &public, &kid)?;
    validate_manifest_artifact(&manifest, artifact)?;
    check_current_time(manifest.issued_at, manifest.expires_at, current_unix()?)
}

fn sign_catalog(store: &Path, input: &Path, output: &Path) -> Result<()> {
    ensure_distinct_paths(&[
        (store, "component key store"),
        (input, "component catalog input"),
        (output, "component catalog output"),
    ])?;
    if output.exists() {
        return Err("component catalog output already exists".to_owned());
    }
    let catalog: ComponentCatalog = read_json(input, "component catalog input")?;
    let (kid, key) = load_key(store)?;
    validate_catalog_entries(&catalog, &key.verifying_key(), &kid)?;
    check_current_time(catalog.issued_at, catalog.expires_at, current_unix()?)?;
    let token = sign_document(&catalog, CATALOG_TYPE, &kid, &key)?;
    if token.len() > MAX_CATALOG_TOKEN_BYTES {
        return Err("component catalog token exceeds its safety limit".to_owned());
    }
    let verified: ComponentCatalog =
        verify_document(&token, CATALOG_TYPE, &key.verifying_key(), &kid)?;
    if verified != catalog {
        return Err("new component catalog token failed verification".to_owned());
    }
    write_atomic_new(
        output,
        format!("{token}\n").as_bytes(),
        "component catalog output",
    )
}

fn verify_catalog(public_key: &Path, token_path: &Path) -> Result<()> {
    ensure_distinct_paths(&[
        (public_key, "component public key"),
        (token_path, "component catalog token"),
    ])?;
    let (kid, public) = parse_public_key(public_key)?;
    let token = read_token(token_path, MAX_CATALOG_TOKEN_BYTES)?;
    let catalog: ComponentCatalog = verify_document(&token, CATALOG_TYPE, &public, &kid)?;
    validate_catalog_entries(&catalog, &public, &kid)?;
    check_current_time(catalog.issued_at, catalog.expires_at, current_unix()?)
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    let text = serde_json::to_string(value)
        .map_err(|_| "component signer output could not be encoded".to_owned())?;
    println!("{text}");
    Ok(())
}

fn run(args: &[String]) -> Result<()> {
    let (command, tail) = args.split_first().ok_or_else(|| usage().to_owned())?;
    match command.as_str() {
        "init" => {
            ensure_options(tail, &["--store", "--kid"])?;
            let store = store_path(tail)?;
            print_json(&initialize(&store, &option(tail, "--kid")?)?)
        }
        "status" => {
            ensure_options(tail, &["--store"])?;
            let store = store_path(tail)?;
            if !store.exists() {
                return print_json(&StatusDocument {
                    configured: false,
                    kid: None,
                });
            }
            let (kid, _) = load_key(&store)?;
            print_json(&StatusDocument {
                configured: true,
                kid: Some(kid),
            })
        }
        "public-key" => {
            ensure_options(tail, &["--store"])?;
            let (kid, key) = load_key(&store_path(tail)?)?;
            print_json(&public_key_document(&kid, &key.verifying_key()))
        }
        "sign-manifest" => {
            ensure_options(tail, &["--store", "--input", "--artifact", "--output"])?;
            sign_manifest(
                &store_path(tail)?,
                Path::new(&option(tail, "--input")?),
                Path::new(&option(tail, "--artifact")?),
                Path::new(&option(tail, "--output")?),
            )?;
            println!("component manifest created and verified");
            Ok(())
        }
        "verify-manifest" => {
            ensure_options(tail, &["--public-key-file", "--token", "--artifact"])?;
            verify_manifest(
                Path::new(&option(tail, "--public-key-file")?),
                Path::new(&option(tail, "--token")?),
                Path::new(&option(tail, "--artifact")?),
            )?;
            println!("component manifest verified");
            Ok(())
        }
        "sign-catalog" => {
            ensure_options(tail, &["--store", "--input", "--output"])?;
            sign_catalog(
                &store_path(tail)?,
                Path::new(&option(tail, "--input")?),
                Path::new(&option(tail, "--output")?),
            )?;
            println!("component catalog created and verified");
            Ok(())
        }
        "verify-catalog" => {
            ensure_options(tail, &["--public-key-file", "--token"])?;
            verify_catalog(
                Path::new(&option(tail, "--public-key-file")?),
                Path::new(&option(tail, "--token")?),
            )?;
            println!("component catalog verified");
            Ok(())
        }
        _ => Err(usage().to_owned()),
    }
}

fn main() {
    if let Err(error) = run(&env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("component signer: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn times() -> (i64, i64) {
        let now = current_unix().expect("clock");
        (now - 10, now + 3600)
    }

    fn manifest(
        artifact: &Path,
        component_id: &str,
        kind: ComponentKind,
        abi: &str,
    ) -> ComponentManifest {
        let (issued_at, expires_at) = times();
        let (size_bytes, sha256) = hash_file(artifact).expect("hash artifact");
        let file = safe_file_name(artifact).expect("file name");
        ComponentManifest {
            schema_version: 1,
            component_id: component_id.to_owned(),
            kind,
            version: "1.2.3".to_owned(),
            sequence: 1,
            platform: ComponentPlatform::Windows,
            arch: ComponentArch::X86_64,
            runtime_abi: abi.to_owned(),
            size_bytes,
            artifact_url: format!(
                "{COMPONENT_ORIGIN}/components/v1/{}/{}/1.2.3/{sha256}/{file}",
                kind.segment(),
                component_id
            ),
            sha256,
            licenses: vec![ComponentLicense {
                spdx_id: "MIT".to_owned(),
                notice_sha256: "a".repeat(64),
            }],
            provenance: ComponentProvenance {
                source_id: "example/source".to_owned(),
                source_revision: "abcdef123456".to_owned(),
                source_integrity_sha256: "b".repeat(64),
                build_recipe_sha256: "c".repeat(64),
            },
            issued_at,
            expires_at,
            key_id: "component-test-1".to_owned(),
        }
    }

    fn token(key: &SigningKey, manifest: &ComponentManifest) -> String {
        sign_document(manifest, COMPONENT_TYPE, "component-test-1", key).expect("sign")
    }

    #[test]
    fn component_manifest_binds_exact_artifact_and_domain() {
        let temp = TempDir::new().expect("temp");
        let artifact = temp.path().join("runtime.zip");
        fs::write(&artifact, b"runtime bytes").expect("artifact");
        let key = SigningKey::from_bytes(&[7; 32]);
        let manifest = manifest(
            &artifact,
            "kalvoice.runtime.llama-cpp",
            ComponentKind::Runtime,
            "kalvoice-llama-cpp.v1",
        );
        validate_manifest_artifact(&manifest, &artifact).expect("valid artifact");
        let signed = token(&key, &manifest);
        let verified: ComponentManifest = verify_document(
            &signed,
            COMPONENT_TYPE,
            &key.verifying_key(),
            "component-test-1",
        )
        .expect("verify");
        assert_eq!(verified, manifest);
        let mut bad_url = manifest.clone();
        bad_url.artifact_url = "https://evil.example/runtime.zip".to_owned();
        assert!(validate_manifest(&bad_url).is_err());
        assert!(
            verify_document::<ComponentManifest>(
                &signed,
                CATALOG_TYPE,
                &key.verifying_key(),
                "component-test-1"
            )
            .is_err()
        );
        fs::write(&artifact, b"changed bytes").expect("tamper");
        assert!(validate_manifest_artifact(&manifest, &artifact).is_err());
    }

    #[test]
    fn catalog_requires_single_reason_roles_and_bounded_unique_speech_roles() {
        let temp = TempDir::new().expect("temp");
        let key = SigningKey::from_bytes(&[9; 32]);
        let make = |name: &str, id: &str, kind: ComponentKind, abi: &str| {
            let path = temp.path().join(name);
            fs::write(&path, name.as_bytes()).expect("artifact");
            let value = manifest(&path, id, kind, abi);
            CatalogEntry {
                role: match kind {
                    ComponentKind::Runtime => CatalogRole::ReasonRuntime,
                    ComponentKind::Model if abi == "kalvoice-llama-cpp.v1" => {
                        CatalogRole::ReasonModel
                    }
                    ComponentKind::Model => CatalogRole::SpeechModel,
                },
                token: token(&key, &value),
            }
        };
        let (issued_at, expires_at) = times();
        let catalog = ComponentCatalog {
            schema_version: 1,
            channel: "stable".to_owned(),
            sequence: 1,
            platform: ComponentPlatform::Windows,
            arch: ComponentArch::X86_64,
            reasoning_abi: "kalvoice-llama-cpp.v1".to_owned(),
            speech_model_abi: "kalvoice-whisper-ggml.v1".to_owned(),
            default_speech_component_id: "kalvoice.speech.whisper.tiny-en".to_owned(),
            entries: vec![
                make(
                    "runtime.zip",
                    "kalvoice.runtime.llama-cpp",
                    ComponentKind::Runtime,
                    "kalvoice-llama-cpp.v1",
                ),
                make(
                    "reasoner.gguf",
                    "kalvoice.reasoner.qwen",
                    ComponentKind::Model,
                    "kalvoice-llama-cpp.v1",
                ),
                make(
                    "tiny.bin",
                    "kalvoice.speech.whisper.tiny-en",
                    ComponentKind::Model,
                    "kalvoice-whisper-ggml.v1",
                ),
                make(
                    "base.bin",
                    "kalvoice.speech.whisper.base",
                    ComponentKind::Model,
                    "kalvoice-whisper-ggml.v1",
                ),
            ],
            issued_at,
            expires_at,
            key_id: "component-test-1".to_owned(),
        };
        assert_eq!(
            validate_catalog_entries(&catalog, &key.verifying_key(), "component-test-1")
                .expect("catalog")
                .len(),
            4
        );
        let mut duplicate = catalog.clone();
        duplicate.entries.push(duplicate.entries[2].clone());
        assert!(
            validate_catalog_entries(&duplicate, &key.verifying_key(), "component-test-1").is_err()
        );
        let mut wrong_default = catalog;
        wrong_default.default_speech_component_id = "kalvoice.speech.whisper.small".to_owned();
        assert!(
            validate_catalog_entries(&wrong_default, &key.verifying_key(), "component-test-1")
                .is_err()
        );
    }

    #[test]
    fn unknown_manifest_and_catalog_fields_are_rejected() {
        let manifest = json!({
            "schemaVersion": 1,
            "componentId": "x",
            "kind": "model",
            "version": "1.0.0",
            "sequence": 1,
            "platform": "windows",
            "arch": "x86_64",
            "runtimeAbi": "abi",
            "sizeBytes": 1,
            "sha256": "a".repeat(64),
            "artifactUrl": "https://kalcoded.com/components/v1/model/x/1.0.0/a/file",
            "licenses": [],
            "provenance": {"sourceId":"x","sourceRevision":"x","sourceIntegritySha256":"a".repeat(64),"buildRecipeSha256":"a".repeat(64)},
            "issuedAt": 1,
            "expiresAt": 2,
            "keyId": "k",
            "privateKey": "forbidden"
        });
        assert!(serde_json::from_value::<ComponentManifest>(manifest).is_err());
        let catalog = json!({
            "schemaVersion":1,"channel":"stable","sequence":1,"platform":"windows","arch":"x86_64",
            "reasoningAbi":"a","speechModelAbi":"b","defaultSpeechComponentId":"c","entries":[],
            "issuedAt":1,"expiresAt":2,"keyId":"k","url":"https://evil.example"
        });
        assert!(serde_json::from_value::<ComponentCatalog>(catalog).is_err());
    }

    #[test]
    fn output_aliases_are_rejected_before_key_access_and_artifact_mutation() {
        let temp = TempDir::new().expect("temp");
        let artifact = temp.path().join("runtime.zip");
        let input = temp.path().join("manifest.json");
        fs::write(&artifact, b"source bytes").expect("artifact");
        fs::write(&input, b"{}").expect("input");
        let before = fs::read(&artifact).expect("before");
        let error = sign_manifest(
            &temp.path().join("absent.dpapi"),
            &input,
            &artifact,
            &artifact,
        )
        .expect_err("alias must fail");
        assert!(error.contains("distinct"));
        assert_eq!(fs::read(&artifact).expect("after"), before);
        let hardlink = temp.path().join("hardlink.jws");
        fs::hard_link(&artifact, &hardlink).expect("hard link");
        let error = sign_manifest(
            &temp.path().join("absent.dpapi"),
            &input,
            &artifact,
            &hardlink,
        )
        .expect_err("hardlink must fail");
        assert!(error.contains("distinct"));
        assert_eq!(fs::read(&artifact).expect("after hardlink"), before);
    }

    #[test]
    fn component_key_public_document_contains_only_public_fields() {
        let key = SigningKey::from_bytes(&[11; 32]);
        let document = public_key_document("component-test-1", &key.verifying_key());
        let json = serde_json::to_value(document).expect("serialize");
        assert_eq!(
            json.as_object()
                .expect("object")
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            ["alg", "kid", "schemaVersion", "x"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
        assert_eq!(json["alg"], "EdDSA");
        assert!(!json.to_string().contains("private"));
        assert_ne!(STORE_MAGIC, b"KALCODE-UPDATER-KEY-V1\0");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_custody_is_current_user_scoped_and_purpose_bound() {
        let clear = Zeroizing::new([STORE_MAGIC, b"synthetic"].concat());
        let encrypted = protect_current_user(clear.as_slice()).expect("protect");
        assert_ne!(encrypted, clear.as_slice());
        assert_eq!(
            unprotect_current_user(&encrypted)
                .expect("unprotect")
                .as_slice(),
            clear.as_slice()
        );
        let temp = TempDir::new().expect("temp");
        let wrong_store = temp.path().join("updater-purpose.dpapi");
        let wrong_cleartext = Zeroizing::new(
            [
                b"KALCODE-UPDATER-KEY-V1\0".as_slice(),
                &[16],
                b"component-test-1",
                &[7; 32],
            ]
            .concat(),
        );
        fs::write(
            &wrong_store,
            protect_current_user(wrong_cleartext.as_slice()).expect("protect wrong purpose"),
        )
        .expect("write wrong purpose");
        assert!(
            load_key(&wrong_store)
                .expect_err("updater-purpose custody must be rejected")
                .contains("unsupported purpose")
        );
    }
}
