//! Integration tests for workspaces and terminal tabs, with real shells in real
//! pseudo-terminals (ConPTY on Windows, openpty elsewhere).

// Test helpers outside `#[test]` functions panic on setup failures by design.
#![allow(clippy::expect_used)]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_core::events::{EventEnvelope, EventPayload};
use kalcode_core::flags::BuildChannel;
use kalcode_core::plans::{Limited, PlanTier};
use kalcode_core::workspaces::{MAX_WRITE_BYTES, TerminalStatus};
use kalcode_core::{Core, CoreConfig, Paths};
use kalcode_pty::TerminalSize;

fn config(dir: &Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(dir),
        app_version: "0.1.0-test".into(),
        channel: BuildChannel::Development,
    }
}

fn open(dir: &Path) -> Arc<Core> {
    Arc::new(Core::open(config(dir)).expect("open core"))
}

fn size() -> TerminalSize {
    TerminalSize::new(200, 40).expect("size")
}

/// A fast, always-present shell for tests: cmd on Windows, sh elsewhere.
fn test_shell(core: &Core) -> String {
    let wanted: &[&str] = if cfg!(windows) {
        &["cmd"]
    } else {
        &["sh", "bash", "zsh"]
    };
    let shells = core.shells();
    wanted
        .iter()
        .find_map(|id| shells.iter().find(|s| s.id == *id).map(|s| s.id.clone()))
        .expect("a test shell is installed")
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    condition()
}

/// Collects a terminal's output (replay + live), answering cursor-position requests like a view.
struct Output(Arc<Mutex<Vec<u8>>>);

impl Output {
    fn attach(core: &Arc<Core>, terminal_id: &str) -> Self {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let sink = buffer.clone();
        let responder = Arc::downgrade(core);
        let id = terminal_id.to_owned();
        core.attach_terminal(terminal_id, move |chunk| {
            sink.lock().expect("lock").extend_from_slice(chunk);
            if chunk.windows(4).any(|w| w == b"\x1b[6n")
                && let Some(core) = responder.upgrade()
            {
                let _ = core.write_terminal(&id, b"\x1b[1;1R");
            }
            true
        })
        .expect("attach")
        .expect("session exists");
        Self(buffer)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().expect("lock")).into_owned()
    }

    fn wait_for(&self, needle: &str) {
        assert!(
            wait_until(Duration::from_secs(20), || self.text().contains(needle)),
            "expected {needle:?} in terminal output: {:?}",
            self.text()
        );
    }
}

fn collect_events(core: &Core) -> Arc<Mutex<Vec<EventEnvelope>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    core.subscribe(move |e| {
        sink.lock().expect("lock").push(e.clone());
        true
    });
    seen
}

/// Command that prints `value` only when run (the typed command itself doesn't contain it).
fn echo_computed(tag: &str) -> (String, String) {
    if cfg!(windows) {
        (
            format!("echo {tag}-%OS%\r"),
            format!("{tag}-{}", std::env::var("OS").expect("OS")),
        )
    } else {
        (format!("echo {tag}-$((40+2))\r"), format!("{tag}-42"))
    }
}

fn echo_cwd() -> &'static str {
    if cfg!(windows) {
        "echo cwd=[%CD%]\r"
    } else {
        "echo cwd=[$PWD]\r"
    }
}

#[test]
fn terminal_context_actions_preserve_output_and_target_only_the_selected_tab() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let events = collect_events(&core);
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("terminal");
    let other = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("other");
    let output = Output::attach(&core, &terminal.id);
    let (command, expected) = echo_computed("retained");
    core.write_terminal(&terminal.id, command.as_bytes())
        .expect("write");
    output.wait_for(&expected);
    assert_eq!(
        core.rename_terminal(&terminal.id, "  Build logs  ")
            .expect("rename")
            .title,
        "Build logs"
    );
    core.rename_terminal(&terminal.id, "Build logs")
        .expect("unchanged name");
    assert_eq!(events.lock().expect("events").iter().filter(|event| matches!(
        &event.event,
        EventPayload::ShellRenamed { terminal_id, title } if terminal_id == &terminal.id && title == "Build logs"
    )).count(), 1);
    for title in ["", " \n ", "bad\u{001b}title", &"x".repeat(257)] {
        assert_eq!(
            core.rename_terminal(&terminal.id, title).unwrap_err().code,
            "invalid_terminal_title"
        );
    }
    let stopped = core.stop_terminal(&terminal.id).expect("stop");
    assert_eq!(stopped.status, TerminalStatus::Exited);
    assert_eq!(stopped.title, "Build logs");
    assert_eq!(core.terminals(&workspace.id).expect("tabs").len(), 2);
    assert_eq!(
        core.terminal(&other.id).expect("other").status,
        TerminalStatus::Running
    );
    assert!(
        Output::attach(&core, &terminal.id)
            .text()
            .contains(&expected)
    );
    assert_eq!(
        core.write_terminal(&terminal.id, b"x").unwrap_err().code,
        "terminal_not_running"
    );
    core.stop_terminal(&terminal.id).expect("idempotent stop");
    assert!(wait_until(Duration::from_secs(5), || {
        events.lock().expect("events").iter().any(|event| matches!(&event.event, EventPayload::ShellCompleted { terminal_id, closed_by_user: false, .. } if terminal_id == &terminal.id))
    }));
    let restarted = core
        .restart_terminal(&terminal.id, size())
        .expect("restart");
    assert_eq!(restarted.title, "Build logs");
    core.shutdown();
    drop(core);
    let restored = open(data.path());
    assert_eq!(
        restored.terminal(&terminal.id).expect("restored").title,
        "Build logs"
    );
    restored.shutdown();
}

