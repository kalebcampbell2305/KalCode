//! Universal Session Locator, workspace rail, returning-user home and recent work IPC
//! (campaign Z7-W2, `kalcode_locator`).
//!
//! Rules every command follows (CONTRACTS.md, ADVANCED.md LOC-04/05):
//! * ids are validated natively; the WebView never sends a path (folders are chosen in native
//!   pickers, revealed by id);
//! * search text is data only: never stored, logged or put into events;
//! * the locator runs off the UI thread; if it fails to start, KalCode continues and these
//!   commands explain that search is unavailable (failure isolation, ADVANCED.md §11).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kalcode_contracts::agent::{AuthState, DetectionState};
use kalcode_contracts::refs::{Page, PageRequest};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::plans::{Limited, PlanLimit};
use kalcode_core::workspaces::Workspace;
use kalcode_core::{Core, CoreConfig, ErrorCategory, IpcError, KalError};
use kalcode_locator::{
    HomeSummary, Locator, LocatorEntityKind, LocatorOpenTarget, LocatorQuery, LocatorResponse,
    LocatorSources, LocatorVia, ProviderInfo, RailSection, RailState, RailUpdate, RecentWorkItem,
    RecentWorkWhen, WorkspaceGroup, WorkspaceRailEntry,
};
use kalcode_providers::registry::ProviderRegistry;
use kalcode_threads::ThreadRuntime;
use serde::Deserialize;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::AppState;

// ---------------------------------------------------------------------------------------------
// Opening the core
// ---------------------------------------------------------------------------------------------

/// Opens the core with the registered migrations (schema v11 includes the rail and locator).
pub fn open_core(config: CoreConfig) -> Result<Core, KalError> {
    Core::open(config)
}

// ---------------------------------------------------------------------------------------------
// Sources and state
// ---------------------------------------------------------------------------------------------

/// Z3 threads and Z2 providers, as the locator reads them.
struct DesktopSources {
    core: Arc<Core>,
    threads: Option<Arc<ThreadRuntime>>,
    providers: Arc<ProviderRegistry>,
}

impl LocatorSources for DesktopSources {
    fn threads(&self) -> kalcode_core::Result<Vec<ThreadSummary>> {
        match &self.threads {
            Some(runtime) => runtime.list(None, true),
            None => Ok(Vec::new()),
        }
    }

    fn thread(&self, id: &str) -> kalcode_core::Result<Option<ThreadSummary>> {
        match &self.threads {
            Some(runtime) => match runtime.get(id) {
                Ok(thread) => Ok(Some(thread)),
                Err(error) if error.code == "thread_not_found" => Ok(None),
                Err(error) => Err(error),
            },
            None => Ok(None),
        }
    }

    fn thread_text(&self, id: &str, max_bytes: usize) -> kalcode_core::Result<String> {
        // Z3's store API on the read-only connection: reading never marks messages read.
        let messages = kalcode_threads::store::messages(&self.core.reader(), id, 200, None)?;
        let mut text = String::new();
        for message in messages.iter().rev() {
            if text.len() + message.content.len() + 1 > max_bytes {
                break;
            }
            text.insert_str(0, &format!("{}\n", message.content));
        }
        Ok(text)
    }

    fn providers(&self) -> Vec<ProviderInfo> {
        self.providers
            .list()
            .into_iter()
            .map(|status| {
                let (state, detail) = match &status.detection {
                    None => ("unknown", "Not checked yet".to_owned()),
                    Some(d) => match (d.state, d.auth) {
                        (DetectionState::NotInstalled, _) => {
                            ("not_installed", "Not installed".to_owned())
                        }
                        (DetectionState::Outdated, _) => ("outdated", "Update needed".to_owned()),
                        (DetectionState::Error, _) => ("unknown", "Couldn't be checked".to_owned()),
                        (DetectionState::Installed, AuthState::NotAuthenticated) => {
                            ("signed_out", "Installed · signed out".to_owned())
                        }
                        (DetectionState::Installed, AuthState::Authenticated) => {
                            ("ready", "Installed · signed in".to_owned())
                        }
                        (DetectionState::Installed, AuthState::Unknown) => {
                            ("ready", "Installed".to_owned())
                        }
                    },
                };
                ProviderInfo {
                    id: status.id.as_str().to_owned(),
                    name: status.display_name.clone(),
                    status: state.to_owned(),
                    detail,
                }
            })
            .collect()
    }
}

