use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use minisign::{KeyPair, PublicKey, PublicKeyBox, SecretKey, SignatureBox};
use semver::Version;
use zeroize::Zeroizing;

const STORE_MAGIC: &[u8] = b"KALCODE-UPDATER-KEY-V1\0";
const MAX_STORE_BYTES: u64 = 16 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;
const DEFAULT_STORE_FILE: &str = "updater-signing.dpapi";
const TARGET_WINDOWS_X86_64: &str = "windows-x86_64";
const TARGET_DARWIN_AARCH64: &str = "darwin-aarch64";
const CHANNEL_STABLE: &str = "stable";
const CHANNEL_BETA: &str = "beta";
const CHANNEL_DEV: &str = "dev";

type Result<T> = std::result::Result<T, String>;

fn usage() -> &'static str {
    "usage: kalcode-updater-signer init|public-key|sign|verify [options]"
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
    if !args.iter().any(|value| value == name) {
        return Ok(None);
    }
    option(args, name).map(Some)
}

fn ensure_options(args: &[String], allowed: &[&str]) -> Result<()> {
    if !args.len().is_multiple_of(2) {
        return Err("every updater signer option needs one value".to_owned());
    }
    for pair in args.chunks_exact(2) {
        if !allowed.contains(&pair[0].as_str()) || pair[1].starts_with("--") {
            return Err("updater signer received an unsupported option".to_owned());
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

fn validate_version(value: &str) -> Result<String> {
    let parsed =
        Version::parse(value).map_err(|_| "version must be canonical SemVer".to_owned())?;
    if parsed.to_string() != value {
        return Err("version must be canonical SemVer".to_owned());
    }
    Ok(value.to_owned())
}

fn validate_target(value: &str) -> Result<String> {
    match value {
        TARGET_WINDOWS_X86_64 | TARGET_DARWIN_AARCH64 => Ok(value.to_owned()),
        _ => Err("target must be exactly windows-x86_64 or darwin-aarch64".to_owned()),
    }
}

fn validate_channel(value: &str) -> Result<String> {
    match value {
        CHANNEL_STABLE | CHANNEL_BETA | CHANNEL_DEV => Ok(value.to_owned()),
        _ => Err("channel must be exactly stable, beta, or dev".to_owned()),
    }
}

fn validate_v2_binding(
    target: Option<&str>,
    channel: Option<&str>,
) -> Result<Option<(String, String)>> {
    match (target, channel) {
        (None, None) => Ok(None),
        (Some(target), Some(channel)) => {
            Ok(Some((validate_target(target)?, validate_channel(channel)?)))
        }
        _ => Err("target and channel must be specified together for schema-v2 signing".to_owned()),
    }
}

fn safe_file_name(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "artifact file name is invalid".to_owned())?;
    if name.is_empty()
        || name.len() > 128
        || name.contains("..")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("artifact file name is unsafe".to_owned());
    }
    Ok(name.to_owned())
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
    // SAFETY: `file` owns a valid handle for the duration of the call, and `information` points to
    // initialized writable storage of the exact structure expected by GetFileInformationByHandle.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(format!("{label} could not be inspected"));
    }
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok((information.dwVolumeSerialNumber, index))
}

