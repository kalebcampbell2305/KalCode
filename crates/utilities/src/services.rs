//! Local development-service discovery for Operations.
//!
//! Discovery is an observation layer over the existing Process Monitor, Port Inspector and
//! workspace terminal registry. It never reads command lines or environments and never becomes a
//! second execution authority. A service can restart only through a linked Operations run whose
//! owner-authored command is still available.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use kalcode_contracts::operations::{
    DevelopmentService, OperationKind, OperationRecord, OperationStatus,
};
use kalcode_core::Core;

use crate::ports::RawPort;
use crate::processes::{ProcessContext, ProcessSampler, TerminalRoot, WorkspaceRoot};
use crate::{ProcessInfo, ProcessOwner, ProcessScope, TransportProtocol, ports};

/// Discovers current workspace services and projects service-kind run records that have no port.
/// Each operating-system source is sampled once. Because process and port tools cannot provide one
/// atomic cross-platform snapshot, observed services remain display-only; mutation authority comes
/// only from a linked Operations-owned terminal session.
pub fn discover(
    core: &Arc<Core>,
    runs: &[OperationRecord],
) -> kalcode_core::Result<Vec<DevelopmentService>> {
    Ok(discover_observation(core, runs)?.0)
}

/// Discovers services and reports whether the process/port observation was complete. Durable
/// Operations services remain visible when the platform port tool is unavailable, while callers
/// can keep environment health explicitly unknown instead of treating missing ports as an empty
/// successful observation.
pub fn discover_observation(
    core: &Arc<Core>,
    runs: &[OperationRecord],
) -> kalcode_core::Result<(Vec<DevelopmentService>, bool)> {
    let workspaces = core
        .workspaces()?
        .into_iter()
        .filter(|workspace| workspace.available)
        .collect::<Vec<_>>();
    let roots = workspaces
        .iter()
        .map(|workspace| WorkspaceRoot {
            id: workspace.id.clone(),
            name: workspace.name.clone(),
            path: PathBuf::from(&workspace.root_path),
        })
        .collect();
    let mut retained_terminals = Vec::new();
    for workspace in &workspaces {
        retained_terminals.extend(core.terminals(&workspace.id)?);
    }
    let retained_terminal_ids = retained_terminals
        .iter()
        .map(|terminal| terminal.id.clone())
        .collect::<HashSet<_>>();
    let terminals = retained_terminals
        .into_iter()
        .filter_map(|terminal| {
            core.terminal_session_identity(&terminal.id)
                .map(|identity| TerminalRoot {
                    pid: identity.pid,
                    generation: identity.generation,
                    terminal_id: terminal.id,
                    workspace_id: terminal.workspace_id,
                })
        })
        .collect();
    let (raw_ports, observation_complete) = port_observation(ports::list_raw());
    let listening = ports::owners(&raw_ports).into_iter().collect();
    let context = ProcessContext {
        self_pid: std::process::id(),
        workspaces: roots,
        terminals,
        listening,
    };
    let (processes, uptimes) = ProcessSampler::new().list_with_uptime(&context, ProcessScope::All);
    Ok((
        project(
            &workspaces,
            &processes.processes,
            &uptimes,
            &raw_ports,
            runs,
            &retained_terminal_ids,
        ),
        observation_complete,
    ))
}

