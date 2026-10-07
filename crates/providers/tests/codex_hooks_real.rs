//! A REAL Codex pane reporting the shared agent states through Codex's own hooks. `#[ignore]`d:
//! it CONSUMES THE OWNER'S AI QUOTA (two short turns) and runs only with
//! `KALCODE_REAL_PROVIDER_SMOKE=1` and `KALCODE_HOOK_PROGRAM=<built kalcode-hook>`:
//!
//! ```text
//! cargo build -p kalcode-hook-bridge --bin kalcode-hook
//! KALCODE_REAL_PROVIDER_SMOKE=1 KALCODE_HOOK_PROGRAM=<target>/debug/kalcode-hook(.exe) \
//!   cargo test -p kalcode-providers --test codex_hooks_real -- --ignored --nocapture
//! ```
//!
//! It proves, against the installed codex-cli, that the `-c hooks.*` session overrides are trusted and
//! fire, asynchronously, in the interactive TUI: WORKING (UserPromptSubmit) → TESTING
//! (PreToolUse with a test command) → IDLE (Stop, completed once with `notify`), then NEEDS YOU on Codex's own approval prompt (PermissionRequest, for network
//! access the pane's sandbox lacks) that KalCode's hook never answers: nothing runs until the
//! person declines in the pane; declining interrupts the turn (Codex's Interrupt hook), and the
//! agent is IDLE again.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentProvider, SessionConfig};
use kalcode_contracts::agent_state::AgentState;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::DecisionRouting;
use kalcode_providers::interactive::cli_pane::{InteractiveCliProvider, PaneCli};
use kalcode_providers::interactive::provider::{InteractiveConfig, PaneRegistry};
use kalcode_providers::interactive::session::SessionLimits;

/// The shared state an event moves the agent to, as the runtime projects it.
fn state_of(event: &AgentEvent) -> Option<AgentState> {
    match event {
        AgentEvent::Status { status, detail } => {
            Some(AgentState::of_status(*status, detail.as_deref()))
        }
        AgentEvent::TurnCompleted { .. } => Some(AgentState::Idle),
        _ => None,
    }
}

struct Pane {
    rx: mpsc::Receiver<AgentEvent>,
    output: Arc<Mutex<Vec<u8>>>,
    panes: Arc<PaneRegistry>,
    thread: String,
    seen: Vec<AgentEvent>,
}

impl Pane {
    fn screen(&self) -> String {
        let bytes = self.output.lock().unwrap();
        // Text only: CSI/OSC sequences dropped, cursor moves as line breaks.
        let mut text = String::new();
        let mut chars = String::from_utf8_lossy(&bytes)
            .into_owned()
            .into_bytes()
            .into_iter();
        let mut raw = Vec::new();
        while let Some(byte) = chars.next() {
            if byte != 0x1b {
                raw.push(byte);
                continue;
            }
            match chars.next() {
                Some(b'[') => {
                    for next in chars.by_ref() {
                        if (0x40..=0x7e).contains(&next) {
                            if next == b'H' {
                                raw.push(b'\n');
                            }
                            break;
                        }
                    }
                }
                Some(b']') => {
                    let mut previous = 0;
                    for next in chars.by_ref() {
                        if next == 0x07 || (previous == 0x1b && next == b'\\') {
                            break;
                        }
                        previous = next;
                    }
                }
                _ => {}
            }
        }
        text.push_str(&String::from_utf8_lossy(&raw));
        text.chars()
            .rev()
            .take(3000)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    }

    /// Waits for an event matching `until`, recording everything seen.
    fn wait(&mut self, what: &str, within: Duration, until: impl Fn(&AgentEvent) -> bool) {
        let deadline = Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = self.rx.recv_timeout(left).unwrap_or_else(|_| {
                panic!(
                    "timed out waiting for {what}; events: {:#?}\npane tail:\n{}",
                    self.seen,
                    self.screen()
                )
            });
            eprintln!("event: {event:?} -> {:?}", state_of(&event));
            let done = until(&event);
            self.seen.push(event);
            if done {
                return;
            }
        }
    }

    fn type_line(&self, text: &str) {
        for bytes in [text.as_bytes(), b"\r".as_slice()] {
            if let Err(error) = self.panes.write(&self.thread, bytes) {
                panic!("typing failed: {error:?}\npane tail:\n{}", self.screen());
            }
            // Codex treats an Enter inside a fast paste burst as a newline.
            std::thread::sleep(Duration::from_millis(1200));
        }
    }
}