#[test]
fn opening_a_folder_creates_one_workspace_per_canonical_path() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let site = projects.path().join("site");
    std::fs::create_dir_all(site.join("src")).expect("mkdir");
    let other = projects.path().join("other");
    std::fs::create_dir(&other).expect("mkdir");

    let core = open(data.path());
    let events = collect_events(&core);

    let first = core.open_workspace(&site).expect("open");
    assert_eq!(first.name, "site");
    assert!(first.available);
    let canonical = std::fs::canonicalize(&site).expect("canonical");
    let canonical = canonical.to_string_lossy();
    assert_eq!(
        first.root_path,
        canonical.strip_prefix(r"\\?\").unwrap_or(&canonical),
        "stored with its canonical path"
    );
    assert!(!first.root_path.starts_with(r"\\?\"));

    // The same folder reached another way reuses the workspace.
    std::thread::sleep(Duration::from_millis(5));
    core.open_workspace(&other).expect("other");
    std::thread::sleep(Duration::from_millis(5));
    let again = core
        .open_workspace(&site.join("src").join(".."))
        .expect("reopen");
    assert_eq!(again.id, first.id);
    assert_eq!(core.workspaces().expect("list").len(), 2);

    // Most recently opened first.
    let names: Vec<String> = core
        .workspaces()
        .expect("list")
        .into_iter()
        .map(|w| w.name)
        .collect();
    assert_eq!(names, vec!["site", "other"]);
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(first.id.clone())
    );

    let types: Vec<&str> = events
        .lock()
        .expect("lock")
        .iter()
        .map(|e| e.event.type_name())
        .collect::<Vec<_>>()
        .into_iter()
        .collect();
    assert_eq!(
        types,
        vec!["workspace.created", "workspace.created", "workspace.opened"]
    );
    let seen = events.lock().expect("lock");
    assert_eq!(
        seen[2].correlation.workspace_id.as_deref(),
        Some(first.id.as_str())
    );
}

#[test]
fn logout_drains_shells_preserves_tabs_and_allows_a_fresh_session() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("terminal");
    core.drain_terminals_for_logout().expect("drain");
    assert!(core.running_terminals().expect("running").is_empty());
    assert_eq!(core.terminals(&workspace.id).expect("tabs").len(), 1);
    assert_eq!(
        core.create_terminal(&workspace.id, Some(&shell), size(), None)
            .unwrap_err()
            .code,
        "runtime_draining"
    );
    core.resume_terminals_after_logout()
        .expect("resume admission");
    core.restart_terminal(&terminal.id, size())
        .expect("fresh shell");
    assert_eq!(core.running_terminals().expect("running").len(), 1);
    core.drain_terminals_for_logout().expect("second drain");
    core.shutdown();
}

#[test]
fn invalid_folders_are_rejected_with_typed_errors() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());

    let missing = core
        .open_workspace(&projects.path().join("does-not-exist"))
        .expect_err("missing");
    assert_eq!(missing.code, "folder_not_found");

    let file = projects.path().join("notes.txt");
    std::fs::write(&file, "x").expect("file");
    let not_dir = core.open_workspace(&file).expect_err("file");
    assert_eq!(not_dir.code, "not_a_folder");

    assert!(core.workspaces().expect("list").is_empty());
    assert_eq!(
        core.activate_workspace("not-an-id").expect_err("id").code,
        "invalid_id"
    );
    assert_eq!(
        core.activate_workspace(&uuid::Uuid::now_v7().to_string())
            .expect_err("unknown")
            .code,
        "not_found"
    );
}