/// Managed state. `None` when the core or the locator didn't start.
pub struct LocatorState(Option<Arc<Locator>>);

impl LocatorState {
    pub fn start(
        state: &AppState,
        threads: Option<Arc<ThreadRuntime>>,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        let Some(core) = state.core.clone() else {
            return Self(None);
        };
        let sources = Arc::new(DesktopSources {
            core: core.clone(),
            threads,
            providers,
        });
        match Locator::start(core, sources) {
            Ok(locator) => Self(Some(locator)),
            Err(error) => {
                tracing::error!(event = "locator.start_failed", error = %error.diagnostic());
                Self(None)
            }
        }
    }

    pub fn locator(&self) -> Result<&Arc<Locator>, IpcError> {
        self.0.as_ref().ok_or_else(|| {
            KalError::internal(
                "locator_unavailable",
                "Search and the workspace rail aren't available right now. Restart KalCode; if this keeps happening, export diagnostics.",
            )
            .to_ipc()
        })
    }

    /// The running locator, for KalVoice's Search/Focus intents.
    pub fn handle(&self) -> Option<Arc<Locator>> {
        self.0.clone()
    }

    pub fn shutdown(&self) {
        if let Some(locator) = &self.0 {
            locator.shutdown();
        }
    }
}

async fn blocking<T: Send + 'static>(
    access: crate::runtime_coordinator::RuntimeAccess,
    command: &'static str,
    work: impl FnOnce() -> Result<T, KalError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        access.revalidate_core()?;
        work()
    })
    .await
    .map_err(|e| {
        KalError::internal("interrupted", "That was interrupted. Try again.")
            .with_source(e)
            .log_and_convert(command)
    })?
    .map_err(|e| e.log_and_convert(command))
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn locator_search(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    query: LocatorQuery,
) -> Result<LocatorResponse, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "locator_search", move || {
        locator.search(&query)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatorOpenArgs {
    pub kind: LocatorEntityKind,
    pub entity_id: String,
    pub via: LocatorVia,
}

#[tauri::command(async)]
pub async fn locator_open(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    args: LocatorOpenArgs,
) -> Result<LocatorOpenTarget, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "locator_open", move || {
        locator.open(args.kind, &args.entity_id, args.via)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn rail_state(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
) -> Result<RailState, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_state", move || locator.rail_state()).await
}

#[tauri::command(async)]
pub async fn rail_update(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    update: RailUpdate,
) -> Result<WorkspaceRailEntry, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_update", move || {
        locator.rail_update(&update)
    })
    .await
}

#[tauri::command(async)]
pub async fn rail_section_set(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    section: RailSection,
    collapsed: bool,
) -> Result<RailState, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_section_set", move || {
        locator.set_section_collapsed(section, collapsed)
    })
    .await
}

#[tauri::command(async)]
pub async fn rail_group_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    name: String,
) -> Result<WorkspaceGroup, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_group_create", move || {
        locator.group_create(&name)
    })
    .await
}

#[tauri::command(async)]
pub async fn rail_group_update(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    id: String,
    name: Option<String>,
    collapsed: Option<bool>,
) -> Result<WorkspaceGroup, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_group_update", move || {
        locator.group_update(&id, name.as_deref(), collapsed)
    })
    .await
}

#[tauri::command(async)]
pub async fn rail_group_delete(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_group_delete", move || {
        locator.group_delete(&id)
    })
    .await
}