fn port_observation(
    result: kalcode_core::Result<(Vec<RawPort>, &'static str)>,
) -> (Vec<RawPort>, bool) {
    match result {
        Ok((ports, _)) => (ports, true),
        Err(error) => {
            tracing::warn!(
                event = "operations.services_ports_unavailable",
                code = error.code
            );
            (Vec::new(), false)
        }
    }
}

fn project(
    workspaces: &[kalcode_core::workspaces::Workspace],
    processes: &[ProcessInfo],
    uptimes: &HashMap<u32, u64>,
    raw_ports: &[RawPort],
    runs: &[OperationRecord],
    retained_terminal_ids: &HashSet<String>,
) -> Vec<DevelopmentService> {
    let workspace_names: HashMap<&str, &str> = workspaces
        .iter()
        .map(|workspace| (workspace.id.as_str(), workspace.name.as_str()))
        .collect();
    let service_runs = current_service_runs(runs);
    let run_by_terminal: HashMap<&str, &OperationRecord> = service_runs
        .iter()
        .filter_map(|run| run.terminal_id.as_deref().map(|terminal| (terminal, *run)))
        .collect();
    let raw_by_pid =
        raw_ports
            .iter()
            .fold(HashMap::<u32, Vec<&RawPort>>::new(), |mut grouped, port| {
                if let Some(pid) = port.pid {
                    grouped.entry(pid).or_default().push(port);
                }
                grouped
            });
    let terminal_roots: HashMap<&str, &ProcessInfo> = processes
        .iter()
        .filter_map(|process| {
            process
                .terminal_generation
                .and(process.terminal_id.as_deref().map(|id| (id, process)))
        })
        .collect();

    let mut linked_runs = HashSet::new();
    let mut services = Vec::new();
    for process in processes.iter().filter(|process| {
        !process.ports.is_empty()
            && matches!(
                process.owner,
                ProcessOwner::KalCodeChild | ProcessOwner::CurrentUser
            )
            && process
                .workspace_id
                .as_deref()
                .is_some_and(|id| workspace_names.contains_key(id))
    }) {
        let Some(workspace_id) = process.workspace_id.as_deref() else {
            continue;
        };
        let workspace_name = workspace_names[workspace_id];
        let run = process
            .terminal_id
            .as_deref()
            .and_then(|terminal| run_by_terminal.get(terminal).copied())
            .filter(|run| run.spec.workspace_id == workspace_id);
        if let Some(run) = run {
            linked_runs.insert(run.id.as_str());
        }
        let urls = service_urls(raw_by_pid.get(&process.pid), run);
        let managed = run.is_some_and(|run| {
            run.source == "operations" && run.terminal_id.as_deref() == Some(run.id.as_str())
        });
        let has_owned_terminal =
            run.is_some_and(|run| terminal_roots.contains_key(run.id.as_str()));
        let can_stop = managed && has_owned_terminal;
        let can_restart = managed
            && has_owned_terminal
            && run.is_some_and(|run| {
                run.spec
                    .command
                    .as_deref()
                    .is_some_and(|command| !command.trim().is_empty())
            });
        let action_reason = if can_stop && can_restart {
            None
        } else if !managed {
            Some(if process.terminal_id.is_some() {
                "Logs are available from its KalCode terminal. Stop and restart require an Operations-owned run."
                    .to_owned()
            } else {
                "Logs and process actions are unavailable because KalCode did not start this service."
                    .to_owned()
            })
        } else if !has_owned_terminal {
            Some(
                "KalCode cannot verify the owning terminal. Refresh before using process actions."
                    .to_owned(),
            )
        } else if !can_restart {
            Some("This run has no replayable owner-authored command.".to_owned())
        } else {
            Some(
                "The service is not running, but its Operations command can start it again."
                    .to_owned(),
            )
        };
        services.push(DevelopmentService {
            id: run.map_or_else(
                || {
                    format!(
                        "observed:{workspace_id}:{}:{}",
                        process.pid, process.start_time
                    )
                },
                |run| format!("{}:{}:{}", run.id, process.pid, process.start_time),
            ),
            run_id: run.map(|run| run.id.clone()),
            name: run.map_or_else(
                || format!("{workspace_name} · {}", display_process(&process.name)),
                |run| run.spec.name.clone(),
            ),
            status: "running".to_owned(),
            pid: Some(process.pid),
            process_name: process.name.clone(),
            uptime_seconds: uptimes.get(&process.pid).copied(),
            ports: process.ports.clone(),
            urls,
            workspace_id: workspace_id.to_owned(),
            workspace_name: workspace_name.to_owned(),
            terminal_id: process
                .terminal_id
                .clone()
                .filter(|id| retained_terminal_ids.contains(id)),
            can_stop,
            can_restart,
            action_reason,
        });
    }

    // A service-kind run remains understandable when it is a worker without a listening port, or
    // after it stops/fails. Unmanaged observations are intentionally not persisted as tombstones.
    for run in service_runs {
        if linked_runs.contains(run.id.as_str())
            || run.status == OperationStatus::Queued
            || !workspace_names.contains_key(run.spec.workspace_id.as_str())
        {
            continue;
        }
        let process = run
            .terminal_id
            .as_deref()
            .and_then(|terminal| terminal_roots.get(terminal).copied());
        let running = process.is_some()
            && matches!(
                run.status,
                OperationStatus::Starting
                    | OperationStatus::Running
                    | OperationStatus::Paused
                    | OperationStatus::Blocked
            );
        let status = if running {
            "running"
        } else if matches!(
            run.status,
            OperationStatus::Failed | OperationStatus::Interrupted
        ) {
            "failed"
        } else {
            "stopped"
        };
        let managed =
            run.source == "operations" && run.terminal_id.as_deref() == Some(run.id.as_str());
        let can_stop = managed && process.is_some();
        let can_restart = managed
            && run
                .spec
                .command
                .as_deref()
                .is_some_and(|command| !command.trim().is_empty());
        let action_reason = if can_stop && can_restart {
            None
        } else if !managed {
            Some("Stop and restart require an Operations-owned run.".to_owned())
        } else if !can_restart {
            Some("This run has no replayable owner-authored command.".to_owned())
        } else {
            Some(
                "The service is not running, but its Operations command can start it again."
                    .to_owned(),
            )
        };
        services.push(DevelopmentService {
            id: run.id.clone(),
            run_id: Some(run.id.clone()),
            name: run.spec.name.clone(),
            status: status.to_owned(),
            pid: process.map(|process| process.pid),
            process_name: process
                .map(|process| process.name.clone())
                .unwrap_or_else(|| "Operation service".to_owned()),
            uptime_seconds: process.and_then(|process| uptimes.get(&process.pid).copied()),
            ports: process
                .map(|process| process.ports.clone())
                .unwrap_or_default(),
            urls: run.spec.urls.clone(),
            workspace_id: run.spec.workspace_id.clone(),
            workspace_name: workspace_names[run.spec.workspace_id.as_str()].to_owned(),
            terminal_id: run
                .terminal_id
                .clone()
                .filter(|id| retained_terminal_ids.contains(id)),
            can_stop,
            can_restart,
            action_reason,
        });
    }

    services.sort_by(|left, right| {
        service_rank(&left.status)
            .cmp(&service_rank(&right.status))
            .then_with(|| left.workspace_name.cmp(&right.workspace_name))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
    services
}

fn current_service_runs(runs: &[OperationRecord]) -> Vec<&OperationRecord> {
    let mut current = HashMap::<(&str, &str, Option<&str>), &OperationRecord>::new();
    for run in runs.iter().filter(|run| {
        run.spec.kind == OperationKind::Service
            && run.status != OperationStatus::Queued
            && (run.started_at.is_some() || run.terminal_id.is_some())
    }) {
        let key = (
            run.spec.workspace_id.as_str(),
            run.spec.name.as_str(),
            run.spec.command.as_deref(),
        );
        current
            .entry(key)
            .and_modify(|selected| {
                if service_attempt_order(run) > service_attempt_order(selected) {
                    *selected = run;
                }
            })
            .or_insert(run);
    }
    current.into_values().collect()
}

fn service_attempt_order(run: &OperationRecord) -> (bool, &str, &str) {
    (
        matches!(
            run.status,
            OperationStatus::Starting
                | OperationStatus::Running
                | OperationStatus::Paused
                | OperationStatus::Blocked
        ),
        run.created_at.as_str(),
        run.id.as_str(),
    )
}

fn service_rank(status: &str) -> u8 {
    match status {
        "running" => 0,
        "failed" => 1,
        _ => 2,
    }
}

fn display_process(name: &str) -> String {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    let mut chars = stem.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_else(|| "Service".to_owned())
}

fn service_urls(raw: Option<&Vec<&RawPort>>, run: Option<&OperationRecord>) -> Vec<String> {
    let mut urls = run.map(|run| run.spec.urls.clone()).unwrap_or_default();
    for port in raw.into_iter().flatten() {
        if let Some(url) = observed_http_url(port)
            && !urls.contains(&url)
        {
            urls.push(url);
        }
    }
    urls
}

fn observed_http_url(port: &RawPort) -> Option<String> {
    // Port ownership proves a listener, not its application protocol. Only ports with a strong
    // browser-development convention get a suggested URL; every other listener still exposes its
    // exact port and linked Operations runs retain their explicitly declared URLs.
    const HTTP_DEV_PORTS: &[u16] = &[
        80, 3_000, 3_001, 4_000, 4_173, 4_200, 4_321, 5_000, 5_173, 5_174, 8_000, 8_001, 8_080,
        8_081, 8_888,
    ];
    const HTTPS_DEV_PORTS: &[u16] = &[443, 8_443];
    if port.protocol != TransportProtocol::Tcp
        || (!HTTP_DEV_PORTS.contains(&port.port) && !HTTPS_DEV_PORTS.contains(&port.port))
    {
        return None;
    }
    let address = port.local_address.split('%').next().unwrap_or("");
    let host = match address {
        "" | "*" | "0.0.0.0" | "::" | "localhost" => "localhost".to_owned(),
        address if address.starts_with("127.") || address == "::1" => "localhost".to_owned(),
        address if address.contains(':') => format!("[{address}]"),
        address => address.to_owned(),
    };
    let scheme = if HTTPS_DEV_PORTS.contains(&port.port) {
        "https"
    } else {
        "http"
    };
    Some(format!("{scheme}://{host}:{}/", port.port))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Killability, TransportProtocol};
    use kalcode_contracts::operations::{OperationEnvironmentKind, OperationLane, OperationSpec};
    use kalcode_contracts::resources::ProcessRole;

    fn workspace(id: &str) -> kalcode_core::workspaces::Workspace {
        kalcode_core::workspaces::Workspace {
            id: id.to_owned(),
            name: "shop".to_owned(),
            root_path: "/projects/shop".to_owned(),
            display_path: "/projects/shop".to_owned(),
            created_at: String::new(),
            last_opened_at: String::new(),
            active_terminal_id: None,
            available: true,
        }
    }

    fn process(
        pid: u32,
        name: &str,
        workspace_id: &str,
        terminal_id: Option<&str>,
        ports: Vec<u16>,
    ) -> ProcessInfo {
        ProcessInfo {
            pid,
            parent_pid: None,
            name: name.to_owned(),
            start_time: "42".to_owned(),
            cpu_percent: None,
            memory_bytes: 0,
            owner: terminal_id.map_or(ProcessOwner::CurrentUser, |_| ProcessOwner::KalCodeChild),
            role: terminal_id.map(|terminal_id| ProcessRole::Terminal {
                terminal_id: terminal_id.to_owned(),
            }),
            label: String::new(),
            workspace_id: Some(workspace_id.to_owned()),
            workspace_name: Some("shop".to_owned()),
            terminal_id: terminal_id.map(str::to_owned),
            terminal_generation: terminal_id.map(|_| 7),
            ports,
            killable: Killability::Confirm,
            can_restart: false,
        }
    }

    fn run(
        id: &str,
        workspace_id: &str,
        terminal_id: Option<&str>,
        status: OperationStatus,
    ) -> OperationRecord {
        OperationRecord {
            id: id.to_owned(),
            spec: OperationSpec {
                name: "Docs worker".to_owned(),
                workspace_id: workspace_id.to_owned(),
                kind: OperationKind::Service,
                command: Some("npm run docs".to_owned()),
                prompt: None,
                provider_id: None,
                provider_account_id: None,
                model: None,
                effort: None,
                dependencies: vec![],
                priority: 0,
                lane: OperationLane::Next,
                environment: OperationEnvironmentKind::Local,
                urls: vec![],
                env_keys: vec![],
            },
            source: "operations".to_owned(),
            status,
            workspace_name: "shop".to_owned(),
            branch: None,
            version: None,
            account_label: None,
            terminal_id: terminal_id.map(str::to_owned),
            thread_id: None,
            created_at: String::new(),
            started_at: Some(String::new()),
            ended_at: None,
            current_action: None,
            outcome: None,
            position: 0,
            blockers: vec![],
        }
    }

    fn raw(pid: u32, port: u16) -> RawPort {
        RawPort {
            protocol: TransportProtocol::Tcp,
            local_address: "127.0.0.1".to_owned(),
            port,
            pid: Some(pid),
            command: None,
        }
    }

    fn retained(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn projects_only_workspace_ports_and_keeps_external_actions_honest() {
        let processes = [
            process(10, "node.exe", "ws", None, vec![5_173]),
            process(11, "node.exe", "another", None, vec![3_000]),
            process(12, "node.exe", "ws", Some("terminal"), vec![8_080]),
        ];
        let services = project(
            &[workspace("ws")],
            &processes,
            &HashMap::from([(10, 12), (12, 8)]),
            &[raw(10, 5_173), raw(11, 3_000), raw(12, 8_080)],
            &[],
            &retained(&["terminal"]),
        );
        assert_eq!(services.len(), 2);
        let external = services
            .iter()
            .find(|service| service.pid == Some(10))
            .expect("external service");
        assert_eq!(external.ports, vec![5_173]);
        assert_eq!(external.urls, vec!["http://localhost:5173/"]);
        assert_eq!(external.uptime_seconds, Some(12));
        assert!(!external.can_stop);
        assert!(!external.can_restart);
        let terminal = services
            .iter()
            .find(|service| service.pid == Some(12))
            .expect("terminal service");
        assert!(!terminal.can_stop);
        assert!(!terminal.can_restart);
        assert!(
            terminal
                .action_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("Logs are available"))
        );
    }

    #[test]
    fn linked_worker_without_port_is_visible_and_replayable() {
        let process = process(20, "pwsh.exe", "ws", Some("terminal"), vec![]);
        let run = run("terminal", "ws", Some("terminal"), OperationStatus::Running);
        let services = project(
            &[workspace("ws")],
            &[process],
            &HashMap::from([(20, 30)]),
            &[],
            &[run],
            &retained(&["terminal"]),
        );
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].status, "running");
        assert!(services[0].ports.is_empty());
        assert!(services[0].can_stop);
        assert!(services[0].can_restart);
        assert_eq!(services[0].run_id.as_deref(), Some("terminal"));
    }

    #[test]
    fn linked_port_process_without_live_terminal_root_cannot_stop() {
        let mut descendant = process(21, "node.exe", "ws", Some("service"), vec![3_000]);
        descendant.terminal_generation = None;
        let run = run("service", "ws", Some("service"), OperationStatus::Running);
        let services = project(
            &[workspace("ws")],
            &[descendant],
            &HashMap::from([(21, 30)]),
            &[raw(21, 3_000)],
            &[run],
            &retained(&["service"]),
        );
        assert_eq!(services.len(), 1);
        assert!(!services[0].can_stop);
        assert!(!services[0].can_restart);
        assert!(
            services[0]
                .action_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("cannot verify the owning terminal"))
        );
    }

    #[test]
    fn failed_linked_run_is_retained_but_database_port_gets_no_fake_http_url() {
        let failed = run("failed", "ws", Some("failed"), OperationStatus::Failed);
        let postgres = process(30, "postgres.exe", "ws", None, vec![5_432]);
        let services = project(
            &[workspace("ws")],
            &[postgres],
            &HashMap::new(),
            &[raw(30, 5_432)],
            &[failed],
            &HashSet::new(),
        );
        assert_eq!(services.len(), 2);
        let failed_service = services
            .iter()
            .find(|service| service.status == "failed")
            .expect("failed service");
        assert!(failed_service.terminal_id.is_none());
        assert!(failed_service.can_restart);
        let database = services
            .iter()
            .find(|service| service.pid == Some(30))
            .expect("database service");
        assert!(database.urls.is_empty());
    }

    #[test]
    fn service_attempts_collapse_by_workspace_command_and_name_with_active_precedence() {
        let mut old = run("old", "ws", Some("old"), OperationStatus::Succeeded);
        old.created_at = "2026-01-01T00:00:00.000Z".to_owned();
        let mut newest = run("newest", "ws", Some("newest"), OperationStatus::Failed);
        newest.created_at = "2026-01-03T00:00:00.000Z".to_owned();
        let newest_only = [old.clone(), newest.clone()];
        let current = current_service_runs(&newest_only);
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].id, "newest");

        let mut active = run("active", "ws", Some("active"), OperationStatus::Running);
        active.created_at = "2026-01-02T00:00:00.000Z".to_owned();
        let mut separately_named = newest.clone();
        separately_named.id = "api".to_owned();
        separately_named.spec.name = "API".to_owned();
        let attempts = [old, newest, active, separately_named];
        let current = current_service_runs(&attempts);
        assert_eq!(current.len(), 2);
        assert!(current.iter().any(|run| run.id == "active"));
        assert!(current.iter().any(|run| run.id == "api"));
    }

    #[test]
    fn unknown_tcp_protocol_does_not_get_a_browser_url() {
        assert!(observed_http_url(&raw(40, 9_092)).is_none());
        assert_eq!(
            observed_http_url(&raw(41, 443)).as_deref(),
            Some("https://localhost:443/")
        );
    }

    #[test]
    fn port_observation_distinguishes_empty_success_from_unavailable_probe() {
        let (ports, complete) = port_observation(Ok((Vec::new(), "test")));
        assert!(ports.is_empty());
        assert!(complete);

        let (ports, complete) = port_observation(Err(kalcode_core::KalError::internal(
            "port_tool_unavailable",
            "unavailable in test",
        )));
        assert!(ports.is_empty());
        assert!(!complete);
    }
}