#[cfg(unix)]
fn file_identity(path: &Path, label: &str) -> Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).map_err(|_| format!("{label} could not be inspected"))?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_path: &Path, _label: &str) -> Result<(u8, u8)> {
    Err("file identity checks are unsupported on this platform".to_owned())
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

fn ensure_distinct_paths(artifact: &Path, signature: &Path) -> Result<()> {
    let artifact_resolved = resolved_path_with_missing_tail(artifact, "updater artifact")?;
    let signature_resolved = resolved_path_with_missing_tail(signature, "updater signature")?;
    if same_resolved_path(&artifact_resolved, &signature_resolved) {
        return Err("updater artifact and signature must be distinct files".to_owned());
    }

    match fs::metadata(signature) {
        Ok(_) => {
            if file_identity(artifact, "updater artifact")?
                == file_identity(signature, "updater signature")?
            {
                Err("updater artifact and signature must be distinct files".to_owned())
            } else {
                Ok(())
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("updater signature could not be inspected".to_owned()),
    }
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
        return Err("private key material is invalid".to_owned());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: cleartext.len() as u32,
        pbData: cleartext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` borrows `cleartext` for the call; all optional pointers are null; Windows
    // allocates `output.pbData`, which is copied before being released with LocalFree.
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
        return Err("Windows could not protect the updater key".to_owned());
    }
    // SAFETY: CryptProtectData returned `cbData` initialized bytes at `pbData`.
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: `output.pbData` was allocated by CryptProtectData and has not been freed yet.
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
        return Err("encrypted updater key is invalid".to_owned());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` borrows `ciphertext` for the call; optional pointers are null; Windows
    // allocates `output.pbData`, which is copied before being released with LocalFree.
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
        return Err("Windows could not unlock the updater key for this user".to_owned());
    }
    // SAFETY: CryptUnprotectData returned `cbData` initialized bytes at `pbData`.
    let cleartext = Zeroizing::new(
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec(),
    );
    // SAFETY: `output.pbData` was allocated by CryptUnprotectData and has not been freed yet.
    let _ = unsafe { LocalFree(output.pbData.cast()) };
    Ok(cleartext)
}

#[cfg(not(windows))]
fn protect_current_user(_cleartext: &[u8]) -> Result<Vec<u8>> {
    Err("updater key custody is available only on Windows".to_owned())
}

#[cfg(not(windows))]
fn unprotect_current_user(_ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Err("updater key custody is available only on Windows".to_owned())
}

fn public_key_base64(key: &PublicKey) -> Result<String> {
    let boxed = key
        .to_box()
        .map_err(|_| "updater public key could not be encoded".to_owned())?;
    Ok(STANDARD.encode(boxed.to_string().as_bytes()))
}

fn write_atomic_new(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        return Err(
            "updater key store already exists; rotation requires an explicit migration".to_owned(),
        );
    }
    let parent = path
        .parent()
        .ok_or_else(|| "updater key store has no parent directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|_| "updater key directory could not be created".to_owned())?;
    let temp = parent.join(format!(".{DEFAULT_STORE_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "temporary updater key store could not be created".to_owned())?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| "updater key store could not be written".to_owned())?;
        fs::rename(&temp, path).map_err(|_| "updater key store could not be committed".to_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn initialize(path: &Path) -> Result<String> {
    let KeyPair { pk, sk } = KeyPair::generate_unencrypted_keypair()
        .map_err(|_| "updater signing key generation failed".to_owned())?;
    let key_bytes = Zeroizing::new(sk.to_bytes());
    let mut payload = Zeroizing::new(Vec::with_capacity(STORE_MAGIC.len() + key_bytes.len()));
    payload.extend_from_slice(STORE_MAGIC);
    payload.extend_from_slice(&key_bytes);
    let encrypted = protect_current_user(&payload)?;
    write_atomic_new(path, &encrypted)?;
    public_key_base64(&pk)
}

fn load_secret(path: &Path) -> Result<SecretKey> {
    let mut file = regular_file(path, "updater key store", MAX_STORE_BYTES)?;
    let mut encrypted = Zeroizing::new(Vec::new());
    file.read_to_end(&mut encrypted)
        .map_err(|_| "updater key store could not be read".to_owned())?;
    let cleartext = unprotect_current_user(&encrypted)?;
    if !cleartext.starts_with(STORE_MAGIC) {
        return Err("updater key store has an unsupported format".to_owned());
    }
    SecretKey::from_bytes(&cleartext[STORE_MAGIC.len()..])
        .map_err(|_| "updater key store is corrupt".to_owned())
}

fn public_from_store(path: &Path) -> Result<(PublicKey, String)> {
    let secret = load_secret(path)?;
    let public = PublicKey::from_secret_key(&secret)
        .map_err(|_| "updater public key derivation failed".to_owned())?;
    let encoded = public_key_base64(&public)?;
    Ok((public, encoded))
}

fn trusted_comment(
    artifact: &Path,
    version: &str,
    target: Option<&str>,
    channel: Option<&str>,
) -> Result<String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is invalid".to_owned())?
        .as_secs();
    let legacy = format!(
        "timestamp:{timestamp}\tfile:{}\tversion:{}",
        safe_file_name(artifact)?,
        validate_version(version)?
    );
    match validate_v2_binding(target, channel)? {
        Some((target, channel)) => Ok(format!("{legacy}\ttarget:{target}\tchannel:{channel}")),
        None => Ok(legacy),
    }
}

fn decode_public_key(value: &str) -> Result<PublicKey> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "updater public key is invalid".to_owned())?;
    if STANDARD.encode(&bytes) != value {
        return Err("updater public key is not canonical".to_owned());
    }
    let text = String::from_utf8(bytes).map_err(|_| "updater public key is invalid".to_owned())?;
    let boxed =
        PublicKeyBox::from_string(&text).map_err(|_| "updater public key is invalid".to_owned())?;
    PublicKey::from_box(boxed).map_err(|_| "updater public key is invalid".to_owned())
}

fn decode_signature(value: &str) -> Result<SignatureBox> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "updater signature is invalid".to_owned())?;
    if STANDARD.encode(&bytes) != value {
        return Err("updater signature is not canonical".to_owned());
    }
    let text = String::from_utf8(bytes).map_err(|_| "updater signature is invalid".to_owned())?;
    SignatureBox::from_string(&text).map_err(|_| "updater signature is invalid".to_owned())
}

fn validate_trusted_comment(
    comment: &str,
    file_name: &str,
    version: &str,
    expected_target: Option<&str>,
    expected_channel: Option<&str>,
) -> Result<()> {
    let fields: Vec<_> = comment.split('\t').collect();
    let timestamps: Vec<_> = fields
        .iter()
        .filter_map(|field| field.strip_prefix("timestamp:"))
        .collect();
    let files: Vec<_> = fields
        .iter()
        .filter_map(|field| field.strip_prefix("file:"))
        .collect();
    let versions: Vec<_> = fields
        .iter()
        .filter_map(|field| field.strip_prefix("version:"))
        .collect();
    let targets: Vec<_> = fields
        .iter()
        .filter_map(|field| field.strip_prefix("target:"))
        .collect();
    let channels: Vec<_> = fields
        .iter()
        .filter_map(|field| field.strip_prefix("channel:"))
        .collect();
    let expected_binding = validate_v2_binding(expected_target, expected_channel)?;
    let expected_fields = if expected_binding.is_some() { 5 } else { 3 };
    if fields.len() != expected_fields
        || timestamps.len() != 1
        || files.len() != 1
        || versions.len() != 1
        || targets.len() != usize::from(expected_binding.is_some())
        || channels.len() != usize::from(expected_binding.is_some())
    {
        return Err("updater signature trusted comment is invalid".to_owned());
    }
    let timestamp = timestamps[0];
    if timestamp.len() < 10
        || timestamp.starts_with('0')
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("updater signature timestamp is invalid".to_owned());
    }
    if files[0] != file_name || versions[0] != version {
        return Err("updater signature does not bind the exact file and version".to_owned());
    }
    if let Some((expected_target, expected_channel)) = expected_binding {
        let signed_target = validate_target(targets[0])?;
        let signed_channel = validate_channel(channels[0])?;
        if fields[0] != format!("timestamp:{timestamp}")
            || fields[1] != format!("file:{file_name}")
            || fields[2] != format!("version:{version}")
            || fields[3] != format!("target:{expected_target}")
            || fields[4] != format!("channel:{expected_channel}")
            || signed_target != expected_target
            || signed_channel != expected_channel
        {
            return Err("updater signature does not bind the exact target and channel".to_owned());
        }
    }
    Ok(())
}