#[tauri::command(async)]
pub async fn rail_group_reorder(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    ids: Vec<String>,
) -> Result<Vec<WorkspaceGroup>, IpcError> {
    _runtime_access.revalidate()?;
    if ids.len() > kalcode_locator::rail::MAX_GROUPS {
        return Err(KalError::validation("too_many_groups", "Too many folders.").to_ipc());
    }
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "rail_group_reorder", move || {
        locator.group_reorder(&ids)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Home and recent work
// ---------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub async fn home_summary(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    local_hour: u8,
    visit: bool,
) -> Result<HomeSummary, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "home_summary", move || {
        locator.home_summary(local_hour, visit)
    })
    .await
}

#[tauri::command(async)]
pub async fn recent_work(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    locator: crate::runtime_coordinator::RuntimeState<LocatorState>,
    when: RecentWorkWhen,
    tz_offset_minutes: i32,
    page: PageRequest,
) -> Result<Page<RecentWorkItem>, IpcError> {
    _runtime_access.revalidate()?;
    let locator = Arc::clone(locator.locator()?);
    blocking(_runtime_access, "recent_work", move || {
        locator.recent_work(when, tz_offset_minutes, &page)
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// Workspace actions from the rail (paths resolved natively)
// ---------------------------------------------------------------------------------------------

fn workspace(core: &Core, workspace_id: &str) -> Result<Workspace, KalError> {
    if !kalcode_contracts::ids::is_valid_id(workspace_id) {
        return Err(KalError::validation("invalid_id", "That id isn't valid."));
    }
    core.workspaces()?
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| {
            KalError::validation("workspace_unknown", "That workspace no longer exists.")
        })
}

/// Shows a workspace's folder in the OS file manager. The WebView names the workspace by id;
/// its folder is resolved natively.
#[tauri::command(async)]
pub fn workspace_reveal(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?;
    let ws = workspace(core, &workspace_id).map_err(|e| e.log_and_convert("workspace_reveal"))?;
    let root = PathBuf::from(&ws.root_path);
    if !root.is_dir() {
        return Err(KalError::new(
            ErrorCategory::Filesystem,
            "folder_missing",
            "That folder was moved or deleted outside KalCode.",
        )
        .log_and_convert("workspace_reveal"));
    }
    window.opener().reveal_item_in_dir(&root).map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "reveal_failed",
            "Your system couldn't show that folder.",
        )
        .with_source(e)
        .log_and_convert("workspace_reveal")
    })
}

/// Windows (and portable) rules for a new folder's name.
pub fn validate_folder_name(raw: &str) -> Result<String, KalError> {
    let name = raw.trim();
    let invalid = |message: &str| KalError::validation("invalid_folder_name", message.to_owned());
    if name.is_empty() {
        return Err(invalid("Give the workspace a name."));
    }
    if name.chars().count() > 80 {
        return Err(invalid("Folder names can be at most 80 characters."));
    }
    if name == "." || name == ".." {
        return Err(invalid("That isn't a folder name."));
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err(invalid(
            "Folder names can't contain < > : \" / \\ | ? * or control characters.",
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(invalid("Folder names can't end with a dot or a space."));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(invalid("That name is reserved by Windows."));
    }
    Ok(name.to_owned())
}

/// Creates a new, empty project folder named `name` inside a folder the person picks in the
/// native dialog, and opens it as a workspace. Returns `None` when the picker is cancelled.
#[tauri::command]
pub async fn workspace_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, AppState>,
    account: State<'_, Arc<crate::account::runtime::AccountRuntime>>,
    name: String,
) -> Result<Option<Workspace>, IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?.clone();
    let account = account.inner().clone();
    let name = validate_folder_name(&name).map_err(|e| e.log_and_convert("workspace_create"))?;
    // A new folder is always a new workspace: refuse past the plan's cap before the picker.
    core.check_workspace_capacity(account.snapshot().plan_limit(Limited::Workspaces))
        .map_err(|e| e.log_and_convert("workspace_create"))?;
    let parent: Option<PathBuf> = match crate::environment::e2e_pick_folder() {
        Some(path) => Some(path),
        None => {
            let dialog = window
                .dialog()
                .file()
                .set_parent(&window)
                .set_title(format!("Choose where to create “{name}”"));
            let picked =
                tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
                    .await
                    .map_err(|e| {
                        KalError::internal("interrupted", "That was interrupted.")
                            .with_source(e)
                            .log_and_convert("workspace_create")
                    })?;
            match picked {
                None => None,
                Some(path) => Some(path.into_path().map_err(|e| {
                    KalError::validation("unsupported_folder", "KalCode can't use that location.")
                        .with_source(e)
                        .log_and_convert("workspace_create")
                })?),
            }
        }
    };
    let Some(parent) = parent else {
        return Ok(None);
    };
    blocking(_runtime_access, "workspace_create", move || {
        create_in(
            &core,
            &parent,
            &name,
            account.snapshot().plan_limit(Limited::Workspaces),
        )
    })
    .await
    .map(Some)
}