/// Regression (review finding): a whole drive or the home folder itself must not become a
/// workspace root; project folders inside them still can.
#[test]
fn drive_roots_and_the_home_folder_are_refused() {
    let data = tempfile::tempdir().expect("data");
    let core = open(data.path());

    let drive_root = std::env::temp_dir()
        .ancestors()
        .last()
        .expect("root")
        .to_path_buf();
    let refused = core.open_workspace(&drive_root).expect_err("drive root");
    assert_eq!(refused.code, "folder_too_broad");
    if cfg!(windows) {
        let verbatim = std::path::PathBuf::from(format!(r"\\?\{}", drive_root.display()));
        assert_eq!(
            core.open_workspace(&verbatim).expect_err("verbatim").code,
            "folder_too_broad"
        );
    }

    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    if let Some(home) = std::env::var_os(home_var).map(std::path::PathBuf::from)
        && home.is_dir()
    {
        assert_eq!(
            core.open_workspace(&home).expect_err("home").code,
            "folder_too_broad"
        );
        // Through a `..` detour it is still the home folder.
        let detour = home.join("..").join(home.file_name().expect("home name"));
        assert_eq!(
            core.open_workspace(&detour).expect_err("home detour").code,
            "folder_too_broad"
        );
    }
    assert!(core.workspaces().expect("list").is_empty());

    // A project folder (the temp folder lives under the home folder on most machines) opens.
    let projects = tempfile::tempdir().expect("projects");
    core.open_workspace(projects.path())
        .expect("subfolder opens");
}

#[test]
fn active_workspace_persists_across_restart() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let a = projects.path().join("a");
    let b = projects.path().join("b");
    std::fs::create_dir(&a).expect("a");
    std::fs::create_dir(&b).expect("b");
    let b_id;
    {
        let core = open(data.path());
        let a = core.open_workspace(&a).expect("a");
        b_id = core.open_workspace(&b).expect("b").id;
        core.activate_workspace(&a.id).expect("activate a");
        core.activate_workspace(&b_id).expect("activate b");
        core.shutdown();
    }
    let core = open(data.path());
    assert_eq!(
        core.active_workspace().expect("active").map(|w| w.id),
        Some(b_id)
    );
}

#[test]
fn a_moved_folder_is_reported_unavailable() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let site = projects.path().join("site");
    std::fs::create_dir(&site).expect("mkdir");
    let core = open(data.path());
    let workspace = core.open_workspace(&site).expect("open");
    std::fs::remove_dir(&site).expect("remove folder outside KalCode");

    let listed = core.workspaces().expect("list");
    assert!(!listed[0].available);
    let err = core
        .create_terminal(&workspace.id, None, size(), None)
        .expect_err("no folder");
    assert_eq!(err.code, "folder_not_found");
    core.remove_workspace(&workspace.id)
        .expect("an unavailable workspace can be removed");
}

#[test]
fn shell_detection_lists_installed_shells_only() {
    let data = tempfile::tempdir().expect("data");
    let core = open(data.path());
    let shells = core.shells();
    assert!(!shells.is_empty());
    assert_eq!(shells.iter().filter(|s| s.is_default).count(), 1);
    let json = serde_json::to_string(&shells).expect("json");
    assert!(
        !json.contains('\\') && !json.contains('/'),
        "no executable paths cross IPC: {json}"
    );
}

#[test]
fn terminal_identity_is_generation_bound_and_disappears_on_close() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let shell = test_shell(&core);
    assert!(core.terminal_session_identity("invalid").is_none());
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("terminal");
    let first = core
        .terminal_session_identity(&terminal.id)
        .expect("live identity");
    assert!(first.pid > 0);
    assert_eq!(core.terminal_session_identity(&terminal.id), Some(first));
    core.close_terminal(&terminal.id).expect("close");
    assert!(core.terminal_session_identity(&terminal.id).is_none());
    let replacement = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("replacement");
    let next = core
        .terminal_session_identity(&replacement.id)
        .expect("new identity");
    assert_ne!(first.generation, next.generation);
    core.close_terminal(&replacement.id)
        .expect("close replacement");
}

#[test]
fn delayed_image_paste_rejects_a_different_shell_generation() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("terminal");
    let identity = core
        .terminal_session_identity(&terminal.id)
        .expect("identity");
    let output = Output::attach(&core, &terminal.id);
    let (command, expected) = echo_computed("image-generation");
    let error = core
        .write_terminal_for_generation(
            &terminal.id,
            command.as_bytes(),
            Some(identity.generation + 1),
        )
        .expect_err("stale paste must fail");
    assert_eq!(error.code, "terminal_image_target_changed");
    core.write_terminal_for_generation(&terminal.id, command.as_bytes(), Some(identity.generation))
        .expect("matching generation");
    output.wait_for(&expected);
    core.close_terminal(&terminal.id)
        .expect("close own test shell");
    assert!(
        core.write_terminal_for_generation(&terminal.id, b"image.png", Some(identity.generation))
            .is_err()
    );
}

