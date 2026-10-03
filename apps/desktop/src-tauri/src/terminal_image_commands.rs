//! Bounded, private image admission for Code terminals.
//!
//! The WebView supplies only PNG bytes and an exact live target identity. Native code validates
//! and normalizes the PNG, stores it under KalCode's private app-data tree, and returns one quoted
//! local path for the existing terminal input lane. Import never writes to a PTY or submits input.

use std::fs::{File, OpenOptions};
use std::io::{Cursor, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use kalcode_core::protected_file::{is_link_or_reparse, open_ordinary_file_without_following};
use kalcode_core::workspaces::{TerminalSessionIdentity, validate_id};
use kalcode_core::{ErrorCategory, IpcError, KalError, Result};
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};

use crate::AppState;
use crate::provider_pane_commands::ProviderPanesState;

const MAIN_WEBVIEW: &str = "main";
const MAX_PNG_BYTES: usize = 8 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = 4 * MAX_PNG_BYTES.div_ceil(3);
const MAX_SIDE: u32 = 16_384;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_DECODED_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILES_PER_TARGET: usize = 64;
const MAX_STORED_BYTES_PER_TARGET: u64 = 128 * 1024 * 1024;

// Quota admission and create/rename are one operation. Imports are infrequent and already run on
// Tauri's blocking pool, so one process-local lock is both cheaper and safer than a lock-file
// protocol that could itself be replaced in the app-data tree.
static IMPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TerminalImageTarget {
    #[serde(rename = "agent")]
    Agent {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
    },
    #[serde(rename = "terminal")]
    Terminal {
        #[serde(rename = "terminalId")]
        terminal_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTerminalImage {
    pub image_id: String,
    pub path: String,
    pub insertion: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TargetSnapshot {
    Agent {
        thread_id: String,
        instance_id: String,
        provider_id: String,
    },
    Terminal {
        terminal_id: String,
        identity: TerminalSessionIdentity,
        shell_id: String,
    },
}

impl TargetSnapshot {
    fn storage_components(&self) -> [&str; 3] {
        match self {
            Self::Agent { thread_id, .. } => ["sessions", thread_id, "images"],
            Self::Terminal { terminal_id, .. } => ["terminal-images", "terminals", terminal_id],
        }
    }

    fn insertion(&self, path: &str) -> Result<String> {
        if path.chars().any(char::is_control) {
            return Err(path_unrepresentable());
        }
        match self {
            // Current Codex, Claude Code and Gemini CLIs all recognize one double-quoted absolute
            // image path pasted into their composer. A literal quote cannot be represented in the
            // shared provider grammar without changing the path, so fail rather than corrupt it.
            Self::Agent { .. } => double_quoted_path(path),
            Self::Terminal { shell_id, .. } => quote_for_shell(shell_id, path),
        }
    }

    fn terminal_generation(&self) -> Option<u64> {
        match self {
            Self::Agent { .. } => None,
            Self::Terminal { identity, .. } => Some(identity.generation),
        }
    }
}

/// Imports a user-selected image for one exact live Code target.
///
/// The result is text only. The frontend pastes `insertion` through the target's existing ordered
/// input queue and deliberately does not append Enter.
#[tauri::command(async)]
pub async fn terminal_image_import(
    runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, AppState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    target: TerminalImageTarget,
    png_base64: String,
) -> std::result::Result<ImportedTerminalImage, IpcError> {
    runtime_access.revalidate()?;
    panes.revalidate()?;
    require_main_window(&window)?;

    if png_base64.is_empty() || png_base64.len() > MAX_BASE64_BYTES {
        return Err(image_too_large().to_ipc());
    }

    let core = state.core()?.clone();
    let expected = capture_target(&target, &core, &panes)?;
    let data_dir = state.paths.data_dir.clone();
    let storage_target = expected.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_png_base64(&png_base64)?;
        let normalized = normalize_png(&bytes)?;
        store_png(&data_dir, &storage_target, &normalized)
    })
    .await
    .map_err(|error| {
        KalError::internal(
            "terminal_image_import_interrupted",
            "The image import was interrupted. Try again.",
        )
        .with_source(error)
        .log_and_convert("terminal_image_import")
    })?
    .map_err(|error| error.log_and_convert("terminal_image_import"))?;

    let admitted = (|| {
        runtime_access.revalidate()?;
        panes.revalidate()?;
        require_main_window(&window)?;
        let current = capture_target(&target, &core, &panes);
        if !current.is_ok_and(|current| current == expected) {
            return Err(target_changed().to_ipc());
        }
        let path_text = terminal_path_text(&path).map_err(|error| error.to_ipc())?;
        let insertion = expected
            .insertion(&path_text)
            .map_err(|error| error.to_ipc())?;
        let image_id = image_id_from_path(&path).map_err(|error| error.to_ipc())?;
        Ok(ImportedTerminalImage {
            image_id,
            path: path_text,
            insertion,
            terminal_generation: expected.terminal_generation(),
        })
    })();
    if admitted.is_err() {
        remove_imported_file(&path);
    }
    admitted
}

/// Discards one imported image when its insertion never reached the target input lane.
///
/// The caller supplies only generated identities, never a path. Cleanup deliberately does not
/// require a live target because the target may have closed between import and delivery.
#[tauri::command(async)]
pub async fn terminal_image_discard(
    runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, AppState>,
    target: TerminalImageTarget,
    image_id: String,
) -> std::result::Result<bool, IpcError> {
    runtime_access.revalidate()?;
    require_main_window(&window)?;
    let data_dir = state.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        discard_imported_image(&data_dir, &target, &image_id)
    })
    .await
    .map_err(|error| {
        KalError::internal(
            "terminal_image_discard_interrupted",
            "The unused image could not be cleaned up.",
        )
        .with_source(error)
        .log_and_convert("terminal_image_discard")
    })?
    .map_err(|error| error.log_and_convert("terminal_image_discard"))
}

