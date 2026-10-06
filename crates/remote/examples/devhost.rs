//! A standalone fake workstation for KalCode Remote mobile development.
//!
//! ```text
//! cargo run -p kalcode-remote --example devhost -- --data <dir> [--agents 6] [--port 47820]
//!     [--name "Dev Workstation"] [--addr ip:port]... [--bind 127.0.0.1] [--revoke-all] [--light-terminal]
//! ```
//!
//! DEV ONLY. The host key sits in a plain file (`<data>/host-key.b64`), not the OS secret
//! store, so never use this as a real workstation. It binds `127.0.0.1` unless `--bind` says
//! otherwise (`--bind 0.0.0.0` to reach it from a phone on the LAN).
//!
//! Serves the real protocol (Noise IK, pairing, registry, patches, requests, notify) over a
//! synthetic workstation whose agents keep changing state. The host key, workstation id and
//! device registry persist in `--data`, so a paired phone reconnects across restarts. The
//! pairing link is printed with a QR code and written to `<data>/pairing-link.txt`, which is
//! deleted once the code is redeemed.
//!
//! Commands on stdin: `pair` (new pairing window), `devices`, `revoke <deviceId>`,
//! `revoke-all`, `quit`.

use std::error::Error as StdError;
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use kalcode_remote::noise::StaticKeypair;
use kalcode_remote::ops::{self, Op};
use kalcode_remote::pairing::Pairing;
use kalcode_remote::registry::{Device, Registry};
use kalcode_remote::server::{self, HostIdentity, Hub, RemoteHost};
use kalcode_remote::wire::{
    AgentRuntime, AgentState, ByeReason, HostBuild, NeedsYouAction, NeedsYouItem, NeedsYouKind,
    Notification, NotifyKind, RemoteAgent, RemoteEnvironment, RemoteError, RemoteRun,
    RemoteService, RemoteState, RemoteWorkspace, Workstation, link,
};
use kalcode_remote::{DEFAULT_PORT, random_id};
use serde_json::Value;
use time::OffsetDateTime;
use tokio::io::AsyncBufReadExt;
use tokio::net::TcpListener;

type BoxError = Box<dyn StdError + Send + Sync>;

struct Args {
    data: PathBuf,
    agents: usize,
    port: u16,
    bind: String,
    name: String,
    addrs: Vec<String>,
    revoke_all: bool,
    light_terminal: bool,
}

fn parse_args() -> Result<Args, BoxError> {
    let mut args = Args {
        data: PathBuf::new(),
        agents: 6,
        port: DEFAULT_PORT,
        bind: "127.0.0.1".into(),
        name: "Dev Workstation".into(),
        addrs: Vec::new(),
        revoke_all: false,
        light_terminal: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--data" => args.data = PathBuf::from(value()?),
            "--agents" => args.agents = value()?.parse()?,
            "--port" => args.port = value()?.parse()?,
            "--name" => args.name = value()?,
            "--bind" => args.bind = value()?,
            "--addr" => args.addrs.push(value()?),
            "--revoke-all" => args.revoke_all = true,
            "--light-terminal" => args.light_terminal = true,
            "-h" | "--help" => {
                println!(
                    "devhost --data <dir> [--agents N] [--port P] [--name NAME] [--addr ip:port]... [--bind IP] [--revoke-all] [--light-terminal]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    if args.data.as_os_str().is_empty() {
        return Err("--data <dir> is required".into());
    }
    Ok(args)
}

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let args = parse_args()?;
    std::fs::create_dir_all(&args.data)?;
    const BANNER: [&str; 5] = [
        "************************************************************************",
        "*  DEV ONLY - insecure key storage, not for production.                *",
        "*  The host key is a plain file in --data; anyone who can read it can  *",
        "*  impersonate this workstation.                                       *",
        "************************************************************************",
    ];
    eprintln!();
    for line in BANNER {
        eprintln!("{line}");
    }
    eprintln!();

    let key = load_or_create_key(&args.data.join("host-key.b64"))?;
    let workstation_id = load_or_create(&args.data.join("workstation-id.txt"), || {
        Ok(random_id("ws_")?)
    })?;
    let identity = HostIdentity {
        key,
        workstation_id: workstation_id.clone(),
        name: args.name.clone(),
        build: HostBuild {
            platform: std::env::consts::OS.into(),
            version: "0.1.9".into(),
            build: 2007,
        },
    };
    let registry = Arc::new(Registry::open(args.data.join("remote-devices.json"))?);
    if args.revoke_all {
        revoke_all(&registry)?;
    }
    let pairing = Arc::new(Pairing::new());
    let hub = Hub::new();

    let listener = TcpListener::bind((args.bind.as_str(), args.port)).await?;
    let port = listener.local_addr()?.port();
    let mut addrs = args.addrs.clone();
    if addrs.is_empty() {
        if let Some(lan) = lan_ipv4().filter(|_| args.bind != "127.0.0.1") {
            addrs.push(format!("{lan}:{port}"));
        }
        addrs.push(format!("127.0.0.1:{port}"));
    }

    let sim = Arc::new(DevHost {
        sim: Mutex::new(Sim::new(&identity, args.agents)),
        hub: hub.clone(),
    });
    println!(
        "KalCode Remote dev host \"{}\" ({workstation_id}) listening on {}:{port}",
        args.name, args.bind
    );
    println!("{} agents; data in {}", args.agents, args.data.display());
    show_pairing(&pairing, &identity, &addrs, &args)?;
    println!("Commands: pair | devices | revoke <deviceId> | revoke-all | quit");

    // State churn so devices see patches and notifications.
    {
        let sim = sim.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_millis(2500));
            every.tick().await;
            loop {
                every.tick().await;
                let notes = sim.lock().tick();
                sim.hub.state_changed();
                for (note, agent) in notes {
                    sim.hub.notify(note, agent.as_deref());
                }
            }
        });
    }

    let link_path = args.data.join("pairing-link.txt");

    // Operator commands.
    {
        let (pairing, identity, registry, hub, addrs) = (
            pairing.clone(),
            identity.clone(),
            registry.clone(),
            hub.clone(),
            addrs.clone(),
        );
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let words: Vec<&str> = line.split_whitespace().collect();
                let outcome: Result<(), BoxError> = match words.as_slice() {
                    ["pair"] => show_pairing(&pairing, &identity, &addrs, &args),
                    ["devices"] => {
                        list_devices(&registry);
                        Ok(())
                    }
                    ["revoke", id] => registry
                        .revoke(id)
                        .map(|done| {
                            println!(
                                "{}",
                                if done {
                                    format!("revoked {id}")
                                } else {
                                    format!("no active device {id}")
                                }
                            );
                        })
                        .map_err(Into::into),
                    ["revoke-all"] => revoke_all(&registry),
                    ["quit"] | ["exit"] => {
                        hub.close_all(ByeReason::Shutdown);
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        std::process::exit(0);
                    }
                    [] => Ok(()),
                    _ => {
                        println!(
                            "Commands: pair | devices | revoke <deviceId> | revoke-all | quit"
                        );
                        Ok(())
                    }
                };
                if let Err(error) = outcome {
                    println!("error: {error}");
                }
            }
        });
    }

    loop {
        let (tcp, peer) = listener.accept().await?;
        // Admission before reading a byte; over the limit the socket is just dropped.
        let Some(permit) = hub.admit(peer.ip()) else {
            println!("x dropped {peer}: too many handshakes in progress");
            continue;
        };
        let _ = tcp.set_nodelay(true);
        let (identity, registry, pairing, hub, sim, link_path) = (
            identity.clone(),
            registry.clone(),
            pairing.clone(),
            hub.clone(),
            sim.clone(),
            link_path.clone(),
        );
        tokio::spawn(async move {
            let accepted = server::accept(tcp, &identity, &registry, &pairing, true).await;
            drop(permit);
            match accepted {
                Ok(conn) => {
                    if !pairing.is_open() && std::fs::remove_file(&link_path).is_ok() {
                        println!("pairing link redeemed; removed {}", link_path.display());
                    }
                    let device = conn.device.clone();
                    println!(
                        "+ {} ({}, {}) connected from {peer}",
                        device.name, device.id, device.platform
                    );
                    let outcome = server::serve_connection(conn, sim, &hub, &registry).await;
                    println!(
                        "- {} ({}) disconnected: {outcome:?}",
                        device.name, device.id
                    );
                }
                Err(error) => println!("x handshake from {peer} failed: {error}"),
            }
        });
    }
}