#[test]
fn terminal_runs_in_the_workspace_folder_with_input_and_output() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let site = projects.path().join("site");
    std::fs::create_dir(&site).expect("mkdir");
    let core = open(data.path());
    let workspace = core.open_workspace(&site).expect("open");
    let events = collect_events(&core);

    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    assert_eq!(terminal.status, TerminalStatus::Running);
    assert_eq!(terminal.shell_id, shell);
    assert_eq!(terminal.position, 0);
    assert_eq!(
        core.workspaces().expect("list")[0]
            .active_terminal_id
            .as_deref(),
        Some(terminal.id.as_str()),
        "a new tab becomes the active tab"
    );

    let output = Output::attach(&core, &terminal.id);
    let (command, expected) = echo_computed("kc-io");
    core.write_terminal(&terminal.id, command.as_bytes())
        .expect("write");
    output.wait_for(&expected);

    core.write_terminal(&terminal.id, echo_cwd().as_bytes())
        .expect("write cwd");
    output.wait_for(&format!("cwd=[{}]", workspace.root_path));

    core.resize_terminal(&terminal.id, TerminalSize::new(120, 30).expect("size"))
        .expect("resize");

    let started = events
        .lock()
        .expect("lock")
        .iter()
        .find_map(|e| match &e.event {
            EventPayload::ShellStarted {
                terminal_id,
                shell_id,
                ..
            } => Some((terminal_id.clone(), shell_id.clone(), e.correlation.clone())),
            _ => None,
        });
    let (terminal_id, shell_id, correlation) = started.expect("shell.started");
    assert_eq!(terminal_id, terminal.id);
    assert_eq!(shell_id, shell);
    assert_eq!(
        correlation.workspace_id.as_deref(),
        Some(workspace.id.as_str())
    );

    assert_eq!(
        core.running_terminals().expect("running")[0].id,
        terminal.id
    );
    core.close_terminal(&terminal.id).expect("close");
}

#[test]
fn exit_codes_are_recorded_as_completed_or_failed() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    let workspace = core.open_workspace(projects.path()).expect("open");
    let events = collect_events(&core);
    let shell = test_shell(&core);

    let ok = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    let failing = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    assert_eq!(failing.position, 1);
    let _ok_out = Output::attach(&core, &ok.id);
    let _failing_out = Output::attach(&core, &failing.id);
    core.write_terminal(&ok.id, b"exit 0\r").expect("exit 0");
    core.write_terminal(&failing.id, b"exit 3\r")
        .expect("exit 3");

    let ended = |id: &str| {
        core.terminals(&workspace.id)
            .expect("list")
            .into_iter()
            .find(|t| t.id == id)
            .is_some_and(|t| t.status == TerminalStatus::Exited && t.ended_at.is_some())
    };
    assert!(wait_until(Duration::from_secs(20), || ended(&ok.id)
        && ended(&failing.id)));
    let tabs = core.terminals(&workspace.id).expect("list");
    assert_eq!(tabs[0].exit_code, Some(0));
    assert_eq!(tabs[1].exit_code, Some(3));
    assert!(core.running_terminals().expect("running").is_empty());

    let seen = events.lock().expect("lock");
    assert!(seen.iter().any(|e| matches!(
        &e.event,
        EventPayload::ShellCompleted { terminal_id, exit_code: 0, closed_by_user: false } if *terminal_id == ok.id
    )));
    assert!(seen.iter().any(|e| matches!(
        &e.event,
        EventPayload::ShellFailed { terminal_id, exit_code: 3 } if *terminal_id == failing.id
    )));
    drop(seen);

    // Input to an ended tab is refused with a clear, typed error.
    assert_eq!(
        core.write_terminal(&ok.id, b"x").expect_err("ended").code,
        "terminal_not_running"
    );
    // The ended tab's final output is still available to a view that attaches.
    let replay = Output::attach(&core, &ok.id);
    assert!(replay.text().contains("exit 0"), "{:?}", replay.text());
}

#[test]
fn restart_starts_a_fresh_shell_in_the_same_tab() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    let workspace = core.open_workspace(projects.path()).expect("open");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    let _out = Output::attach(&core, &terminal.id);
    core.write_terminal(&terminal.id, b"exit 5\r")
        .expect("exit");
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal(&terminal.id)
            // The recorded exit, not just the process ending (the recorder runs after it).
            .is_ok_and(|t| t.status == TerminalStatus::Exited && t.ended_at.is_some())
    }));

    let events = collect_events(&core);
    let restarted = core
        .restart_terminal(&terminal.id, size())
        .expect("restart");
    assert_eq!(restarted.id, terminal.id);
    assert_eq!(restarted.status, TerminalStatus::Running);
    assert_eq!(restarted.exit_code, None);
    assert_eq!(restarted.ended_at, None);
    assert_eq!(core.terminals(&workspace.id).expect("list").len(), 1);

    let output = Output::attach(&core, &terminal.id);
    let (command, expected) = echo_computed("kc-restart");
    core.write_terminal(&terminal.id, command.as_bytes())
        .expect("write");
    output.wait_for(&expected);
    assert!(
        !output.text().contains("exit 5"),
        "a restarted tab starts with a fresh screen"
    );
    assert!(
        events
            .lock()
            .expect("lock")
            .iter()
            .any(|e| e.event.type_name() == "shell.started")
    );

    // Restarting a running tab changes nothing.
    let again = core.restart_terminal(&terminal.id, size()).expect("noop");
    assert_eq!(again.started_at, restarted.started_at);
    core.close_terminal(&terminal.id).expect("close");
}