#[test]
#[ignore = "consumes AI quota; requires the owner's explicit approval"]
fn real_codex_pane_reports_shared_states_through_its_hooks() {
    if std::env::var_os("KALCODE_REAL_PROVIDER_SMOKE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_PROVIDER_SMOKE=1 to confirm quota use");
        return;
    }
    let helper =
        PathBuf::from(std::env::var_os("KALCODE_HOOK_PROGRAM").expect("KALCODE_HOOK_PROGRAM"));
    let root = tempfile::tempdir().expect("root");
    // Codex asks once whether to trust a new folder and saves the answer in the user's config,
    // exactly as in a native terminal. Point KALCODE_CODEX_TRUSTED_WORKDIR at a folder Codex
    // already trusts to run unattended; otherwise answer Codex's trust prompt in the pane.
    let work = match std::env::var_os("KALCODE_CODEX_TRUSTED_WORKDIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            let work = root.path().join("work");
            std::fs::create_dir_all(&work).unwrap();
            let _ = std::process::Command::new("git")
                .args(["init", "-q"])
                .current_dir(&work)
                .status();
            work
        }
    };
    let sessions = tempfile::tempdir().expect("sessions");
    let bridge = Arc::new(
        BridgeServer::start(ServerConfig::new(
            Endpoint::generate(None).expect("endpoint"),
        ))
        .expect("bridge"),
    );
    let panes = Arc::new(PaneRegistry::new());
    // This explicit hook certification waits for the optional read-only capability probe.
    // Ordinary first panes remain nonblocking and use notify while the probe warms.
    let detect_env = DetectEnv::from_process();
    let spec = kalcode_providers::catalog::codex_spec();
    let detected = kalcode_providers::launch_probe::detect_for_launch(&spec, &detect_env, None);
    let executable = detected.executable.expect("installed Codex executable");
    let version = detected
        .detection
        .version
        .as_deref()
        .and_then(kalcode_providers::version::Version::parse)
        .expect("installed Codex semantic version");
    assert_eq!(
        kalcode_providers::codex::hook_compatibility::probe_and_cache(
            &executable,
            &detect_env.provider_env(&spec.env_policy),
            Some(root.path()),
            None,
            Some(&version),
        ),
        kalcode_providers::codex::compatibility::CapabilitySupport::Supported,
        "the installed Codex must prove its observing-hook contract before this certification"
    );
    let provider = InteractiveCliProvider::new(
        PaneCli::Codex,
        detect_env,
        Some(bridge),
        InteractiveConfig {
            hook_program: helper,
            hook_prefix_args: Vec::new(),
            sessions_dir: sessions.path().to_path_buf(),
            routing: DecisionRouting::ProviderPrompt,
            limits: SessionLimits::default(),
        },
        panes.clone(),
    );
    let config = SessionConfig {
        thread_id: kalcode_contracts::ids::new_id(),
        workspace_id: kalcode_contracts::ids::new_id(),
        provider_account_id: None,
        working_directory: work.display().to_string(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
        launch_origin: Default::default(),
    };
    let thread = config.thread_id.clone();
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            config,
            Box::new(move |event: AgentEvent| {
                let _ = tx.send(event);
            }),
        )
        .expect("start");
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    let writer = panes.clone();
    let id = thread.clone();
    panes
        .attach(&thread, move |chunk| {
            sink.lock().unwrap().extend_from_slice(chunk);
            for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                let _ = writer.write(&id, b"\x1b[1;1R");
            }
            true
        })
        .expect("attach");
    let mut pane = Pane {
        rx,
        output,
        panes: panes.clone(),
        thread: thread.clone(),
        seen: Vec::new(),
    };

    // Turn 1: a test command. Codex may fire SessionStart at startup or with the first turn.
    std::thread::sleep(Duration::from_secs(10));
    pane.type_line(
        "Run exactly this one shell command and nothing else: cargo test --version . Whatever happens, do not retry it and do not request escalated permissions. Then reply with the single word DONE.",
    );
    pane.wait("turn 1 completion", Duration::from_secs(300), |event| {
        matches!(event, AgentEvent::TurnCompleted { .. })
    });
    let states: Vec<AgentState> = pane.seen.iter().filter_map(state_of).collect();
    eprintln!("turn 1 states: {states:?}");
    // READY comes from the runtime at spawn; Codex's own SessionStart fires lazily with the
    // first prompt, so the pane doesn't register it and no hook reports READY or IDLE first.
    assert_eq!(
        states.first(),
        Some(&AgentState::Working),
        "{:#?}",
        pane.seen
    );
    let working = states
        .iter()
        .position(|state| *state == AgentState::Working)
        .expect("UserPromptSubmit reported WORKING");
    let testing = states
        .iter()
        .position(|state| *state == AgentState::Testing)
        .expect("PreToolUse(cargo test) reported TESTING");
    assert!(working < testing);
    assert_eq!(states.last(), Some(&AgentState::Idle));

    // `notify` for the same turn must not complete it a second time.
    std::thread::sleep(Duration::from_secs(5));
    pane.seen.extend(pane.rx.try_iter());
    assert!(
        pane.seen
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolCompleted { .. })),
        "the tool call was closed (PostToolUse, or Stop when the sandbox could not start it)"
    );
    assert_eq!(
        pane.seen
            .iter()
            .filter(|event| matches!(event, AgentEvent::TurnCompleted { .. }))
            .count(),
        1,
        "one completion per turn: {:#?}",
        pane.seen
    );

    // Turn 2: network access needs Codex's own approval (the pane's sandbox has none).
    let before = pane.seen.len();
    pane.type_line(
        "Run this one shell command: curl.exe -sI https://example.com . It needs network access: if the sandbox blocks it, request escalated permissions for that same command. Then reply with the status code.",
    );
    pane.wait(
        "Codex's approval prompt (PermissionRequest)",
        Duration::from_secs(300),
        |event| {
            matches!(
                event,
                AgentEvent::Status { status: ThreadStatus::WaitingForUser, detail: Some(detail) }
                    if detail == "Answer in Codex"
            ) || matches!(event, AgentEvent::TurnCompleted { .. })
        },
    );
    let turn_two: Vec<AgentState> = pane.seen[before..].iter().filter_map(state_of).collect();
    eprintln!("turn 2 states: {turn_two:?}");
    assert_eq!(
        turn_two.first(),
        Some(&AgentState::Working),
        "turn 2 WORKING"
    );
    assert_eq!(
        turn_two.last(),
        Some(&AgentState::NeedsYou),
        "Codex asked (record it if it finished without asking): {:#?}",
        pane.seen
    );
    // KalCode's hook decided nothing: Codex keeps waiting for the person.
    std::thread::sleep(Duration::from_secs(8));
    let pending: Vec<AgentEvent> = pane.rx.try_iter().collect();
    assert!(
        !pending.iter().any(|event| matches!(
            event,
            AgentEvent::ToolStarted { .. }
                | AgentEvent::ToolCompleted { .. }
                | AgentEvent::TurnCompleted { .. }
        )),
        "nothing ran without an answer: {pending:#?}"
    );
    pane.seen.extend(pending);
    eprintln!("approval screen:\n{}", pane.screen());

    // Decline in Codex's own prompt. Codex interrupts the turn (its Interrupt hook; no Stop, no
    // `notify`), and the agent is IDLE again without a completed turn.
    panes.write(&thread, b"\x1b").expect("decline");
    pane.wait("Interrupt → IDLE", Duration::from_secs(120), |event| {
        matches!(
            event,
            AgentEvent::Status {
                status: ThreadStatus::Idle,
                ..
            }
        )
    });
    let after: Vec<AgentState> = pane.seen[before..].iter().filter_map(state_of).collect();
    eprintln!("turn 2 states after declining: {after:?}");
    assert_eq!(after.last(), Some(&AgentState::Idle));
    assert!(
        pane.seen[before..]
            .iter()
            .any(|event| matches!(event, AgentEvent::ToolCompleted { ok: false, summary: Some(s), .. } if s == "Interrupted")),
        "the declined call is closed"
    );
    assert!(
        !pane.seen[before..]
            .iter()
            .any(|event| matches!(event, AgentEvent::TurnCompleted { .. })),
        "an interrupted turn is not a completed one"
    );

    // Turn 3: the same request, approved in Codex's prompt. NEEDS YOU lasts until the approved
    // command has run (its PostToolUse), then WORKING, then IDLE.
    let before = pane.seen.len();
    pane.type_line(
        "Run this one shell command: curl.exe -sI https://example.com . It needs network access: if the sandbox blocks it, request escalated permissions for that same command. Then reply with the status code.",
    );
    pane.wait(
        "turn 3 approval prompt",
        Duration::from_secs(300),
        |event| {
            matches!(
                event,
                AgentEvent::Status {
                    status: ThreadStatus::WaitingForUser,
                    ..
                }
            ) || matches!(event, AgentEvent::TurnCompleted { .. })
        },
    );
    std::thread::sleep(Duration::from_secs(2));
    let approved = Instant::now();
    panes.write(&thread, b"\r").expect("approve");
    pane.wait(
        "WORKING after approval",
        Duration::from_secs(120),
        |event| {
            matches!(
                event,
                AgentEvent::Status {
                    status: ThreadStatus::Active,
                    ..
                }
            )
        },
    );
    let back_to_work = approved.elapsed();
    pane.wait("turn 3 completion", Duration::from_secs(240), |event| {
        matches!(event, AgentEvent::TurnCompleted { .. })
    });
    let turn_three: Vec<AgentState> = pane.seen[before..].iter().filter_map(state_of).collect();
    eprintln!("turn 3 states: {turn_three:?}; WORKING {back_to_work:?} after approving");
    let needs_you = turn_three
        .iter()
        .position(|state| *state == AgentState::NeedsYou)
        .expect("NEEDS YOU on Codex's prompt");
    assert!(turn_three[needs_you..].contains(&AgentState::Working));
    assert_eq!(turn_three.last(), Some(&AgentState::Idle));
    session.terminate().expect("terminate");
}