fn verify_signature(
    artifact: &Path,
    signature_path: &Path,
    public_key_base64: &str,
    version: &str,
    target: Option<&str>,
    channel: Option<&str>,
) -> Result<()> {
    let binding = validate_v2_binding(target, channel)?;
    let version = validate_version(version)?;
    let file_name = safe_file_name(artifact)?;
    ensure_distinct_paths(artifact, signature_path)?;
    let mut artifact_file = regular_file(artifact, "updater artifact", MAX_ARTIFACT_BYTES)?;
    let mut signature_file =
        regular_file(signature_path, "updater signature", MAX_SIGNATURE_BYTES)?;
    let mut signature_text = String::new();
    signature_file
        .read_to_string(&mut signature_text)
        .map_err(|_| "updater signature could not be read".to_owned())?;
    let signature_text = signature_text.trim_end_matches(['\r', '\n']);
    let signature = decode_signature(signature_text)?;
    let trusted_comment = signature
        .trusted_comment()
        .map_err(|_| "updater signature has no trusted comment".to_owned())?;
    validate_trusted_comment(
        &trusted_comment,
        &file_name,
        &version,
        binding.as_ref().map(|(target, _)| target.as_str()),
        binding.as_ref().map(|(_, channel)| channel.as_str()),
    )?;
    let public = decode_public_key(public_key_base64)?;
    minisign::verify(&public, &signature, &mut artifact_file, true, false, false)
        .map_err(|_| "updater signature verification failed".to_owned())
}