#[test]
fn closing_a_tab_ends_its_shell_and_records_it() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    let workspace = core.open_workspace(projects.path()).expect("open");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    let events = collect_events(&core);

    assert_eq!(
        core.close_terminal_if_ended(&terminal.id)
            .expect_err("protect live shell")
            .code,
        "terminal_still_running"
    );
    assert_eq!(core.running_terminals().expect("still running").len(), 1);

    core.close_terminal(&terminal.id).expect("close");
    assert!(core.terminals(&workspace.id).expect("list").is_empty());
    assert!(core.running_terminals().expect("running").is_empty());
    assert_eq!(
        core.workspaces().expect("list")[0].active_terminal_id,
        None,
        "a closed tab is no longer the active tab"
    );
    assert!(events.lock().expect("lock").iter().any(|e| matches!(
        &e.event,
        EventPayload::ShellCompleted { terminal_id, closed_by_user: true, .. } if *terminal_id == terminal.id
    )));
    assert_eq!(
        core.close_terminal(&terminal.id).expect_err("gone").code,
        "not_found"
    );
    assert_eq!(
        core.write_terminal(&terminal.id, b"x")
            .expect_err("gone")
            .code,
        "terminal_not_running"
    );
}

#[test]
fn removing_a_workspace_is_refused_while_terminals_run_and_never_touches_files() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let site = projects.path().join("site");
    std::fs::create_dir(&site).expect("mkdir");
    std::fs::write(site.join("README.md"), "keep me").expect("file");
    let core = open(data.path());
    let workspace = core.open_workspace(&site).expect("open");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");

    let refused = core.remove_workspace(&workspace.id).expect_err("running");
    assert_eq!(refused.code, "terminals_running");
    assert_eq!(core.workspaces().expect("list").len(), 1);

    core.close_terminal(&terminal.id).expect("close");
    let events = collect_events(&core);
    core.remove_workspace(&workspace.id).expect("remove");
    assert!(core.workspaces().expect("list").is_empty());
    assert!(core.active_workspace().expect("active").is_none());
    assert_eq!(
        std::fs::read_to_string(site.join("README.md")).expect("file untouched"),
        "keep me"
    );
    assert!(
        events
            .lock()
            .expect("lock")
            .iter()
            .any(|e| e.event.type_name() == "workspace.removed")
    );
}

#[test]
fn shutdown_ends_shells_and_restores_tabs_as_ended() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let (workspace_id, terminal_id);
    {
        let core = open(data.path());
        let workspace = core.open_workspace(projects.path()).expect("open");
        let shell = test_shell(&core);
        let terminal = core
            .create_terminal(&workspace.id, Some(&shell), size(), None)
            .expect("create");
        workspace_id = workspace.id;
        terminal_id = terminal.id;
        core.shutdown();
        assert!(core.running_terminals().expect("running").is_empty());
    }
    let core = open(data.path());
    let tabs = core.terminals(&workspace_id).expect("list");
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].id, terminal_id);
    assert_eq!(tabs[0].status, TerminalStatus::EndedByApp);
    assert!(tabs[0].ended_at.is_some());
    assert_eq!(
        core.workspaces().expect("list")[0]
            .active_terminal_id
            .as_deref(),
        Some(terminal_id.as_str()),
        "the active tab is restored"
    );
    // Nothing to replay after a restart; Restart brings the tab back.
    assert!(
        core.attach_terminal(&terminal_id, |_| true)
            .expect("attach")
            .is_none()
    );
    let restarted = core
        .restart_terminal(&terminal_id, size())
        .expect("restart");
    assert_eq!(restarted.status, TerminalStatus::Running);
    let output = Output::attach(&core, &terminal_id);
    let (command, expected) = echo_computed("kc-after-restart");
    core.write_terminal(&terminal_id, command.as_bytes())
        .expect("write");
    output.wait_for(&expected);
    core.shutdown();
}

#[test]
fn tabs_left_running_by_a_crash_are_marked_ended_at_startup() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let (workspace_id, terminal_id);
    {
        let core = open(data.path());
        let workspace = core.open_workspace(projects.path()).expect("open");
        let shell = test_shell(&core);
        terminal_id = core
            .create_terminal(&workspace.id, Some(&shell), size(), None)
            .expect("create")
            .id;
        workspace_id = workspace.id;
        // No shutdown(): the process "crashes".
    }
    let core = open(data.path());
    let tabs = core.terminals(&workspace_id).expect("list");
    assert_eq!(tabs[0].id, terminal_id);
    assert_eq!(tabs[0].status, TerminalStatus::EndedByApp);
    assert!(tabs[0].ended_at.is_some());
    assert!(core.running_terminals().expect("running").is_empty());
}