fn show_pairing(
    pairing: &Pairing,
    identity: &HostIdentity,
    addrs: &[String],
    args: &Args,
) -> Result<(), BoxError> {
    let ticket = pairing.open()?;
    let payload = ticket.payload(
        &identity.workstation_id,
        &identity.name,
        &identity.key,
        addrs.to_vec(),
    );
    let link = payload.to_link()?;
    std::fs::write(args.data.join("pairing-link.txt"), &link)?;
    let code = qrcode::QrCode::new(link.as_bytes())?;
    use qrcode::render::unicode::Dense1x2;
    let (dark, light) = if args.light_terminal {
        (Dense1x2::Dark, Dense1x2::Light)
    } else {
        (Dense1x2::Light, Dense1x2::Dark)
    };
    let image = code
        .render::<Dense1x2>()
        .dark_color(dark)
        .light_color(light)
        .quiet_zone(true)
        .build();
    println!(
        "\n{image}\nPairing link (valid 5 minutes, single use; addresses {}):\n{link}\n",
        addrs.join(", ")
    );
    Ok(())
}

fn list_devices(registry: &Registry) {
    let devices = registry.list();
    if devices.is_empty() {
        println!("no paired devices");
    }
    for d in devices {
        println!(
            "{}  {:<24} {:<8} {:<12} {}{}",
            d.id,
            d.name,
            d.platform,
            d.model,
            d.last_seen_at
                .map(|t| format!("seen {t}"))
                .unwrap_or_default(),
            if d.revoked { "  REVOKED" } else { "" }
        );
    }
}

fn revoke_all(registry: &Registry) -> Result<(), BoxError> {
    let mut count = 0;
    for device in registry.list() {
        if registry.revoke(&device.id)? {
            count += 1;
        }
    }
    println!("revoked {count} device(s)");
    Ok(())
}

fn load_or_create(
    path: &Path,
    create: impl FnOnce() -> Result<String, BoxError>,
) -> Result<String, BoxError> {
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(value.trim().to_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let value = create()?;
            std::fs::write(path, &value)?;
            Ok(value)
        }
        Err(e) => Err(e.into()),
    }
}

/// Dev only: the desktop keeps this in the OS secret store (`remote:host-key`).
fn load_or_create_key(path: &Path) -> Result<StaticKeypair, BoxError> {
    let encoded = load_or_create(path, || {
        Ok(StaticKeypair::generate()?.private_base64().to_string())
    })?;
    Ok(StaticKeypair::from_private_base64(&encoded)?)
}