fn require_main_window(window: &WebviewWindow) -> std::result::Result<(), IpcError> {
    if window.label() == MAIN_WEBVIEW {
        Ok(())
    } else {
        Err(KalError::new(
            ErrorCategory::Permission,
            "terminal_image_owner_invalid",
            "Terminal images are available only in the main KalCode window.",
        )
        .to_ipc())
    }
}

fn capture_target(
    target: &TerminalImageTarget,
    core: &kalcode_core::Core,
    panes: &ProviderPanesState,
) -> std::result::Result<TargetSnapshot, IpcError> {
    match target {
        TerminalImageTarget::Agent {
            thread_id,
            instance_id,
        } => {
            validate_id(thread_id).map_err(|error| error.to_ipc())?;
            if !kalcode_contracts::ids::is_valid_id(instance_id) {
                return Err(target_changed().to_ipc());
            }
            let info = panes
                .handoff_info(thread_id)
                .filter(|info| info.running)
                .ok_or_else(|| target_changed().to_ipc())?;
            if info.instance_id.as_deref() != Some(instance_id) {
                return Err(target_changed().to_ipc());
            }
            if !matches!(
                info.provider_id.as_str(),
                "claude-code" | "codex" | "gemini-cli"
            ) {
                return Err(KalError::validation(
                    "terminal_image_provider_unsupported",
                    "This coding provider does not support image-path input in KalCode.",
                )
                .to_ipc());
            }
            Ok(TargetSnapshot::Agent {
                thread_id: thread_id.clone(),
                instance_id: instance_id.clone(),
                provider_id: info.provider_id,
            })
        }
        TerminalImageTarget::Terminal { terminal_id } => {
            validate_id(terminal_id).map_err(|error| error.to_ipc())?;
            let identity = core
                .terminal_session_identity(terminal_id)
                .ok_or_else(|| target_changed().to_ipc())?;
            let terminal = core
                .terminal(terminal_id)
                .map_err(|error| error.log_and_convert("terminal_image_target"))?;
            Ok(TargetSnapshot::Terminal {
                terminal_id: terminal_id.clone(),
                identity,
                shell_id: terminal.shell_id,
            })
        }
    }
}

fn decode_png_base64(encoded: &str) -> Result<Vec<u8>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid_image())?;
    if bytes.is_empty() || bytes.len() > MAX_PNG_BYTES {
        return Err(image_too_large());
    }
    Ok(bytes)
}