#[test]
fn terminal_inputs_are_validated() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    let workspace = core.open_workspace(projects.path()).expect("open");
    let shell = test_shell(&core);

    assert_eq!(
        core.create_terminal("x", None, size(), None)
            .expect_err("id")
            .code,
        "invalid_id"
    );
    assert_eq!(
        core.create_terminal(&workspace.id, Some("C:\\evil.exe"), size(), None)
            .expect_err("path as shell")
            .code,
        "invalid_shell"
    );
    assert_eq!(
        core.create_terminal(&workspace.id, Some("nosuchshell"), size(), None)
            .expect_err("unknown shell")
            .code,
        "shell_unavailable"
    );
    assert_eq!(
        core.create_terminal(&uuid::Uuid::now_v7().to_string(), None, size(), None)
            .expect_err("unknown workspace")
            .code,
        "not_found"
    );

    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    let too_big = vec![b'a'; MAX_WRITE_BYTES + 1];
    assert_eq!(
        core.write_terminal(&terminal.id, &too_big)
            .expect_err("too big")
            .code,
        "input_too_large"
    );
    core.write_terminal(&terminal.id, &too_big[..16])
        .expect("within the limit");
    assert_eq!(
        core.write_terminal("../x", b"x").expect_err("id").code,
        "invalid_id"
    );
    assert_eq!(
        core.set_active_terminal(&workspace.id, &uuid::Uuid::now_v7().to_string())
            .expect_err("foreign tab")
            .code,
        "not_found"
    );
    core.set_active_terminal(&workspace.id, &terminal.id)
        .expect("own tab");
    assert!(!core.detach_terminal(987_654), "unknown attachment");
    core.close_terminal(&terminal.id).expect("close");
}

#[test]
fn attachments_are_independent_and_do_not_survive_a_restart() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    let workspace = core.open_workspace(projects.path()).expect("open");
    let shell = test_shell(&core);
    let terminal = core
        .create_terminal(&workspace.id, Some(&shell), size(), None)
        .expect("create");
    // A view that answers the shell's startup cursor request, as xterm.js does.
    let _view = Output::attach(&core, &terminal.id);
    let first = core
        .attach_terminal(&terminal.id, |_| true)
        .expect("attach")
        .expect("id");
    let second = core
        .attach_terminal(&terminal.id, |_| true)
        .expect("attach")
        .expect("id");
    assert_ne!(first, second);
    assert!(core.detach_terminal(first));
    assert!(!core.detach_terminal(first));

    core.write_terminal(&terminal.id, b"exit\r").expect("exit");
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal(&terminal.id)
            .is_ok_and(|t| t.ended_at.is_some())
    }));
    core.restart_terminal(&terminal.id, size())
        .expect("restart");
    assert!(
        !core.detach_terminal(second),
        "views of the previous session were released by the restart"
    );
    core.close_terminal(&terminal.id).expect("close");
}

#[test]
fn every_plan_can_open_terminals_beyond_the_obsolete_caps_across_workspaces() {
    let data = tempfile::tempdir().expect("data");
    let projects = [
        tempfile::tempdir().expect("project"),
        tempfile::tempdir().expect("project"),
    ];
    let core = open(data.path());
    let workspaces = projects
        .iter()
        .map(|p| core.open_workspace(p.path()).expect("open"))
        .collect::<Vec<_>>();
    let shell = test_shell(&core);
    for tier in kalcode_core::plans::PUBLIC_PLANS {
        assert_eq!(tier.limit(Limited::OpenTerminals), None);
        for i in 0..5 {
            core.create_terminal(
                &workspaces[i % 2].id,
                Some(&shell),
                size(),
                tier.limit(Limited::OpenTerminals),
            )
            .expect("unlimited local terminal");
        }
    }
    assert_eq!(
        workspaces
            .iter()
            .map(|w| core.terminals(&w.id).expect("list").len())
            .sum::<usize>(),
        20
    );
    core.shutdown();
}

#[test]
fn a_limited_plan_bounds_new_workspaces_but_never_reopening_one() {
    let data = tempfile::tempdir().expect("data");
    let projects: Vec<_> = (0..4)
        .map(|_| tempfile::tempdir().expect("project"))
        .collect();
    let core = open(data.path());
    let limit = PlanTier::Free.limit(Limited::Workspaces);
    let first = core
        .open_workspace_limited(projects[0].path(), limit)
        .expect("first");
    core.open_workspace_limited(projects[1].path(), limit)
        .expect("second");
    core.check_workspace_capacity(None).expect("uncapped");
    let refused = core.check_workspace_capacity(limit).expect_err("full");
    assert_eq!(refused.code, "too_many_workspaces");
    let refused = core
        .open_workspace_limited(projects[2].path(), limit)
        .expect_err("a third workspace");
    assert_eq!(refused.code, "too_many_workspaces");
    assert_eq!(
        refused.message,
        "The Free plan allows 2 workspaces. Remove one to add another, or upgrade to Pro for 10."
    );
    assert_eq!(core.workspaces().expect("list").len(), 2);
    // Reopening an existing workspace at the cap is never refused.
    let again = core
        .open_workspace_limited(projects[0].path(), limit)
        .expect("reopen");
    assert_eq!(again.id, first.id);
    // Removing one frees a slot; an uncapped plan adds past the cap.
    core.remove_workspace(&first.id).expect("remove");
    core.open_workspace_limited(projects[2].path(), limit)
        .expect("a removed workspace frees a slot");
    core.open_workspace_limited(projects[3].path(), None)
        .expect("uncapped");
    assert_eq!(core.workspaces().expect("list").len(), 3);
}