/// The primary LAN address (no packet is sent).
fn lan_ipv4() -> Option<std::net::IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(SocketAddr::from(([192, 0, 2, 1], 9))).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

// ---------------------------------------------------------------------------------------------
// The synthetic workstation
// ---------------------------------------------------------------------------------------------

struct DevHost {
    sim: Mutex<Sim>,
    hub: Hub,
}

impl DevHost {
    fn lock(&self) -> MutexGuard<'_, Sim> {
        self.sim.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl RemoteHost for DevHost {
    fn snapshot(&self) -> RemoteState {
        self.lock().state()
    }

    async fn handle(&self, device: &Device, op: &str, args: Value) -> Result<Value, RemoteError> {
        println!("  {} -> {op} {args}", device.name);
        let op = Op::parse(op, args)?;
        // A touch of latency, like the real desktop.
        tokio::time::sleep(Duration::from_millis(120)).await;
        let (result, notes) = {
            let mut sim = self.lock();
            let result = sim.run(op)?;
            (result, std::mem::take(&mut sim.pending_notes))
        };
        self.hub.state_changed();
        for (note, agent) in notes {
            self.hub.notify(note, agent.as_deref());
        }
        Ok(result)
    }
}

/// (provider id, provider name, [(model id, model name)]).
type Provider = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const PROVIDERS: [Provider; 3] = [
    (
        "claude-code",
        "Claude Code",
        &[
            ("claude-opus-5-5", "Claude Opus 5.5"),
            ("claude-sonnet-5", "Claude Sonnet 5"),
        ],
    ),
    (
        "codex",
        "Codex",
        &[
            ("gpt-5.5-codex", "GPT-5.5 Codex"),
            ("gpt-5.5-mini", "GPT-5.5 mini"),
        ],
    ),
    (
        "gemini",
        "Gemini",
        &[
            ("gemini-3-pro", "Gemini 3 Pro"),
            ("gemini-3-flash", "Gemini 3 Flash"),
        ],
    ),
];

const TASKS: [&str; 16] = [
    "Fix login redirect",
    "Add dark mode toggle",
    "Refactor billing service",
    "Write checkout e2e tests",
    "Speed up cold start",
    "Migrate settings to SQLite",
    "Fix flaky diff test",
    "Add CSV export",
    "Audit API rate limits",
    "Polish onboarding copy",
    "Upgrade tokio",
    "Fix Android back gesture",
    "Cache provider catalog",
    "Add retry to uploads",
    "Trim release bundle",
    "Document Remote protocol",
];

const ACTIVITIES: [&str; 10] = [
    "Reading crates/git/src/diff.rs",
    "Editing src/auth/redirect.ts",
    "Running npm test",
    "Searching for usages of SessionStore",
    "Editing apps/desktop/src/settings.tsx",
    "Running cargo check",
    "Reviewing the failing assertion",
    "Writing tests for the new path",
    "Updating snapshots",
    "Summarizing changes",
];

const COMMANDS: [&str; 5] = [
    "cargo test -p git",
    "npm run lint -- --fix",
    "git push origin HEAD",
    "pnpm install",
    "rm -rf node_modules/.cache",
];

struct Sim {
    rng: u64,
    serial: u64,
    workstation: Workstation,
    workspaces: Vec<RemoteWorkspace>,
    agents: Vec<RemoteAgent>,
    needs: Vec<NeedsYouItem>,
    runs: Vec<RemoteRun>,
    services: Vec<RemoteService>,
    environments: Vec<RemoteEnvironment>,
    pending_notes: Vec<(Notification, Option<String>)>,
}

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

impl Sim {
    fn new(identity: &HostIdentity, count: usize) -> Self {
        let at = now();
        let workspaces: Vec<RemoteWorkspace> = [
            ("KalCode", "C:/Users/dev/KalCode"),
            ("website", "C:/Users/dev/website"),
            ("mobile", "C:/Users/dev/mobile"),
        ]
        .iter()
        .enumerate()
        .map(|(i, (name, path))| RemoteWorkspace {
            id: format!("wsp_{name}"),
            name: (*name).into(),
            path: (*path).into(),
            last_active_at: Some(at - time::Duration::minutes(i as i64 * 7)),
        })
        .collect();
        let mut sim = Self {
            rng: 0x9e37_79b9_7f4a_7c15,
            serial: 0,
            workstation: Workstation {
                id: identity.workstation_id.clone(),
                name: identity.name.clone(),
                platform: identity.build.platform.clone(),
                version: identity.build.version.clone(),
                build: identity.build.build,
                active_workspace_id: Some(workspaces[0].id.clone()),
            },
            workspaces,
            agents: Vec::new(),
            needs: Vec::new(),
            runs: Vec::new(),
            services: vec![
                RemoteService {
                    id: "svc_web".into(),
                    name: "web".into(),
                    status: "running".into(),
                    url: Some("http://localhost:5173".into()),
                },
                RemoteService {
                    id: "svc_api".into(),
                    name: "api".into(),
                    status: "running".into(),
                    url: Some("http://localhost:8080".into()),
                },
                RemoteService {
                    id: "svc_worker".into(),
                    name: "worker".into(),
                    status: "stopped".into(),
                    url: None,
                },
            ],
            environments: vec![
                RemoteEnvironment {
                    id: "env_prod".into(),
                    name: "Production".into(),
                    kind: "production".into(),
                    deployment_status: "deployed".into(),
                    health: Some("healthy".into()),
                    url: Some("https://kalcoded.com".into()),
                    last_deploy_at: Some(at - time::Duration::hours(5)),
                },
                RemoteEnvironment {
                    id: "env_staging".into(),
                    name: "Staging".into(),
                    kind: "staging".into(),
                    deployment_status: "deployed".into(),
                    health: Some("healthy".into()),
                    url: Some("https://staging.kalcoded.com".into()),
                    last_deploy_at: Some(at - time::Duration::minutes(40)),
                },
            ],
            pending_notes: Vec::new(),
        };
        let initial = [
            AgentState::Working,
            AgentState::NeedsYou,
            AgentState::Testing,
            AgentState::Idle,
            AgentState::Working,
            AgentState::Failed,
            AgentState::Done,
            AgentState::Waiting,
            AgentState::Ready,
            AgentState::Starting,
        ];
        for i in 0..count {
            let (provider_id, _, models) = PROVIDERS[i % PROVIDERS.len()];
            let workspace = sim.workspaces[i % sim.workspaces.len()].clone();
            let mut name = TASKS[i % TASKS.len()].to_owned();
            if i >= TASKS.len() {
                name.push_str(&format!(" #{}", i / TASKS.len() + 1));
            }
            let id = sim.add_agent(&workspace, provider_id, models[i % models.len()].0, &name);
            let state = initial[i % initial.len()];
            sim.set_state(&id, state, false);
        }
        sim.runs = vec![
            RemoteRun {
                id: "op_nightly".into(),
                title: "Nightly tests".into(),
                kind: "test".into(),
                status: "running".into(),
                agent_id: None,
                branch: Some("main".into()),
                current_action: Some("cargo test -p git".into()),
                outcome: None,
                updated_at: at,
            },
            RemoteRun {
                id: "op_deploy_web".into(),
                title: "Deploy website to staging".into(),
                kind: "deploy".into(),
                status: "succeeded".into(),
                agent_id: None,
                branch: Some("main".into()),
                current_action: None,
                outcome: Some("Deployed 41a9c2e".into()),
                updated_at: at - time::Duration::minutes(40),
            },
        ];
        sim
    }