/// Fully decodes one still PNG and re-encodes only its pixels. This verifies CRCs/chunks while
/// stripping text, EXIF, ICC and other metadata before the image enters managed storage.
fn normalize_png(bytes: &[u8]) -> Result<Vec<u8>> {
    let (early_width, early_height) =
        kalcode_context::content::png_dimensions(bytes).ok_or_else(invalid_image)?;
    validate_dimensions(early_width, early_height)?;

    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: MAX_DECODED_BYTES,
    });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| invalid_image())?;
    let info = reader.info();
    validate_dimensions(info.width, info.height)?;
    if info.width != early_width || info.height != early_height || info.animation_control.is_some()
    {
        return Err(invalid_image());
    }
    let buffer_size = reader.output_buffer_size().ok_or_else(invalid_image)?;
    if buffer_size == 0 || buffer_size > MAX_DECODED_BYTES {
        return Err(image_too_large());
    }
    let mut pixels = vec![0; buffer_size];
    let frame = reader
        .next_frame(&mut pixels)
        .map_err(|_| invalid_image())?;
    if frame.width != early_width || frame.height != early_height {
        return Err(invalid_image());
    }
    reader.finish().map_err(|_| invalid_image())?;

    let mut output = CappedWriter::new(MAX_PNG_BYTES);
    {
        let mut encoder = png::Encoder::new(&mut output, frame.width, frame.height);
        encoder.set_color(frame.color_type);
        encoder.set_depth(frame.bit_depth);
        let mut writer = encoder.write_header().map_err(|_| invalid_image())?;
        writer
            .write_image_data(&pixels[..frame.buffer_size()])
            .map_err(|_| image_too_large())?;
        writer.finish().map_err(|_| image_too_large())?;
    }
    Ok(output.into_inner())
}

fn validate_dimensions(width: u32, height: u32) -> Result<()> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(image_too_large)?;
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE || pixels > MAX_PIXELS {
        Err(image_too_large())
    } else {
        Ok(())
    }
}

struct CappedWriter {
    bytes: Vec<u8>,
    cap: usize,
}

impl CappedWriter {
    fn new(cap: usize) -> Self {
        Self {
            bytes: Vec::new(),
            cap,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }
}

impl std::io::Write for CappedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if buf.len() > self.cap.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "normalized PNG exceeds its managed-storage cap",
            ));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn store_png(data_dir: &Path, target: &TargetSnapshot, png: &[u8]) -> Result<PathBuf> {
    let _guard = IMPORT_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let directory = private_directory(data_dir, target.storage_components())?;
    check_quota(&directory, png.len())?;

    let id = kalcode_contracts::ids::new_id();
    let final_path = directory.join(format!("{id}.png"));
    let temp_path = directory.join(format!(".{id}.png.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(storage_error)?;
        set_private_file_permissions(&file)?;
        file.write_all(png)
            .and_then(|()| file.sync_all())
            .map_err(storage_error)?;
        drop(file);
        if std::fs::symlink_metadata(&final_path).is_ok() {
            return Err(storage_unsafe());
        }
        std::fs::rename(&temp_path, &final_path).map_err(storage_error)?;
        verify_stored_file(data_dir, &final_path, png.len())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
        let _ = std::fs::remove_file(&final_path);
    }
    result
}

fn image_id_from_path(path: &Path) -> Result<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| kalcode_contracts::ids::is_valid_id(value))
        .map(str::to_owned)
        .ok_or_else(storage_unsafe)
}

fn discard_imported_image(
    data_dir: &Path,
    target: &TerminalImageTarget,
    image_id: &str,
) -> Result<bool> {
    validate_id(image_id)?;
    let components = match target {
        TerminalImageTarget::Agent {
            thread_id,
            instance_id,
        } => {
            validate_id(thread_id)?;
            validate_id(instance_id)?;
            ["sessions", thread_id.as_str(), "images"]
        }
        TerminalImageTarget::Terminal { terminal_id } => {
            validate_id(terminal_id)?;
            ["terminal-images", "terminals", terminal_id.as_str()]
        }
    };

    let _guard = IMPORT_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(directory) = existing_private_directory(data_dir, components)? else {
        return Ok(false);
    };
    let path = directory.join(format!("{image_id}.png"));
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(storage_error(error)),
    };
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || std::fs::canonicalize(&path).map_err(storage_error)? != path
        || open_ordinary_file_without_following(&path).is_none()
    {
        return Err(storage_unsafe());
    }
    std::fs::remove_file(&path).map_err(storage_error)?;
    remove_empty_directory(&directory)?;
    Ok(true)
}