#[test]
fn workspace_and_terminal_events_commit_atomically() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());

    let other =
        rusqlite::Connection::open(data.path().join("kalcode.db")).expect("second connection");
    other
        .execute_batch(
            "CREATE TRIGGER reject_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .expect("trigger");

    assert!(core.open_workspace(projects.path()).is_err());
    assert!(
        core.workspaces().expect("list").is_empty(),
        "no workspace without its event"
    );
    assert!(core.active_workspace().expect("active").is_none());

    other
        .execute_batch("DROP TRIGGER reject_events;")
        .expect("drop trigger");
    let workspace = core.open_workspace(projects.path()).expect("open");
    let shell = test_shell(&core);
    other
        .execute_batch(
            "CREATE TRIGGER reject_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
        )
        .expect("trigger");
    assert!(
        core.create_terminal(&workspace.id, Some(&shell), size(), None)
            .is_err()
    );
    assert!(
        core.terminals(&workspace.id).expect("list").is_empty(),
        "no tab without its shell.started event"
    );
    assert!(core.running_terminals().expect("running").is_empty());
}

#[test]
fn desktop_terminal_admission_never_falls_back_without_guardian() {
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    core.require_terminal_guardian().expect("require guardian");
    let workspace = core.open_workspace(projects.path()).expect("workspace");
    let shell = test_shell(&core);
    assert_eq!(
        core.create_terminal(&workspace.id, Some(&shell), size(), None)
            .unwrap_err()
            .code,
        "terminal_guardian_unavailable"
    );
    assert!(core.terminals(&workspace.id).unwrap().is_empty());
    assert!(core.resume_terminals_after_logout().is_err());
    assert!(core.running_terminals().unwrap().is_empty());
}

#[test]
fn guardian_denial_starts_no_shell_and_commits_no_terminal() {
    struct Deny;
    impl kalcode_pty::PtyGuardian for Deny {
        fn prepare(
            &self,
            _: &str,
        ) -> Result<Box<dyn kalcode_pty::PreparedPtyAdmission>, kalcode_pty::PtyError> {
            Err(kalcode_pty::PtyError::Spawn(
                "synthetic guardian denial".into(),
            ))
        }
    }
    let data = tempfile::tempdir().expect("data");
    let projects = tempfile::tempdir().expect("projects");
    let core = open(data.path());
    core.install_terminal_guardian(Arc::new(Deny))
        .expect("install");
    let workspace = core.open_workspace(projects.path()).expect("workspace");
    let shell = test_shell(&core);
    assert_eq!(
        core.create_terminal(&workspace.id, Some(&shell), size(), None)
            .unwrap_err()
            .code,
        "terminal_start_failed"
    );
    assert!(core.terminals(&workspace.id).unwrap().is_empty());
    assert!(core.running_terminals().unwrap().is_empty());
}

#[test]
fn logout_releases_terminal_epoch_authority_before_next_account_starts() {
    struct Deny;
    impl kalcode_pty::PtyGuardian for Deny {
        fn prepare(
            &self,
            _: &str,
        ) -> Result<Box<dyn kalcode_pty::PreparedPtyAdmission>, kalcode_pty::PtyError> {
            Err(kalcode_pty::PtyError::Spawn(
                "synthetic guardian denial".into(),
            ))
        }
    }
    let data = tempfile::tempdir().expect("data");
    let core = open(data.path());
    let guardian = Arc::new(Deny);
    let previous_epoch = Arc::downgrade(&guardian);
    core.install_terminal_guardian(guardian)
        .expect("install first epoch");
    assert!(previous_epoch.upgrade().is_some());
    core.drain_terminals_for_logout()
        .expect("verified terminal drain");
    assert!(
        previous_epoch.upgrade().is_none(),
        "Core must not retain the previous epoch recovery lock"
    );
    assert!(
        core.resume_terminals_after_logout().is_err(),
        "guardian requirement stays sticky after release"
    );
    core.install_terminal_guardian(Arc::new(Deny))
        .expect("install next epoch");
    core.resume_terminals_after_logout()
        .expect("new epoch admission");
    core.drain_terminals_for_logout()
        .expect("second verified drain");
}