fn create_in(
    core: &Core,
    parent: &Path,
    name: &str,
    limit: Option<PlanLimit>,
) -> Result<Workspace, KalError> {
    // Checked before the folder exists, so a refusal never leaves an empty folder behind.
    core.check_workspace_capacity(limit)?;
    if !parent.is_dir() {
        return Err(KalError::new(
            ErrorCategory::Filesystem,
            "folder_not_found",
            "That location isn't a folder.",
        ));
    }
    let folder = parent.join(name);
    std::fs::create_dir(&folder).map_err(|e| {
        let (code, message) = if e.kind() == std::io::ErrorKind::AlreadyExists {
            (
                "folder_exists",
                "A folder with that name already exists there. Open it with Open folder instead.",
            )
        } else {
            (
                "create_folder_failed",
                "KalCode couldn't create that folder.",
            )
        };
        KalError::new(ErrorCategory::Filesystem, code, message).with_source(e)
    })?;
    core.open_workspace_limited(&folder, limit)
        .inspect_err(|_| {
            // Only the empty folder just created; `remove_dir` never deletes contents.
            let _ = std::fs::remove_dir(&folder);
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_follow_windows_rules() {
        for ok in ["atlas-api", "My Project", "v2.1 release", "日本語"] {
            assert_eq!(validate_folder_name(ok).expect(ok), ok);
        }
        for bad in [
            "",
            "  ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:",
            "what?",
            "star*",
            "pipe|",
            "quote\"",
            "trail.",
            "CON",
            "con.txt",
            "COM1",
            "lpt9",
            "tab\there",
        ] {
            assert!(
                validate_folder_name(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(validate_folder_name(&"x".repeat(81)).is_err());
        assert!(validate_folder_name("COMMON").is_ok());
    }

    #[test]
    fn creating_a_workspace_makes_a_new_folder_only() {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::open(CoreConfig {
            paths: kalcode_core::Paths::new(dir.path().join("data")),
            app_version: "0.0.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .expect("core");
        let projects = dir.path().join("projects");
        std::fs::create_dir_all(&projects).expect("projects");
        let ws = create_in(&core, &projects, "fresh", None).expect("create");
        assert_eq!(ws.name, "fresh");
        assert!(projects.join("fresh").is_dir());
        let err = create_in(&core, &projects, "fresh", None).expect_err("exists");
        assert_eq!(err.code, "folder_exists");
        let err = create_in(&core, &projects.join("missing"), "x", None).expect_err("parent");
        assert_eq!(err.code, "folder_not_found");
        core.shutdown();
    }

    #[test]
    fn a_full_plan_refuses_a_new_workspace_without_creating_its_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::open(CoreConfig {
            paths: kalcode_core::Paths::new(dir.path().join("data")),
            app_version: "0.0.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .expect("core");
        let projects = dir.path().join("projects");
        std::fs::create_dir_all(&projects).expect("projects");
        let limit = kalcode_core::plans::PlanTier::Free.limit(Limited::Workspaces);
        create_in(&core, &projects, "one", limit).expect("first");
        create_in(&core, &projects, "two", limit).expect("second");
        let err = create_in(&core, &projects, "three", limit).expect_err("full");
        assert_eq!(err.code, "too_many_workspaces");
        assert!(!projects.join("three").exists(), "no folder is created");
        create_in(&core, &projects, "three", None).expect("uncapped");
        core.shutdown();
    }
}