/// Removes only KalCode-generated images for a generic terminal after its terminal row and PTY
/// are permanently closed. Agent images deliberately use a different durable directory because
/// coding-agent threads can resume after stopping or archiving.
pub(crate) fn remove_terminal_images(data_dir: &Path, terminal_id: &str) -> Result<()> {
    validate_id(terminal_id)?;
    let _guard = IMPORT_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(directory) =
        existing_private_directory(data_dir, ["terminal-images", "terminals", terminal_id])?
    else {
        return Ok(());
    };

    for entry in std::fs::read_dir(&directory).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| storage_unsafe())?;
        if !is_generated_image_name(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(storage_error)?;
        if !metadata.is_file()
            || is_link_or_reparse(&metadata)
            || std::fs::canonicalize(&path).map_err(storage_error)? != path
            || open_ordinary_file_without_following(&path).is_none()
        {
            return Err(storage_unsafe());
        }
        std::fs::remove_file(&path).map_err(storage_error)?;
    }

    remove_empty_directory(&directory)
}

fn remove_empty_directory(directory: &Path) -> Result<()> {
    match std::fs::remove_dir(directory) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(storage_error(error)),
    }
}

fn private_directory<const N: usize>(data_dir: &Path, components: [&str; N]) -> Result<PathBuf> {
    let data = std::fs::canonicalize(data_dir).map_err(storage_error)?;
    let root_meta = std::fs::symlink_metadata(data_dir).map_err(storage_error)?;
    if !root_meta.is_dir() || is_link_or_reparse(&root_meta) {
        return Err(storage_unsafe());
    }
    let mut directory = data_dir.to_path_buf();
    for component in components {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.contains(['/', '\\'])
        {
            return Err(storage_unsafe());
        }
        directory.push(component);
        match std::fs::create_dir(&directory) {
            Ok(()) => set_private_directory_permissions(&directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(storage_error(error)),
        }
        let metadata = std::fs::symlink_metadata(&directory).map_err(storage_error)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(storage_unsafe());
        }
    }
    let canonical = std::fs::canonicalize(&directory).map_err(storage_error)?;
    if !canonical.starts_with(&data) {
        return Err(storage_unsafe());
    }
    Ok(canonical)
}

fn existing_private_directory<const N: usize>(
    data_dir: &Path,
    components: [&str; N],
) -> Result<Option<PathBuf>> {
    let data = std::fs::canonicalize(data_dir).map_err(storage_error)?;
    let root_meta = std::fs::symlink_metadata(data_dir).map_err(storage_error)?;
    if !root_meta.is_dir() || is_link_or_reparse(&root_meta) {
        return Err(storage_unsafe());
    }
    let mut directory = data_dir.to_path_buf();
    for component in components {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.contains(['/', '\\'])
        {
            return Err(storage_unsafe());
        }
        directory.push(component);
        let metadata = match std::fs::symlink_metadata(&directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(storage_error(error)),
        };
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(storage_unsafe());
        }
    }
    let canonical = std::fs::canonicalize(&directory).map_err(storage_error)?;
    if !canonical.starts_with(data) {
        return Err(storage_unsafe());
    }
    Ok(Some(canonical))
}

fn is_generated_image_name(name: &str) -> bool {
    name.strip_suffix(".png")
        .is_some_and(kalcode_contracts::ids::is_valid_id)
        || name
            .strip_prefix('.')
            .and_then(|name| name.strip_suffix(".png.tmp"))
            .is_some_and(kalcode_contracts::ids::is_valid_id)
}

fn check_quota(directory: &Path, additional: usize) -> Result<()> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    for entry in std::fs::read_dir(directory).map_err(storage_error)? {
        let entry = entry.map_err(storage_error)?;
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(storage_error)?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) {
            return Err(storage_unsafe());
        }
        files = files.saturating_add(1);
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or_else(storage_unsafe)?;
    }
    let additional = u64::try_from(additional).map_err(|_| image_too_large())?;
    if files >= MAX_FILES_PER_TARGET
        || bytes
            .checked_add(additional)
            .is_none_or(|total| total > MAX_STORED_BYTES_PER_TARGET)
    {
        return Err(KalError::validation(
            "terminal_image_storage_full",
            "This terminal has reached its image limit. Start a new terminal to attach more images.",
        ));
    }
    Ok(())
}