#[test]
fn duplicate_terminal_is_independent_preserves_directory_and_omits_transient_environment() {
    let dir = tempfile::tempdir().expect("temp");
    let core = open(dir.path());
    let project = tempfile::tempdir().expect("project");
    let nested = project.path().join("nested folder");
    std::fs::create_dir(&nested).expect("nested");
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let original = core
        .create_terminal(&workspace.id, Some(&test_shell(&core)), size(), None)
        .expect("original");
    core.rename_terminal(&original.id, "Build / review")
        .expect("rename");
    let output = Output::attach(&core, &original.id);
    let change = if cfg!(windows) {
        format!(
            "cd /d \"{}\"\r\nset KALCODE_DUPLICATE_SECRET=private-marker\r\necho READY%KALCODE_DUPLICATE_SECRET%\r\n",
            nested.display()
        )
    } else {
        format!(
            "cd '{}'\nexport KALCODE_DUPLICATE_SECRET=private-marker\necho READY$KALCODE_DUPLICATE_SECRET\n",
            nested.display()
        )
    };
    core.write_terminal(&original.id, change.as_bytes())
        .expect("cd");
    // Wait for the command's result, not echoed input.
    output.wait_for("READYprivate-marker");
    let identity = core
        .terminal_session_identity(&original.id)
        .expect("source identity");
    let copy = core
        .duplicate_terminal(&original.id, size(), None)
        .expect("duplicate");
    assert_ne!(copy.id, original.id);
    assert_eq!(copy.workspace_id, original.workspace_id);
    assert_eq!(copy.shell_id, original.shell_id);
    assert_eq!(copy.title, "Build / review (copy)");
    assert_eq!(copy.status, TerminalStatus::Running);
    assert_ne!(
        core.terminal_session_identity(&copy.id)
            .expect("copy identity")
            .pid,
        identity.pid
    );
    let copied_output = Output::attach(&core, &copy.id);
    let inspect = if cfg!(windows) {
        "cd\r\nif defined KALCODE_DUPLICATE_SECRET (echo SECRET_PRESENT) else (echo SECRET_ABSENT)\r\n"
    } else {
        "pwd\nif [ -n \"$KALCODE_DUPLICATE_SECRET\" ]; then echo SECRET_PRESENT; else echo SECRET_ABSENT; fi\n"
    };
    core.write_terminal(&copy.id, inspect.as_bytes())
        .expect("inspect copy");
    copied_output.wait_for(nested.to_str().expect("path"));
    copied_output.wait_for("\r\nSECRET_ABSENT");
    assert_eq!(
        core.terminal_session_identity(&original.id)
            .expect("still live"),
        identity
    );
    core.stop_terminal(&copy.id).expect("stop copy");
    assert_eq!(
        core.terminal(&original.id).expect("source").status,
        TerminalStatus::Running
    );
    core.write_terminal(&original.id, b"echo ORIGINAL_STILL_LIVE\r\n")
        .expect("source input");
    output.wait_for("ORIGINAL_STILL_LIVE");
    // Ended duplicates retain their launch directory, including across runtime restarts.
    let saved: String = core
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT launch_cwd FROM terminals WHERE id = ?1",
                [&copy.id],
                |r| r.get(0),
            )?)
        })
        .expect("cwd");
    assert_eq!(
        std::fs::canonicalize(saved).unwrap(),
        std::fs::canonicalize(&nested).unwrap()
    );
    core.close_terminal(&original.id).expect("close source");
}

#[cfg(windows)]
#[test]
fn powershell_duplicate_uses_provider_location_and_keeps_custom_names() {
    let dir = tempfile::tempdir().expect("temp");
    let core = open(dir.path());
    let project = tempfile::tempdir().expect("project");
    let nested = project.path().join("PowerShell folder");
    std::fs::create_dir(&nested).unwrap();
    let workspace = core.open_workspace(project.path()).unwrap();
    for shell in core
        .shells()
        .into_iter()
        .filter(|s| s.id == "pwsh" || s.id == "powershell")
    {
        let original = core
            .create_terminal(&workspace.id, Some(&shell.id), size(), None)
            .unwrap();
        let output = Output::attach(&core, &original.id);
        let command = format!(
            "Set-Location -LiteralPath '{}'; Write-Output ('READY' + '-POWERSHELL')\r\n",
            nested.display()
        );
        core.write_terminal(&original.id, command.as_bytes())
            .unwrap();
        output.wait_for("READY-POWERSHELL");
        // Prompt synchronization follows output; wait for it before invoking the user action.
        output.wait_for(&format!("{}>", nested.display()));
        let copy = core
            .duplicate_terminal(&original.id, size(), None)
            .expect("PowerShell duplicate");
        let saved: String = core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT launch_cwd FROM terminals WHERE id = ?1",
                    [&copy.id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            std::fs::canonicalize(saved).unwrap(),
            std::fs::canonicalize(&nested).unwrap()
        );
        core.close_terminal(&copy.id).unwrap();
        core.close_terminal(&original.id).unwrap();
    }
}