/// Records when each Codex hook reached KalCode.
struct Arrivals(Mutex<Vec<(Instant, kalcode_hook_bridge::HookEvent)>>);

impl kalcode_hook_bridge::server::HookHandler for Arrivals {
    fn handle(&self, record: kalcode_hook_bridge::HookRecord) -> kalcode_hook_bridge::HookReply {
        if let Some(event) = record.event {
            self.0.lock().unwrap().push((Instant::now(), event));
        }
        kalcode_hook_bridge::HookReply::Ack
    }
}

/// The cost of KalCode's Codex hooks on an identical five-command turn (`codex exec`, the same
/// session-flag hooks a pane passes, a live bridge), against Codex without them. Consumes quota:
/// `KALCODE_REAL_PROVIDER_SMOKE=1`, `KALCODE_HOOK_PROGRAM`, `KALCODE_CODEX_EXE` (the native
/// codex binary) and `KALCODE_CODEX_TRUSTED_WORKDIR`; `KALCODE_HOOK_BENCH_RUNS` (default 3).
#[test]
#[ignore = "consumes AI quota; requires the owner's explicit approval"]
fn real_codex_hook_overhead() {
    use kalcode_hook_bridge::HookEvent;
    use kalcode_hook_bridge::codex::{HookRun, session_overrides_with};
    if std::env::var_os("KALCODE_REAL_PROVIDER_SMOKE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_PROVIDER_SMOKE=1 to confirm quota use");
        return;
    }
    let helper = std::env::var("KALCODE_HOOK_PROGRAM").expect("KALCODE_HOOK_PROGRAM");
    let codex = std::env::var("KALCODE_CODEX_EXE").expect("KALCODE_CODEX_EXE");
    let work = std::env::var("KALCODE_CODEX_TRUSTED_WORKDIR").expect("trusted workdir");
    let runs: usize = std::env::var("KALCODE_HOOK_BENCH_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let bridge = BridgeServer::start(ServerConfig::new(
        Endpoint::generate(None).expect("endpoint"),
    ))
    .expect("bridge");
    let prompt = "Run these five shell commands one at a time, each as its own separate tool \
                  call, in order: echo one ; echo two ; echo three ; echo four ; echo five . Do \
                  not combine them. Then reply DONE.";
    type Plan = fn(HookEvent) -> Option<HookRun>;
    let variants: [(&str, Option<Plan>); 3] = [
        ("notify-only", None),
        // Every hook synchronous: Codex waits for each one (the first wiring).
        (
            "sync",
            Some(|event| (event != HookEvent::SessionStart).then_some(HookRun::Sync)),
        ),
        // What panes pass.
        ("pane", Some(kalcode_hook_bridge::codex::pane_plan)),
    ];
    let mut walls: Vec<Vec<f64>> = vec![Vec::new(); variants.len()];
    for round in 0..runs {
        for (index, (name, plan)) in variants.iter().enumerate() {
            if std::env::var("KALCODE_HOOK_BENCH_ONLY")
                .is_ok_and(|only| !only.split(',').any(|v| v == *name))
            {
                continue;
            }
            let arrivals = Arc::new(Arrivals(Mutex::new(Vec::new())));
            let registration = bridge
                .register_channel(
                    arrivals.clone(),
                    kalcode_hook_bridge::server::HookChannel::Codex,
                )
                .expect("register");
            let mut command = std::process::Command::new(&codex);
            command
                .args(["exec", "--json", "--skip-git-repo-check", "-s", "read-only"])
                .args(["-c", "model_reasoning_effort='low'"])
                .env(kalcode_hook_bridge::KEY_ENV, registration.key_hex())
                .current_dir(&work)
                .stdin(std::process::Stdio::null());
            match plan {
                None => {
                    command.args(["-c", "features.hooks=false"]);
                }
                Some(plan) => {
                    command.args(["-c", "features.hooks=true"]);
                    for value in session_overrides_with(
                        &helper,
                        &[],
                        bridge.endpoint().as_str(),
                        registration.session_id(),
                        plan,
                    )
                    .expect("overrides")
                    {
                        command.args(["-c", &value]);
                    }
                }
            }
            command.arg(prompt);
            let started = Instant::now();
            let output = command.output().expect("codex exec");
            let wall = started.elapsed().as_secs_f64();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let tools = stdout
                .lines()
                .filter(|line| {
                    line.contains("\"item.completed\"") && line.contains("\"command_execution\"")
                })
                .count();
            let seen: Vec<String> = arrivals
                .0
                .lock()
                .unwrap()
                .iter()
                .map(|(at, event)| {
                    format!("{:.2}s {}", (*at - started).as_secs_f64(), event.as_str())
                })
                .collect();
            let gaps: Vec<f64> = {
                let arrived = arrivals.0.lock().unwrap();
                arrived
                    .windows(2)
                    .filter(|pair| {
                        pair[0].1 == HookEvent::PreToolUse && pair[1].1 == HookEvent::PostToolUse
                    })
                    .map(|pair| (pair[1].0 - pair[0].0).as_secs_f64())
                    .collect()
            };
            eprintln!(
                "round {round} {name}: wall {wall:.2}s, {tools} commands, Pre→Post gaps {gaps:.2?}, hooks: {seen:?}"
            );
            if std::env::var_os("KALCODE_HOOK_BENCH_DUMP").is_some() {
                for line in stdout.lines().filter(|line| line.contains("hook")) {
                    eprintln!("  {}", line.chars().take(400).collect::<String>());
                }
            }
            assert!(
                output.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            walls[index].push(wall);
        }
    }
    for ((name, _), mut samples) in variants.iter().zip(walls) {
        if samples.is_empty() {
            continue;
        }
        samples.sort_by(f64::total_cmp);
        eprintln!(
            "{name}: p50 {:.2}s of {samples:?}",
            samples[samples.len() / 2]
        );
    }
}