fn write_atomic_replace(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| "updater signature has no parent directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|_| "updater signature directory could not be created".to_owned())?;
    let temp = parent.join(format!(".updater-signature.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "temporary updater signature could not be created".to_owned())?;
        file.write_all(contents)
            .and_then(|()| file.sync_all())
            .map_err(|_| "updater signature could not be written".to_owned())?;
        if path.exists() {
            fs::remove_file(path)
                .map_err(|_| "old updater signature could not be replaced".to_owned())?;
        }
        fs::rename(&temp, path).map_err(|_| "updater signature could not be committed".to_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn sign_artifact(
    store: &Path,
    artifact: &Path,
    signature_path: &Path,
    version: &str,
    target: Option<&str>,
    channel: Option<&str>,
) -> Result<String> {
    let binding = validate_v2_binding(target, channel)?;
    validate_version(version)?;
    safe_file_name(artifact)?;
    ensure_distinct_paths(artifact, signature_path)?;
    let secret = load_secret(store)?;
    let public = PublicKey::from_secret_key(&secret)
        .map_err(|_| "updater public key derivation failed".to_owned())?;
    let mut artifact_file = regular_file(artifact, "updater artifact", MAX_ARTIFACT_BYTES)?;
    let comment = trusted_comment(
        artifact,
        version,
        binding.as_ref().map(|(target, _)| target.as_str()),
        binding.as_ref().map(|(_, channel)| channel.as_str()),
    )?;
    let signature = minisign::sign(
        Some(&public),
        &secret,
        &mut artifact_file,
        Some(&comment),
        Some("signature from KalCode updater key"),
    )
    .map_err(|_| "updater artifact signing failed".to_owned())?;
    artifact_file
        .seek(SeekFrom::Start(0))
        .map_err(|_| "updater artifact could not be verified".to_owned())?;
    minisign::verify(&public, &signature, &mut artifact_file, true, false, false)
        .map_err(|_| "new updater signature failed verification".to_owned())?;
    let encoded = STANDARD.encode(signature.to_string().as_bytes());
    write_atomic_replace(signature_path, format!("{encoded}\n").as_bytes())?;
    verify_signature(
        artifact,
        signature_path,
        &public_key_base64(&public)?,
        version,
        binding.as_ref().map(|(target, _)| target.as_str()),
        binding.as_ref().map(|(_, channel)| channel.as_str()),
    )?;
    public_key_base64(&public)
}

fn run(args: &[String]) -> Result<()> {
    let command = args.first().ok_or_else(|| usage().to_owned())?;
    match command.as_str() {
        "init" => {
            let tail = &args[1..];
            ensure_options(tail, &["--store"])?;
            let store = store_path(tail)?;
            let public = initialize(&store)?;
            println!("{public}");
            Ok(())
        }
        "public-key" => {
            let tail = &args[1..];
            ensure_options(tail, &["--store"])?;
            let store = store_path(tail)?;
            let (_, public) = public_from_store(&store)?;
            println!("{public}");
            Ok(())
        }
        "sign" => {
            let tail = &args[1..];
            ensure_options(
                tail,
                &[
                    "--store",
                    "--artifact",
                    "--signature",
                    "--version",
                    "--target",
                    "--channel",
                ],
            )?;
            let store = store_path(tail)?;
            let artifact = PathBuf::from(option(tail, "--artifact")?);
            let signature = PathBuf::from(option(tail, "--signature")?);
            let version = option(tail, "--version")?;
            let target = optional_option(tail, "--target")?;
            let channel = optional_option(tail, "--channel")?;
            let _ = sign_artifact(
                &store,
                &artifact,
                &signature,
                &version,
                target.as_deref(),
                channel.as_deref(),
            )?;
            println!("updater signature created and verified");
            Ok(())
        }
        "verify" => {
            let tail = &args[1..];
            ensure_options(
                tail,
                &[
                    "--artifact",
                    "--signature",
                    "--version",
                    "--public-key",
                    "--target",
                    "--channel",
                ],
            )?;
            let artifact = PathBuf::from(option(tail, "--artifact")?);
            let signature = PathBuf::from(option(tail, "--signature")?);
            let version = option(tail, "--version")?;
            let public_key = option(tail, "--public-key")?;
            let target = optional_option(tail, "--target")?;
            let channel = optional_option(tail, "--channel")?;
            verify_signature(
                &artifact,
                &signature,
                &public_key,
                &version,
                target.as_deref(),
                channel.as_deref(),
            )?;
            println!("updater signature verified");
            Ok(())
        }
        _ => Err(usage().to_owned()),
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if let Err(error) = run(&args) {
        eprintln!("updater signer: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_canonical() {
        assert_eq!(validate_version("1.2.3").as_deref(), Ok("1.2.3"));
        assert_eq!(
            validate_version("1.2.3-beta.1").as_deref(),
            Ok("1.2.3-beta.1")
        );
        assert!(validate_version("v1.2.3").is_err());
        assert!(validate_version("1.2").is_err());
    }

    #[test]
    fn artifact_names_are_bounded() {
        assert_eq!(
            safe_file_name(Path::new("KalCode_1.2.3_x64-setup.exe")).as_deref(),
            Ok("KalCode_1.2.3_x64-setup.exe")
        );
        assert!(safe_file_name(Path::new("bad..exe")).is_err());
        assert!(safe_file_name(Path::new("bad name.exe")).is_err());
    }

    #[test]
    fn trusted_comments_require_a_numeric_timestamp_and_exact_artifact_identity() {
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.3_x64-setup.exe\tversion:1.2.3",
                "KalCode_1.2.3_x64-setup.exe",
                "1.2.3",
                None,
                None,
            )
            .is_ok()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:not-a-time\tfile:KalCode_1.2.3_x64-setup.exe\tversion:1.2.3",
                "KalCode_1.2.3_x64-setup.exe",
                "1.2.3",
                None,
                None,
            )
            .is_err()
        );
        // V1 compatibility: the legacy verifier historically accepted the three exact fields in
        // any order, so target hardening must not silently narrow that contract.
        assert!(
            validate_trusted_comment(
                "version:1.2.3\ttimestamp:1758792000\tfile:KalCode_1.2.3_x64-setup.exe",
                "KalCode_1.2.3_x64-setup.exe",
                "1.2.3",
                None,
                None,
            )
            .is_ok()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.4_x64-setup.exe\tversion:1.2.3",
                "KalCode_1.2.3_x64-setup.exe",
                "1.2.3",
                None,
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn schema_v2_target_and_channel_are_closed_and_cryptographically_unambiguous() {
        assert_eq!(
            validate_target(TARGET_WINDOWS_X86_64).as_deref(),
            Ok(TARGET_WINDOWS_X86_64)
        );
        assert_eq!(
            validate_target(TARGET_DARWIN_AARCH64).as_deref(),
            Ok(TARGET_DARWIN_AARCH64)
        );
        for invalid in [
            "",
            "macos-arm64",
            "darwin-x86_64",
            "DARWIN-AARCH64",
            "darwin-aarch64\ttarget:windows-x86_64",
        ] {
            assert!(validate_target(invalid).is_err());
        }
        for channel in ["stable", "beta", "dev"] {
            assert_eq!(validate_channel(channel).as_deref(), Ok(channel));
        }
        for invalid in ["", "nightly", "Stable", "stable\tchannel:dev"] {
            assert!(validate_channel(invalid).is_err());
        }

        let file = "KalCode_1.2.3_arm64.dmg";
        let version = "1.2.3";
        let valid = "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:darwin-aarch64\tchannel:stable";
        assert!(
            validate_trusted_comment(
                valid,
                file,
                version,
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_ok()
        );
        assert!(validate_trusted_comment(valid, file, version, None, None).is_err());
        assert!(
            validate_trusted_comment(
                valid,
                file,
                version,
                Some(TARGET_WINDOWS_X86_64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3",
                file,
                version,
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:darwin-aarch64\ttarget:windows-x86_64\tchannel:stable",
                file,
                version,
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:macos-arm64\tchannel:stable",
                file,
                version,
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\ttarget:darwin-aarch64\tversion:1.2.3\tchannel:stable",
                file,
                version,
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        assert!(
            validate_trusted_comment(
                "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:darwin-aarch64\tchannel:beta",
                file,
                version,
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        for invalid in [
            "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:darwin-aarch64",
            "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:darwin-aarch64\tchannel:stable\tchannel:beta",
            "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\ttarget:darwin-aarch64\tchannel:nightly",
            "timestamp:1758792000\tfile:KalCode_1.2.3_arm64.dmg\tversion:1.2.3\tchannel:stable\ttarget:darwin-aarch64",
        ] {
            assert!(
                validate_trusted_comment(
                    invalid,
                    file,
                    version,
                    Some(TARGET_DARWIN_AARCH64),
                    Some(CHANNEL_STABLE),
                )
                .is_err()
            );
        }
        assert!(validate_v2_binding(Some(TARGET_DARWIN_AARCH64), None).is_err());
        assert!(validate_v2_binding(None, Some(CHANNEL_STABLE)).is_err());
    }

    #[test]
    fn artifact_and_signature_aliases_are_rejected_before_artifact_mutation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let artifact = temp.path().join("KalCode_1.2.3_arm64.dmg");
        let absent_store = temp.path().join("absent.dpapi");
        let original = b"disposable updater artifact";
        fs::write(&artifact, original).expect("artifact");
        let current = fs::canonicalize(".").expect("current directory");
        let canonical_artifact = fs::canonicalize(&artifact).expect("canonical artifact");
        let current_components: Vec<_> = current.components().collect();
        let artifact_components: Vec<_> = canonical_artifact.components().collect();
        let shared = current_components
            .iter()
            .zip(&artifact_components)
            .take_while(|(left, right)| left == right)
            .count();
        assert!(
            shared > 0,
            "temporary artifact must share a filesystem root"
        );
        let mut relative_alias = PathBuf::new();
        for _ in shared..current_components.len() {
            relative_alias.push("..");
        }
        for component in &artifact_components[shared..] {
            relative_alias.push(component.as_os_str());
        }

        for alias in [
            artifact.clone(),
            temp.path().join(".").join("KalCode_1.2.3_arm64.dmg"),
            relative_alias,
        ] {
            let error = sign_artifact(&absent_store, &artifact, &alias, "1.2.3", None, None)
                .expect_err("alias must fail before key access");
            assert!(error.contains("distinct"), "unexpected error: {error}");
            assert_eq!(fs::read(&artifact).expect("artifact bytes"), original);
        }

        let hard_link = temp.path().join("hard-link.sig");
        fs::hard_link(&artifact, &hard_link).expect("hard link");
        let error = sign_artifact(&absent_store, &artifact, &hard_link, "1.2.3", None, None)
            .expect_err("hard-link alias must fail before key access");
        assert!(error.contains("distinct"), "unexpected error: {error}");
        assert_eq!(fs::read(&artifact).expect("artifact bytes"), original);

        let symlink_parent = temp.path().join("alias-parent");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(temp.path(), &symlink_parent).expect("directory symlink");
        #[cfg(unix)]
        std::os::unix::fs::symlink(temp.path(), &symlink_parent).expect("directory symlink");
        let symlink_alias = symlink_parent.join("KalCode_1.2.3_arm64.dmg");
        let error = sign_artifact(
            &absent_store,
            &artifact,
            &symlink_alias,
            "1.2.3",
            None,
            None,
        )
        .expect_err("symlink-parent alias must fail before key access");
        assert!(error.contains("distinct"), "unexpected error: {error}");
        assert_eq!(fs::read(&artifact).expect("artifact bytes"), original);
    }

    #[test]
    fn command_options_are_closed() {
        assert!(ensure_options(&["--store".into(), "test.dpapi".into()], &["--store"]).is_ok());
        assert!(ensure_options(&["--unknown".into(), "value".into()], &["--store"]).is_err());
        assert!(ensure_options(&["--store".into()], &["--store"]).is_err());
        assert!(ensure_options(&["--store".into(), "--artifact".into()], &["--store"]).is_err());
        assert!(
            optional_option(
                &[
                    "--target".into(),
                    TARGET_DARWIN_AARCH64.into(),
                    "--target".into(),
                    TARGET_WINDOWS_X86_64.into(),
                ],
                "--target",
            )
            .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_is_current_user_scoped() {
        let cleartext = Zeroizing::new(b"disposable test material".to_vec());
        let encrypted = protect_current_user(&cleartext).expect("protect");
        assert_ne!(encrypted, cleartext.as_slice());
        assert_eq!(
            &*unprotect_current_user(&encrypted).expect("unprotect"),
            &*cleartext
        );
    }

    #[cfg(windows)]
    #[test]
    fn disposable_store_signs_and_verifies_exact_bytes_and_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = temp.path().join("test.dpapi");
        let artifact = temp.path().join("KalCode_1.2.3_x64-setup.exe");
        let signature = temp.path().join("KalCode_1.2.3_x64-setup.exe.sig");
        fs::write(&artifact, b"disposable updater artifact").expect("artifact");
        let public = initialize(&store).expect("initialize");
        assert_eq!(
            sign_artifact(&store, &artifact, &signature, "1.2.3", None, None).expect("sign"),
            public
        );
        verify_signature(&artifact, &signature, &public, "1.2.3", None, None).expect("verify");
        assert!(verify_signature(&artifact, &signature, &public, "1.2.4", None, None).is_err());

        sign_artifact(
            &store,
            &artifact,
            &signature,
            "1.2.3",
            Some(TARGET_DARWIN_AARCH64),
            Some(CHANNEL_STABLE),
        )
        .expect("sign targeted");
        verify_signature(
            &artifact,
            &signature,
            &public,
            "1.2.3",
            Some(TARGET_DARWIN_AARCH64),
            Some(CHANNEL_STABLE),
        )
        .expect("verify targeted");
        assert!(
            verify_signature(
                &artifact,
                &signature,
                &public,
                "1.2.3",
                Some(TARGET_WINDOWS_X86_64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
        assert!(verify_signature(&artifact, &signature, &public, "1.2.3", None, None).is_err());

        let encoded = fs::read_to_string(&signature).expect("read signature");
        let signed_document = String::from_utf8(
            STANDARD
                .decode(encoded.trim_end())
                .expect("decode signature document"),
        )
        .expect("signature document utf8");
        let forged_document =
            signed_document.replace("target:darwin-aarch64", "target:windows-x86_64");
        assert_ne!(forged_document, signed_document);
        fs::write(&signature, STANDARD.encode(forged_document)).expect("write forged target");
        assert!(
            verify_signature(
                &artifact,
                &signature,
                &public,
                "1.2.3",
                Some(TARGET_WINDOWS_X86_64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );

        sign_artifact(
            &store,
            &artifact,
            &signature,
            "1.2.3",
            Some(TARGET_DARWIN_AARCH64),
            Some(CHANNEL_STABLE),
        )
        .expect("restore targeted signature");
        let encoded = fs::read_to_string(&signature).expect("read restored signature");
        let signed_document = String::from_utf8(
            STANDARD
                .decode(encoded.trim_end())
                .expect("decode restored signature document"),
        )
        .expect("restored signature document utf8");
        let forged_document = signed_document.replace("channel:stable", "channel:beta");
        assert_ne!(forged_document, signed_document);
        fs::write(&signature, STANDARD.encode(forged_document)).expect("write forged channel");
        assert!(
            verify_signature(
                &artifact,
                &signature,
                &public,
                "1.2.3",
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_BETA),
            )
            .is_err()
        );

        sign_artifact(
            &store,
            &artifact,
            &signature,
            "1.2.3",
            Some(TARGET_DARWIN_AARCH64),
            Some(CHANNEL_STABLE),
        )
        .expect("restore signature after channel forgery");
        fs::write(&artifact, b"tampered updater artifact").expect("tamper");
        assert!(
            verify_signature(
                &artifact,
                &signature,
                &public,
                "1.2.3",
                Some(TARGET_DARWIN_AARCH64),
                Some(CHANNEL_STABLE),
            )
            .is_err()
        );
    }
}