fn verify_stored_file(data_dir: &Path, path: &Path, expected_len: usize) -> Result<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).map_err(storage_error)?;
    if !metadata.is_file()
        || is_link_or_reparse(&metadata)
        || metadata.len() != u64::try_from(expected_len).map_err(|_| image_too_large())?
    {
        return Err(storage_unsafe());
    }
    let canonical = std::fs::canonicalize(path).map_err(storage_error)?;
    let data = std::fs::canonicalize(data_dir).map_err(storage_error)?;
    if canonical != path || !canonical.starts_with(data) {
        return Err(storage_unsafe());
    }
    Ok(canonical)
}

fn remove_imported_file(path: &Path) {
    if std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !is_link_or_reparse(&metadata))
    {
        let _ = std::fs::remove_file(path);
    }
}

fn terminal_path_text(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or_else(path_unrepresentable)?;
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return Ok(rest.to_owned());
        }
    }
    Ok(value.to_owned())
}

fn double_quoted_path(path: &str) -> Result<String> {
    if path.contains('"') {
        return Err(path_unrepresentable());
    }
    Ok(format!("\"{path}\""))
}

fn quote_for_shell(shell_id: &str, path: &str) -> Result<String> {
    let shell_id = shell_id.strip_prefix("operation:").unwrap_or(shell_id);
    match shell_id {
        "pwsh" | "powershell" => Ok(format!("'{}'", path.replace('\'', "''"))),
        "cmd" => double_quoted_path(path),
        "git-bash" | "zsh" | "bash" | "fish" | "sh" => {
            Ok(format!("'{}'", path.replace('\'', "'\\''")))
        }
        _ => Err(KalError::validation(
            "terminal_image_shell_unsupported",
            "KalCode cannot safely quote an image path for this terminal shell.",
        )),
    }
}

fn invalid_image() -> KalError {
    KalError::validation(
        "terminal_image_invalid",
        "Choose a valid PNG image and try again.",
    )
}

fn image_too_large() -> KalError {
    KalError::validation(
        "terminal_image_too_large",
        "Choose a PNG under 8 MB and 16 megapixels.",
    )
}

fn target_changed() -> KalError {
    KalError::validation(
        "terminal_image_target_changed",
        "That terminal restarted or closed before the image was ready. Try again in the active terminal.",
    )
}

fn path_unrepresentable() -> KalError {
    KalError::validation(
        "terminal_image_path_unsupported",
        "KalCode cannot safely insert its managed image path in this terminal.",
    )
}

fn storage_unsafe() -> KalError {
    KalError::internal(
        "terminal_image_storage_unsafe",
        "KalCode could not verify its private image storage.",
    )
}