    fn rand(&mut self, n: usize) -> usize {
        // xorshift64*
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        (self.rng.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 33) as usize % n.max(1)
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.rand(100) < percent
    }

    fn next_serial(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    fn state(&self) -> RemoteState {
        RemoteState {
            workstation: self.workstation.clone(),
            workspaces: self.workspaces.clone(),
            agents: self.agents.clone(),
            needs_you: self.needs.clone(),
            runs: self.runs.clone(),
            services: self.services.clone(),
            environments: self.environments.clone(),
        }
    }

    fn add_agent(
        &mut self,
        workspace: &RemoteWorkspace,
        provider_id: &str,
        model: &str,
        name: &str,
    ) -> String {
        let serial = self.next_serial();
        let (_, provider_name, _) = PROVIDERS
            .iter()
            .find(|p| p.0 == provider_id)
            .copied()
            .unwrap_or(PROVIDERS[0]);
        let id = format!("thr_{serial:04}");
        let created = now() - time::Duration::minutes(self.rand(180) as i64);
        let worktree = self.chance(60);
        let effort = if provider_id == "gemini" {
            None
        } else {
            Some(["low", "medium", "high"][self.rand(3)].to_owned())
        };
        let account = if self.chance(50) { "Work" } else { "Personal" };
        let runtime = if self.chance(80) {
            AgentRuntime::Pane
        } else {
            AgentRuntime::Headless
        };
        self.agents.push(RemoteAgent {
            id: id.clone(),
            name: name.to_owned(),
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
            provider_id: provider_id.to_owned(),
            provider_name: provider_name.to_owned(),
            account_label: Some(account.into()),
            model: Some(model.to_owned()),
            effort,
            state: AgentState::Starting,
            status: "starting".into(),
            activity: None,
            branch: worktree.then(|| format!("kal/{}", slug(name))),
            worktree,
            files_changed: 0,
            pending_approvals: 0,
            error: None,
            created_at: created,
            last_activity_at: created,
            runtime,
        });
        id
    }

    fn agent_index(&self, id: &str) -> Result<usize, RemoteError> {
        self.agents
            .iter()
            .position(|a| a.id == id)
            .ok_or_else(|| RemoteError::not_found("This agent has ended"))
    }

    /// Moves an agent to `state`, keeping needs-you items and notifications consistent.
    fn set_state(&mut self, id: &str, state: AgentState, notify: bool) {
        let Ok(i) = self.agent_index(id) else { return };
        let activity = match state {
            AgentState::Working => Some(ACTIVITIES[self.rand(ACTIVITIES.len())].to_owned()),
            AgentState::Testing => Some("Running the test suite".to_owned()),
            AgentState::Waiting => Some("Waiting for the build lock".to_owned()),
            AgentState::Starting => Some("Starting".to_owned()),
            _ => None,
        };
        let files = self.rand(4) as u32;
        let command = COMMANDS[self.rand(COMMANDS.len())];
        let at = now();
        let agent = &mut self.agents[i];
        let previous = agent.state;
        agent.state = state;
        agent.status = match state {
            AgentState::Working => "running_tool",
            AgentState::Testing => "running_command",
            AgentState::Waiting => "waiting",
            AgentState::NeedsYou => "awaiting_approval",
            AgentState::Idle | AgentState::Ready => "idle",
            AgentState::Done => "completed",
            AgentState::Failed => "failed",
            AgentState::Stopped => "stopped",
            AgentState::Starting => "starting",
        }
        .into();
        agent.activity = activity;
        agent.last_activity_at = at;
        if matches!(state, AgentState::Working | AgentState::Testing) {
            agent.files_changed += files;
        }
        agent.error = (state == AgentState::Failed).then(|| {
            "Tests failed: 2 of 148 (auth::redirect_keeps_query, auth::expired_session)".to_owned()
        });
        agent.pending_approvals = u32::from(state == AgentState::NeedsYou);
        let (agent_id, agent_name, workspace, provider) = (
            agent.id.clone(),
            agent.name.clone(),
            agent.workspace_name.clone(),
            agent.provider_name.clone(),
        );

        if previous == AgentState::NeedsYou && state != AgentState::NeedsYou {
            self.needs.retain(|n| {
                n.agent_id.as_deref() != Some(&agent_id) || n.kind != NeedsYouKind::Approval
            });
        }
        if state != AgentState::Failed {
            self.needs.retain(|n| {
                n.agent_id.as_deref() != Some(&agent_id) || n.kind != NeedsYouKind::Failed
            });
        }
        match state {
            AgentState::NeedsYou if previous != AgentState::NeedsYou => {
                let approval = format!("apr_{:04}", self.next_serial());
                let item = NeedsYouItem {
                    id: format!("approval:{approval}"),
                    kind: NeedsYouKind::Approval,
                    title: format!("Run `{command}`?"),
                    detail: format!("{provider} wants to run a command in {workspace}"),
                    agent_id: Some(agent_id.clone()),
                    approval_id: Some(approval),
                    created_at: at,
                    actions: vec![
                        NeedsYouAction::ApproveOnce,
                        NeedsYouAction::Deny,
                        NeedsYouAction::Open,
                    ],
                };
                if notify {
                    self.note(
                        NotifyKind::NeedsYou,
                        &agent_id,
                        format!("{agent_name} needs you"),
                        item.title.clone(),
                        link::needs(&item.id),
                    );
                }
                self.needs.push(item);
            }
            AgentState::Failed if previous != AgentState::Failed => {
                let item = NeedsYouItem {
                    id: format!("failed:{agent_id}"),
                    kind: NeedsYouKind::Failed,
                    title: format!("{agent_name} failed"),
                    detail: "2 tests failed after the last change".into(),
                    agent_id: Some(agent_id.clone()),
                    approval_id: None,
                    created_at: at,
                    actions: vec![NeedsYouAction::Open],
                };
                self.needs.push(item);
                if notify {
                    self.note(
                        NotifyKind::AgentFailed,
                        &agent_id,
                        format!("{agent_name} failed"),
                        "2 of 148 tests failed".into(),
                        link::agent(&agent_id),
                    );
                }
            }
            AgentState::Done if previous != AgentState::Done && notify => {
                self.note(
                    NotifyKind::AgentDone,
                    &agent_id,
                    format!("{agent_name} finished"),
                    format!("{files} files changed, tests passing"),
                    link::agent(&agent_id),
                );
            }
            _ => {}
        }
    }

    fn note(
        &mut self,
        kind: NotifyKind,
        agent_id: &str,
        title: String,
        body: String,
        link: String,
    ) {
        let id = format!("ntf_{:05}", self.next_serial());
        self.pending_notes.push((
            Notification {
                id,
                kind,
                title,
                body,
                link,
            },
            Some(agent_id.to_owned()),
        ));
    }

    /// One step of background churn; returns the notifications it produced.
    fn tick(&mut self) -> Vec<(Notification, Option<String>)> {
        let moves = (self.agents.len() / 8).max(1);
        for _ in 0..moves {
            if self.agents.is_empty() {
                break;
            }
            let i = self.rand(self.agents.len());
            let id = self.agents[i].id.clone();
            let open_approvals = self
                .needs
                .iter()
                .filter(|n| n.kind == NeedsYouKind::Approval)
                .count();
            let (done_idle, idle_wakes) = (self.chance(20), self.chance(15));
            let next = match self.agents[i].state {
                AgentState::Starting => Some(AgentState::Working),
                AgentState::Ready | AgentState::Waiting => Some(AgentState::Working),
                AgentState::Working => Some(match self.rand(100) {
                    0..=44 => AgentState::Working,
                    45..=74 => AgentState::Testing,
                    75..=84 if open_approvals < 4 => AgentState::NeedsYou,
                    _ => AgentState::Waiting,
                }),
                AgentState::Testing => Some(match self.rand(100) {
                    0..=44 => AgentState::Done,
                    45..=59 => AgentState::Failed,
                    _ => AgentState::Working,
                }),
                AgentState::Done if done_idle => Some(AgentState::Idle),
                AgentState::Idle if idle_wakes => Some(AgentState::Working),
                _ => None,
            };
            if let Some(state) = next {
                self.set_state(&id, state, true);
            }
        }
        // Runs and services drift too.
        let at = now();
        let step = self.rand(COMMANDS.len());
        if let Some(run) = self.runs.iter_mut().find(|r| r.id == "op_nightly") {
            run.updated_at = at;
            if run.status == "running" {
                run.current_action = Some(
                    [
                        "cargo test -p git",
                        "cargo test -p threads",
                        "npm test -- --run",
                        "cargo clippy",
                    ][step % 4]
                        .into(),
                );
                if step == 0 {
                    run.status = "succeeded".into();
                    run.outcome = Some("1,284 tests passed".into());
                    run.current_action = None;
                }
            } else if step == 1 {
                run.status = "running".into();
                run.outcome = None;
                run.current_action = Some("cargo build".into());
            }
        }
        if self.chance(10)
            && let Some(worker) = self.services.iter_mut().find(|s| s.id == "svc_worker")
        {
            worker.status = if worker.status == "running" {
                "stopped"
            } else {
                "running"
            }
            .into();
        }
        if self.chance(6) {
            let deploying = self
                .environments
                .iter()
                .any(|e| e.id == "env_staging" && e.deployment_status == "deploying");
            if let Some(staging) = self.environments.iter_mut().find(|e| e.id == "env_staging") {
                staging.deployment_status = if deploying { "deployed" } else { "deploying" }.into();
                if deploying {
                    staging.last_deploy_at = Some(at);
                }
            }
            if deploying {
                let id = format!("ntf_{:05}", self.next_serial());
                self.pending_notes.push((
                    Notification {
                        id,
                        kind: NotifyKind::Deployment,
                        title: "Staging deployed".into(),
                        body: "website 41a9c2e is live on staging".into(),
                        link: link::FLEET.into(),
                    },
                    None,
                ));
            }
        }
        std::mem::take(&mut self.pending_notes)
    }

    fn run(&mut self, op: Op) -> Result<Value, RemoteError> {
        let value = match op {
            Op::AgentDetail(args) => {
                let agent = self.agents[self.agent_index(&args.agent_id)?].clone();
                let started = agent.created_at;
                let worktree = agent.worktree.then(|| ops::WorktreeInfo {
                    path: format!("C:/Users/dev/.kalcode/worktrees/{}", slug(&agent.name)),
                    branch: agent.branch.clone().unwrap_or_default(),
                    base_branch: Some("main".into()),
                });
                to_value(ops::AgentDetail {
                    messages: vec![
                        ops::AgentMessage { role: "user".into(), text: agent.name.clone(), at: started },
                        ops::AgentMessage {
                            role: "assistant".into(),
                            text: "I'll start by finding where the redirect is computed, then add a failing test.".into(),
                            at: started + time::Duration::seconds(20),
                        },
                        ops::AgentMessage {
                            role: "assistant".into(),
                            text: "Found it: the query string is dropped in `buildReturnUrl`. Fixing and adding coverage.".into(),
                            at: agent.last_activity_at,
                        },
                    ],
                    tools: vec![
                        ops::ToolCall { name: "Read".into(), summary: "src/auth/redirect.ts".into(), status: "succeeded".into(), at: started + time::Duration::seconds(25) },
                        ops::ToolCall { name: "Edit".into(), summary: "src/auth/redirect.ts (+12 −3)".into(), status: "succeeded".into(), at: started + time::Duration::seconds(60) },
                        ops::ToolCall { name: "Bash".into(), summary: "npm test -- auth".into(), status: if agent.state == AgentState::Failed { "failed" } else { "running" }.into(), at: agent.last_activity_at },
                    ],
                    worktree,
                    agent,
                })
            }
            Op::AgentDiff(args) => {
                let agent = self.agents[self.agent_index(&args.agent_id)?].clone();
                fake_diff(&agent, args.max_bytes)
            }
            Op::AgentLog(args) => {
                self.agent_index(&args.agent_id)?;
                const TOTAL: usize = 240;
                const PAGE: usize = 50;
                let end = match &args.before_id {
                    Some(before) => before
                        .strip_prefix("log_")
                        .and_then(|n| n.parse::<usize>().ok())
                        .ok_or_else(|| RemoteError::invalid("unknown beforeId"))?,
                    None => TOTAL,
                };
                let start = end.saturating_sub(PAGE);
                let base = now() - time::Duration::seconds(TOTAL as i64 * 5);
                let entries = (start..end)
                    .map(|n| ops::LogEntry {
                        id: format!("log_{n}"),
                        kind: ["message", "tool", "output", "status"][n % 4].into(),
                        text: format!(
                            "{} {}",
                            ["Thinking about", "Ran", "Output of", "Status:"][n % 4],
                            ACTIVITIES[n % ACTIVITIES.len()]
                        ),
                        at: base + time::Duration::seconds(n as i64 * 5),
                    })
                    .collect();
                to_value(ops::LogPage {
                    entries,
                    more: start > 0,
                })
            }
            Op::AgentPrompt(args) => {
                let i = self.agent_index(&args.agent_id)?;
                if self.agents[i].pending_approvals > 0 {
                    return Err(RemoteError::refused(
                        "This agent is waiting for an approval. Answer it first.",
                    ));
                }
                if args.text.trim().is_empty() {
                    return Err(RemoteError::invalid("The prompt is empty"));
                }
                let name = self.agents[i].name.clone();
                self.set_state(&args.agent_id, AgentState::Working, true);
                self.agents[i].activity = Some("Reading your prompt".into());
                to_value(ops::Summary {
                    summary: format!("Sent to {name}"),
                })
            }
            Op::AgentStop(args) => {
                let i = self.agent_index(&args.agent_id)?;
                let name = self.agents[i].name.clone();
                if matches!(self.agents[i].state, AgentState::Stopped | AgentState::Done) {
                    return Err(RemoteError::conflict(format!("{name} is not running")));
                }
                self.set_state(&args.agent_id, AgentState::Stopped, false);
                let id = args.agent_id.clone();
                self.needs.retain(|n| n.agent_id.as_deref() != Some(&id));
                to_value(ops::Summary {
                    summary: format!("Stopped {name}"),
                })
            }
            Op::AgentRetry(args) => {
                let i = self.agent_index(&args.agent_id)?;
                let name = self.agents[i].name.clone();
                if !matches!(
                    self.agents[i].state,
                    AgentState::Failed | AgentState::Stopped
                ) {
                    return Err(RemoteError::conflict(format!(
                        "{name} has not failed or stopped"
                    )));
                }
                self.set_state(&args.agent_id, AgentState::Working, false);
                to_value(ops::Summary {
                    summary: format!("Resumed {name}"),
                })
            }
            Op::AgentLaunch(args) => {
                let workspace = self
                    .workspaces
                    .iter()
                    .find(|w| w.id == args.workspace_id)
                    .cloned()
                    .ok_or_else(|| RemoteError::not_found("That workspace is not open"))?;
                let provider = PROVIDERS
                    .iter()
                    .find(|p| p.0 == args.provider_id)
                    .ok_or_else(|| RemoteError::invalid("Unknown provider"))?;
                let model = args
                    .model
                    .clone()
                    .unwrap_or_else(|| provider.2[0].0.to_owned());
                let name = args
                    .prompt
                    .as_deref()
                    .map(|p| p.chars().take(40).collect::<String>())
                    .filter(|p| !p.trim().is_empty())
                    .unwrap_or_else(|| "New agent".into());
                let id = self.add_agent(&workspace, provider.0, &model, &name);
                if let Ok(i) = self.agent_index(&id) {
                    self.agents[i].effort = args.effort.clone().or(self.agents[i].effort.take());
                    self.agents[i].created_at = now();
                    self.agents[i].last_activity_at = now();
                }
                self.set_state(&id, AgentState::Starting, false);
                to_value(ops::LaunchResult {
                    agent_id: Some(id),
                    summary: format!("Started {} in {}", provider.1, workspace.name),
                })
            }
            Op::LaunchOptions => to_value(ops::LaunchOptions {
                workspaces: self.workspaces.clone(),
                providers: PROVIDERS
                    .iter()
                    .map(|(id, name, models)| ops::LaunchProvider {
                        id: (*id).into(),
                        name: (*name).into(),
                        accounts: vec![
                            ops::LaunchAccount {
                                id: format!("{id}:work"),
                                label: "Work".into(),
                            },
                            ops::LaunchAccount {
                                id: format!("{id}:personal"),
                                label: "Personal".into(),
                            },
                        ],
                        models: models
                            .iter()
                            .map(|(mid, mname)| ops::LaunchModel {
                                id: (*mid).into(),
                                name: (*mname).into(),
                                efforts: if *id == "gemini" {
                                    vec![]
                                } else {
                                    vec!["low".into(), "medium".into(), "high".into()]
                                },
                            })
                            .collect(),
                    })
                    .collect(),
            }),
            Op::NeedsDecide(args) => {
                let item = self
                    .needs
                    .iter()
                    .find(|n| n.approval_id.as_deref() == Some(args.approval_id.as_str()))
                    .cloned()
                    .ok_or_else(|| RemoteError::not_found("Already answered"))?;
                self.needs.retain(|n| n.id != item.id);
                if let Some(agent) = item.agent_id.as_deref() {
                    self.set_state(agent, AgentState::Working, false);
                    if let (ops::Decision::Deny, Ok(i)) = (args.decision, self.agent_index(agent)) {
                        self.agents[i].activity = Some("Adjusting after the denial".into());
                    }
                }
                let status = match args.decision {
                    ops::Decision::ApproveOnce => "approved",
                    ops::Decision::Deny => "denied",
                };
                to_value(ops::DecideResult {
                    status: status.into(),
                })
            }
            Op::VoiceCommand(args) => {
                let text = args.text.to_lowercase();
                if text.contains("close idle") || text.contains("tidy") {
                    return self
                        .run(Op::TidyCloseIdle)
                        .map(|v| serde_json::json!({"summary": v["summary"], "outcome": "done"}));
                }
                if let (Some(agent), true) = (args.agent_id.clone(), text.starts_with("tell")) {
                    let prompt = args
                        .text
                        .split_once(' ')
                        .map(|x| x.1)
                        .unwrap_or_default()
                        .to_owned();
                    let result = self.run(Op::AgentPrompt(ops::PromptArgs {
                        agent_id: agent,
                        text: prompt,
                    }))?;
                    return Ok(
                        serde_json::json!({"summary": result["summary"], "outcome": "done"}),
                    );
                }
                let working = self
                    .agents
                    .iter()
                    .filter(|a| a.state == AgentState::Working)
                    .count();
                to_value(ops::VoiceResult {
                    summary: format!("{working} agents working, {} need you", self.needs.len()),
                    outcome: "done".into(),
                })
            }
            Op::RunDetail(args) => {
                let run = self
                    .runs
                    .iter()
                    .find(|r| r.id == args.run_id)
                    .cloned()
                    .ok_or_else(|| RemoteError::not_found("This run has finished"))?;
                to_value(ops::RunDetail {
                    logs: vec![
                        "   Compiling kalcode-git v0.0.0".into(),
                        "    Finished `test` profile in 41.2s".into(),
                        "     Running unittests src/lib.rs".into(),
                        format!(
                            "test result: ok. 214 passed; 0 failed ({})",
                            run.current_action.clone().unwrap_or_default()
                        ),
                    ],
                    tests: vec![
                        ops::TestResult {
                            name: "diff::renames_are_detected".into(),
                            status: "passed".into(),
                            duration_ms: Some(12),
                        },
                        ops::TestResult {
                            name: "worktree::prune_keeps_active".into(),
                            status: "passed".into(),
                            duration_ms: Some(340),
                        },
                        ops::TestResult {
                            name: "status::large_repo".into(),
                            status: if run.status == "running" {
                                "running"
                            } else {
                                "passed"
                            }
                            .into(),
                            duration_ms: None,
                        },
                    ],
                    run,
                })
            }
            Op::TidyCloseIdle => {
                let before = self.agents.len();
                let closing: Vec<String> = self
                    .agents
                    .iter()
                    .filter(|a| matches!(a.state, AgentState::Idle | AgentState::Done))
                    .map(|a| a.id.clone())
                    .collect();
                self.agents.retain(|a| !closing.contains(&a.id));
                self.needs
                    .retain(|n| n.agent_id.as_ref().is_none_or(|id| !closing.contains(id)));
                to_value(ops::Summary {
                    summary: format!("Closed {} idle agents", before - self.agents.len()),
                })
            }
        };
        Ok(value)
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn slug(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn fake_diff(agent: &RemoteAgent, max_bytes: Option<u64>) -> Value {
    use ops::DiffLineKind::{Add, Ctx, Del};
    let line = |kind, text: &str| (kind, text.to_owned());
    let mut files = vec![
        ops::DiffFile {
            path: "src/auth/redirect.ts".into(),
            status: "modified".into(),
            additions: 9,
            deletions: 3,
            hunks: vec![ops::DiffHunk {
                header: "@@ -14,9 +14,15 @@ export function buildReturnUrl(req: Request): string {"
                    .into(),
                lines: vec![
                    line(Ctx, "  const target = new URL(req.url);"),
                    line(Ctx, "  const next = target.searchParams.get(\"next\");"),
                    line(Del, "  if (!next) return \"/\";"),
                    line(Del, "  return next.split(\"?\")[0];"),
                    line(Add, "  if (!next || !next.startsWith(\"/\")) return \"/\";"),
                    line(
                        Add,
                        "  // Keep the original query so deep links survive sign-in.",
                    ),
                    line(Add, "  const url = new URL(next, target.origin);"),
                    line(Add, "  if (url.origin !== target.origin) return \"/\";"),
                    line(Add, "  return url.pathname + url.search + url.hash;"),
                    line(Ctx, "}"),
                ],
            }],
        },
        ops::DiffFile {
            path: "src/auth/redirect.test.ts".into(),
            status: "added".into(),
            additions: 18,
            deletions: 0,
            hunks: vec![ops::DiffHunk {
                header: "@@ -0,0 +1,18 @@".into(),
                lines: vec![
                    line(Add, "import { describe, expect, it } from \"vitest\";"),
                    line(Add, "import { buildReturnUrl } from \"./redirect\";"),
                    line(Add, ""),
                    line(Add, "describe(\"buildReturnUrl\", () => {"),
                    line(Add, "  it(\"keeps the query string\", () => {"),
                    line(
                        Add,
                        "    const req = new Request(\"https://app.test/login?next=/billing%3Ftab%3Dinvoices\");",
                    ),
                    line(
                        Add,
                        "    expect(buildReturnUrl(req)).toBe(\"/billing?tab=invoices\");",
                    ),
                    line(Add, "  });"),
                    line(Add, ""),
                    line(Add, "  it(\"refuses other origins\", () => {"),
                    line(
                        Add,
                        "    const req = new Request(\"https://app.test/login?next=https://evil.test\");",
                    ),
                    line(Add, "    expect(buildReturnUrl(req)).toBe(\"/\");"),
                    line(Add, "  });"),
                    line(Add, "});"),
                ],
            }],
        },
        ops::DiffFile {
            path: "CHANGELOG.md".into(),
            status: "modified".into(),
            additions: 1,
            deletions: 0,
            hunks: vec![ops::DiffHunk {
                header: "@@ -3,6 +3,7 @@".into(),
                lines: vec![
                    line(Ctx, "## Unreleased"),
                    line(Ctx, ""),
                    line(Add, &format!("- {} ({})", agent.name, agent.provider_name)),
                    line(Ctx, "- Faster cold start"),
                ],
            }],
        },
        ops::DiffFile {
            path: "src/legacy/session-cookie.ts".into(),
            status: "deleted".into(),
            additions: 0,
            deletions: 4,
            hunks: vec![ops::DiffHunk {
                header: "@@ -1,4 +0,0 @@".into(),
                lines: vec![
                    line(Del, "export const LEGACY_COOKIE = \"kc_session\";"),
                    line(Del, "export function readLegacy(cookie: string) {"),
                    line(
                        Del,
                        "  return cookie.split(\";\").find((c) => c.startsWith(LEGACY_COOKIE));",
                    ),
                    line(Del, "}"),
                ],
            }],
        },
    ];
    let wanted = (agent.files_changed as usize).clamp(1, files.len());
    files.truncate(wanted);
    let mut truncated = false;
    if let Some(limit) = max_bytes {
        while files.len() > 1 && serde_json::to_vec(&files).map_or(0, |v| v.len()) as u64 > limit {
            files.pop();
            truncated = true;
        }
    }
    to_value(ops::DiffResult { files, truncated })
}