fn storage_error(error: std::io::Error) -> KalError {
    KalError::internal(
        "terminal_image_storage_failed",
        "KalCode could not store that image privately.",
    )
    .with_source(error)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(storage_error)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(file: &File) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(storage_error)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_file: &File) -> Result<()> {
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn png_with_metadata(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .add_text_chunk("Comment".into(), "owner-private-metadata".into())
                .expect("text metadata");
            let mut writer = encoder.write_header().expect("header");
            let pixels = vec![0x7f; width as usize * height as usize * 4];
            writer.write_image_data(&pixels).expect("pixels");
        }
        bytes
    }

    fn agent_target(id: &str) -> TargetSnapshot {
        TargetSnapshot::Agent {
            thread_id: id.to_owned(),
            instance_id: kalcode_contracts::ids::new_id(),
            provider_id: "codex".into(),
        }
    }

    #[test]
    fn normalization_decodes_pixels_and_strips_metadata() {
        let input = png_with_metadata(2, 2);
        assert!(
            input
                .windows(22)
                .any(|part| part == b"owner-private-metadata")
        );
        let normalized = normalize_png(&input).expect("normalized");
        assert!(
            !normalized
                .windows(22)
                .any(|part| part == b"owner-private-metadata")
        );

        let mut reader = png::Decoder::new(Cursor::new(&normalized))
            .read_info()
            .expect("decode normalized");
        assert_eq!(reader.info().size(), (2, 2));
        let mut pixels = vec![0; reader.output_buffer_size().expect("size")];
        reader.next_frame(&mut pixels).expect("frame");
        reader.finish().expect("complete PNG");
    }

    #[test]
    fn malformed_and_oversized_images_are_rejected_before_allocation() {
        assert_eq!(
            normalize_png(b"not a png").expect_err("malformed").code,
            "terminal_image_invalid"
        );
        let mut oversized = png_with_metadata(1, 1);
        oversized[16..20].copy_from_slice(&(MAX_SIDE + 1).to_be_bytes());
        assert_eq!(
            normalize_png(&oversized).expect_err("oversized").code,
            "terminal_image_too_large"
        );
        let truncated = &png_with_metadata(2, 2)[..30];
        assert_eq!(
            normalize_png(truncated).expect_err("truncated").code,
            "terminal_image_invalid"
        );
    }

    #[test]
    fn managed_store_is_private_generated_and_quota_bounded() {
        let data = tempfile::tempdir().expect("data");
        let target_id = kalcode_contracts::ids::new_id();
        let target = agent_target(&target_id);
        let png = normalize_png(&png_with_metadata(1, 1)).expect("png");
        let first = store_png(data.path(), &target, &png).expect("stored");
        assert!(first.starts_with(std::fs::canonicalize(data.path()).expect("canonical data")));
        assert_eq!(
            first.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(std::fs::read(&first).expect("read"), png);

        let directory = first.parent().expect("image directory");
        for index in 1..MAX_FILES_PER_TARGET {
            std::fs::write(directory.join(format!("fixture-{index}.png")), b"x").expect("fixture");
        }
        assert_eq!(
            store_png(data.path(), &target, &png)
                .expect_err("quota")
                .code,
            "terminal_image_storage_full"
        );
    }

    #[test]
    fn managed_store_rejects_linked_components() {
        let data = tempfile::tempdir().expect("data");
        let outside = tempfile::tempdir().expect("outside");
        let link = data.path().join("terminal-images");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(outside.path(), &link).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(outside.path(), &link).is_ok();
        if !linked {
            return;
        }
        let terminal_id = kalcode_contracts::ids::new_id();
        let error = private_directory(
            data.path(),
            ["terminal-images", "terminals", terminal_id.as_str()],
        )
        .expect_err("linked component");
        assert_eq!(error.code, "terminal_image_storage_unsafe");
    }

    #[test]
    fn closed_terminal_cleanup_removes_only_generated_images() {
        let data = tempfile::tempdir().expect("data");
        let terminal_id = kalcode_contracts::ids::new_id();
        let target = TargetSnapshot::Terminal {
            terminal_id: terminal_id.clone(),
            identity: TerminalSessionIdentity {
                generation: 1,
                pid: 42,
            },
            shell_id: "pwsh".into(),
        };
        let png = normalize_png(&png_with_metadata(1, 1)).expect("png");
        let image = store_png(data.path(), &target, &png).expect("stored");
        let directory = image.parent().expect("target directory").to_path_buf();
        let abandoned = directory.join(format!(".{}.png.tmp", kalcode_contracts::ids::new_id()));
        std::fs::write(&abandoned, b"partial").expect("staged fixture");
        let unrelated = directory.join("keep.txt");
        std::fs::write(&unrelated, b"unrelated").expect("unrelated fixture");

        remove_terminal_images(data.path(), &terminal_id).expect("cleanup");
        assert!(!image.exists());
        assert!(!abandoned.exists());
        assert_eq!(std::fs::read(&unrelated).expect("preserved"), b"unrelated");
        assert!(directory.exists(), "unrelated data keeps the directory");

        std::fs::remove_file(&unrelated).expect("remove unrelated fixture");
        remove_terminal_images(data.path(), &terminal_id).expect("remove empty directory");
        assert!(!directory.exists());
    }

    #[test]
    fn discard_is_exact_and_missing_images_are_harmless() {
        let data = tempfile::tempdir().expect("data");
        let terminal_id = kalcode_contracts::ids::new_id();
        let target = TerminalImageTarget::Terminal {
            terminal_id: terminal_id.clone(),
        };
        assert!(
            !discard_imported_image(data.path(), &target, &kalcode_contracts::ids::new_id())
                .expect("missing target directory")
        );
        assert!(discard_imported_image(data.path(), &target, "../outside").is_err());

        let snapshot = TargetSnapshot::Terminal {
            terminal_id,
            identity: TerminalSessionIdentity {
                generation: 1,
                pid: 42,
            },
            shell_id: "pwsh".into(),
        };
        let png = normalize_png(&png_with_metadata(1, 1)).expect("png");
        let image = store_png(data.path(), &snapshot, &png).expect("stored");
        let image_id = image_id_from_path(&image).expect("generated id");
        let unrelated = image.parent().expect("directory").join("keep.txt");
        std::fs::write(&unrelated, b"unrelated").expect("unrelated fixture");

        assert!(discard_imported_image(data.path(), &target, &image_id).expect("discarded"));
        assert!(!image.exists());
        assert_eq!(std::fs::read(&unrelated).expect("preserved"), b"unrelated");
        assert!(!discard_imported_image(data.path(), &target, &image_id).expect("already absent"));
    }

    #[test]
    fn discard_refuses_linked_generated_name_without_touching_target() {
        let data = tempfile::tempdir().expect("data");
        let outside = tempfile::tempdir().expect("outside");
        let terminal_id = kalcode_contracts::ids::new_id();
        let target = TerminalImageTarget::Terminal {
            terminal_id: terminal_id.clone(),
        };
        let directory = private_directory(
            data.path(),
            ["terminal-images", "terminals", terminal_id.as_str()],
        )
        .expect("managed directory");
        let outside_file = outside.path().join("outside.png");
        std::fs::write(&outside_file, b"outside").expect("outside fixture");
        let image_id = kalcode_contracts::ids::new_id();
        let linked_name = directory.join(format!("{image_id}.png"));
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside_file, &linked_name).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside_file, &linked_name).is_ok();
        if !linked {
            return;
        }

        assert_eq!(
            discard_imported_image(data.path(), &target, &image_id)
                .expect_err("linked image rejected")
                .code,
            "terminal_image_storage_unsafe"
        );
        assert_eq!(
            std::fs::read(&outside_file).expect("outside preserved"),
            b"outside"
        );
        assert!(linked_name.exists());
    }

    #[test]
    fn provider_and_shell_insertions_quote_paths_without_submitting() {
        let id = kalcode_contracts::ids::new_id();
        let agent = agent_target(&id);
        assert_eq!(
            agent
                .insertion("/Users/Kaleb Example/image.png")
                .expect("agent quote"),
            "\"/Users/Kaleb Example/image.png\""
        );
        assert_eq!(
            quote_for_shell("pwsh", "C:\\Users\\O'Brien\\image.png").expect("pwsh"),
            "'C:\\Users\\O''Brien\\image.png'"
        );
        assert_eq!(
            quote_for_shell("zsh", "/Users/O'Brien/image.png").expect("zsh"),
            "'/Users/O'\\''Brien/image.png'"
        );
        assert!(agent.insertion("/Users/bad\"name/image.png").is_err());
        #[cfg(windows)]
        assert_eq!(
            terminal_path_text(Path::new(r"\\?\C:\Users\Kaleb\image.png"))
                .expect("normal Windows path"),
            r"C:\Users\Kaleb\image.png"
        );
    }

    #[test]
    fn snapshot_identity_detects_restarted_targets() {
        let id = kalcode_contracts::ids::new_id();
        let before = TargetSnapshot::Terminal {
            terminal_id: id.clone(),
            identity: TerminalSessionIdentity {
                generation: 7,
                pid: 42,
            },
            shell_id: "zsh".into(),
        };
        let restarted = TargetSnapshot::Terminal {
            terminal_id: id,
            identity: TerminalSessionIdentity {
                generation: 8,
                pid: 42,
            },
            shell_id: "zsh".into(),
        };
        assert_ne!(before, restarted);
        assert_eq!(before.terminal_generation(), Some(7));

        let shell_response = ImportedTerminalImage {
            image_id: kalcode_contracts::ids::new_id(),
            path: "managed.png".into(),
            insertion: "'managed.png'".into(),
            terminal_generation: before.terminal_generation(),
        };
        assert_eq!(
            serde_json::to_value(shell_response).expect("serialize")["terminalGeneration"],
            7
        );
        let agent_response = ImportedTerminalImage {
            image_id: kalcode_contracts::ids::new_id(),
            path: "managed.png".into(),
            insertion: "\"managed.png\"".into(),
            terminal_generation: agent_target(&kalcode_contracts::ids::new_id())
                .terminal_generation(),
        };
        assert!(
            serde_json::to_value(agent_response).expect("serialize")["terminalGeneration"]
                .is_null()
        );
    }
}
