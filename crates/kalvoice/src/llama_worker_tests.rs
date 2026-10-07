#![cfg(test)]

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use kalcode_contracts::kalvoice::KalVoiceIntent;
use kalcode_contracts::threads::WorkspaceOption;

use crate::local_reasoning::LocalActionGrounding;

use super::*;

/// Hang guard for loopback socket I/O with an in-process fixture server: never a latency assertion.
const IO_GUARD: Duration = Duration::from_secs(30);

fn absolute_fixture_paths() -> (PathBuf, PathBuf, PathBuf) {
    #[cfg(windows)]
    {
        (
            PathBuf::from(r"C:\KalCode\runtime\llama-server.exe"),
            PathBuf::from(r"C:\KalCode\runtime"),
            PathBuf::from(r"C:\KalCode\models\reasoner.gguf"),
        )
    }
    #[cfg(not(windows))]
    {
        (
            PathBuf::from("/opt/kalcode/runtime/llama-server"),
            PathBuf::from("/opt/kalcode/runtime"),
            PathBuf::from("/opt/kalcode/models/reasoner.gguf"),
        )
    }
}

fn request() -> LocalInterpretationRequest {
    LocalInterpretationRequest {
        request: "pull up approval status".into(),
        workspace_id: Some("0199a914-5ea1-7db0-b36b-aee1bdc846d6".into()),
        workspaces: vec![WorkspaceOption {
            id: "0199a914-5ea1-7db0-b36b-aee1bdc846d6".into(),
            name: "KalCode".into(),
        }],
        grounded_actions: Vec::new(),
    }
}

fn candidates() -> Vec<GroundedActionCandidate> {
    grounded_action_candidates(&request())
}

#[test]
fn default_cpu_thread_limit_matches_the_platform_baseline() {
    let limits = LlamaWorkerLimits::default();
    assert!(limits.threads >= 1);
    #[cfg(target_os = "macos")]
    assert!(limits.threads <= 4);
    #[cfg(not(target_os = "macos"))]
    assert!(limits.threads <= 8);
}

#[test]
fn launch_is_loopback_only_offline_and_exposes_no_key_or_rpc_authority() {
    let (executable, runtime, model) = absolute_fixture_paths();
    let spec = launch_spec(
        &executable,
        &runtime,
        &model,
        41_337,
        LlamaWorkerLimits::default(),
    )
    .expect("valid launch spec");
    let joined = spec.args.join(" ");

    assert!(joined.contains("--host 127.0.0.1"));
    assert!(joined.contains("--port 41337"));
    assert!(joined.contains("--offline"));
    assert!(joined.contains("--device none"));
    assert!(joined.contains("--no-webui"));
    assert!(joined.contains("--no-slots"));
    assert!(joined.contains("--no-webui-mcp-proxy"));
    assert!(joined.contains("--log-disable"));
    assert!(joined.contains("--reasoning off"));
    assert!(joined.contains("--reasoning-budget 0"));
    assert!(!joined.contains("--api-key"));
    assert!(!joined.contains("0.0.0.0"));
    assert!(!joined.contains("--rpc"));
    assert!(!joined.contains("--hf-repo"));
    assert_eq!(spec.executable, executable);
    assert_eq!(spec.current_dir, runtime);
}

#[test]
fn request_body_contains_only_bounded_grounded_candidate_context() {
    let body = build_request(&request(), &candidates(), 128).expect("request body");
    let body: serde_json::Value = serde_json::from_slice(&body).expect("json");
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 2);
    let system = messages[0]["content"].as_str().expect("system");
    assert!(system.contains("\"id\":\"c0\""));
    assert!(system.contains("Show pending approvals"));
    assert!(system.contains("Show thread status"));
    assert!(!system.contains("KalCode"));
    assert!(!system.contains("\"path\":"));
    assert!(!system.contains("\"providers\":"));
    assert_eq!(messages[1]["content"], "pull up approval status");
    assert_eq!(body["temperature"], 0);
    assert_eq!(body["top_k"], 1);
    assert_eq!(body["stream"], false);
}

#[test]
fn live_scene_labels_reach_the_offline_selector_but_native_ids_do_not() {
    let mut input = request();
    input.request = "find Claude working on the website".into();
    input.grounded_actions = vec![
        LocalActionGrounding {
            label: "Open Website refresh · Claude Code · KalCode · Running frontend tests".into(),
            intent: KalVoiceIntent::OpenThread {
                query: "0199a914-5ea1-7db0-b36b-aee1bdc846d8".into(),
            },
        },
        LocalActionGrounding {
            label: "Open API release · Claude Code · KalCode · Refactoring authentication".into(),
            intent: KalVoiceIntent::OpenThread {
                query: "0199a914-5ea1-7db0-b36b-aee1bdc846d9".into(),
            },
        },
    ];
    let candidates = grounded_action_candidates(&input);
    let body = build_request(&input, &candidates, 128).expect("request body");
    let body: serde_json::Value = serde_json::from_slice(&body).expect("json");
    let system = body["messages"][0]["content"].as_str().expect("system");

    assert!(system.contains("Website refresh"));
    assert!(system.contains("Running frontend tests"));
    assert!(system.contains("API release"));
    assert!(!system.contains("0199a914"));
    assert_eq!(
        resolve_selection(Some("c0"), &candidates),
        Ok(LocalInterpretation::Action(KalVoiceIntent::OpenThread {
            query: "0199a914-5ea1-7db0-b36b-aee1bdc846d8".into(),
        }))
    );
}

#[test]
fn invalid_current_workspace_and_oversized_request_are_refused_before_inference() {
    let mut invalid = request();
    invalid.workspace_id = Some("0199a914-5ea1-7db0-b36b-aee1bdc846d7".into());
    assert_eq!(
        validate_request(&invalid),
        Err(LlamaWorkerError::InvalidConfiguration)
    );

    invalid.workspace_id = None;
    invalid.request = "x".repeat(MAX_LOCAL_REQUEST_CHARS + 1);
    assert_eq!(
        validate_request(&invalid),
        Err(LlamaWorkerError::InvalidConfiguration)
    );

    invalid.request = "find the matching terminal".into();
    invalid.grounded_actions = (0..=MAX_GROUNDED_ACTION_CANDIDATES)
        .map(|index| LocalActionGrounding {
            label: format!("Open agent {index}"),
            intent: KalVoiceIntent::OpenThread {
                query: format!("0199a914-5ea1-7db0-b36b-aee1bdc8{index:04x}"),
            },
        })
        .collect();
    assert_eq!(
        validate_request(&invalid),
        Err(LlamaWorkerError::InvalidConfiguration)
    );
}

#[test]
fn negated_and_compound_requests_are_refused_before_inference() {
    for text in [
        "do not open settings",
        "open settings and delete the project",
        "reload the browser then publish it",
    ] {
        let mut candidate = request();
        candidate.request = text.into();
        assert_eq!(refuse_before_inference(&candidate), Ok(true));
    }

    let mut candidate = request();
    candidate.request = "pull up approval status".into();
    assert_eq!(refuse_before_inference(&candidate), Ok(false));
}

#[test]
fn parses_only_opaque_candidate_selections_and_membership_checks_them() {
    let action = serde_json::json!({
        "choices": [{
            "message": {
                "content": "{\"candidateId\":\"c0\"}"
            }
        }]
    });
    assert_eq!(
        parse_response(&serde_json::to_vec(&action).expect("json")),
        Ok(Some("c0".into()))
    );
    assert_eq!(
        resolve_selection(Some("c0"), &candidates()),
        Ok(LocalInterpretation::Action(KalVoiceIntent::ShowApprovals))
    );
    assert_eq!(
        resolve_selection(Some("not-offered"), &candidates()),
        Err(LlamaWorkerError::InvalidResponse)
    );

    let uncertain = serde_json::json!({
        "choices": [{"message": {"content": "{\"candidateId\":null}"}}]
    });
    assert_eq!(
        parse_response(&serde_json::to_vec(&uncertain).expect("json")),
        Ok(None)
    );

    let injected = serde_json::json!({
        "choices": [{
            "message": {
                "content": "{\"candidateId\":\"c0\",\"command\":\"run anything\"}"
            }
        }]
    });
    assert_eq!(
        parse_response(&serde_json::to_vec(&injected).expect("json")),
        Err(LlamaWorkerError::InvalidResponse)
    );

    let unoffered = serde_json::json!({
        "choices": [{
            "message": { "content": "{\"candidateId\":\"not-offered\"}" }
        }]
    });
    assert_eq!(
        parse_response(&serde_json::to_vec(&unoffered).expect("json")),
        Ok(Some("not-offered".into()))
    );

    let missing_required_field = serde_json::json!({
        "choices": [{"message": {"content": "{}"}}]
    });
    assert_eq!(
        parse_response(&serde_json::to_vec(&missing_required_field).expect("json")),
        Err(LlamaWorkerError::InvalidResponse)
    );
}

fn one_shot_server(
    expected_key: &'static str,
    response_status: &'static str,
    response_type: &'static str,
    response_body: Vec<u8>,
) -> (SocketAddrV4, thread::JoinHandle<bool>) {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
    let port = listener.local_addr().expect("address").port();
    let task = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        stream.set_read_timeout(Some(IO_GUARD)).expect("timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).expect("request read");
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end + 4]);
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if request.len() >= header_end + 4 + length {
                break;
            }
        }
        let request_text = String::from_utf8_lossy(&request);
        let authenticated = request_text.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("authorization")
                    && value.trim() == format!("Bearer {expected_key}")
            })
        });
        let header = format!(
            "HTTP/1.1 {response_status}\r\nContent-Type: {response_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response_body.len()
        );
        stream.write_all(header.as_bytes()).expect("header");
        stream.write_all(&response_body).expect("body");
        authenticated
    });
    (SocketAddrV4::new(Ipv4Addr::LOCALHOST, port), task)
}

#[test]
fn loopback_transport_authenticates_and_accepts_only_json() {
    static KEY: &str = "test-local-bearer-value";
    let response = serde_json::to_vec(&serde_json::json!({
        "choices": [{"message": {"content": "{\"candidateId\":null}"}}]
    }))
    .expect("response");
    let (endpoint, server) = one_shot_server(KEY, "200 OK", "application/json", response);
    let body = build_request(&request(), &candidates(), 128).expect("body");
    let stream = TcpStream::connect_timeout(&endpoint.into(), IO_GUARD).expect("connect");
    stream
        .set_read_timeout(Some(IO_GUARD))
        .expect("read timeout");
    stream
        .set_write_timeout(Some(IO_GUARD))
        .expect("write timeout");

    assert_eq!(post_interpretation(Box::new(stream), KEY, &body), Ok(None));
    assert!(server.join().expect("server result"));
}

#[test]
fn loopback_transport_rejects_non_json_and_oversized_responses() {
    static KEY: &str = "test-local-bearer-value";
    let body = build_request(&request(), &candidates(), 128).expect("body");
    let (endpoint, server) = one_shot_server(KEY, "200 OK", "text/plain", b"no".to_vec());
    let stream = TcpStream::connect_timeout(&endpoint.into(), IO_GUARD).expect("connect");
    assert_eq!(
        post_interpretation(Box::new(stream), KEY, &body),
        Err(LlamaWorkerError::InvalidResponse)
    );
    assert!(server.join().expect("server result"));

    let oversized = vec![b'x'; MAX_HTTP_RESPONSE_BYTES as usize + 1];
    let (endpoint, server) = one_shot_server(KEY, "200 OK", "application/json", oversized);
    let stream = TcpStream::connect_timeout(&endpoint.into(), IO_GUARD).expect("connect");
    assert!(matches!(
        post_interpretation(Box::new(stream), KEY, &body),
        Err(LlamaWorkerError::InvalidResponse | LlamaWorkerError::Transport)
    ));
    assert!(server.join().expect("server result"));
}

#[test]
fn cancellation_is_explicit_and_clone_visible() {
    let cancellation = InterpretationCancellation::default();
    let observer = cancellation.clone();
    assert!(!observer.is_cancelled());
    cancellation.cancel();
    assert!(observer.is_cancelled());
}

#[test]
fn worker_environment_never_inherits_proxies_or_provider_credentials() {
    let environment = worker_environment("redacted-fixture").expect("environment");
    assert_eq!(
        environment
            .get(std::ffi::OsStr::new("LLAMA_API_KEY"))
            .and_then(|value| value.to_str()),
        Some("redacted-fixture")
    );
    for forbidden in [
        "PATH",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
    ] {
        assert!(!environment.contains_key(std::ffi::OsStr::new(forbidden)));
    }
}

struct RecordingLauncher {
    spec: Arc<Mutex<Option<GuardedWorkerSpec>>>,
    connect_result: GuardedWorkerError,
    cleanup_result: Result<(), GuardedWorkerError>,
}

impl GuardedWorkerLauncher for RecordingLauncher {
    fn spawn_guarded(
        &self,
        spec: GuardedWorkerSpec,
    ) -> Result<Box<dyn GuardedWorkerProcess>, GuardedWorkerError> {
        *self.spec.lock().expect("spec lock") = Some(spec);
        Ok(Box::new(RecordingProcess {
            connect_result: self.connect_result,
            cleanup_result: self.cleanup_result,
        }))
    }
}

struct RecordingProcess {
    connect_result: GuardedWorkerError,
    cleanup_result: Result<(), GuardedWorkerError>,
}

impl GuardedWorkerProcess for RecordingProcess {
    fn pid(&self) -> u32 {
        7
    }

    fn try_wait(&mut self, _deadline: Instant) -> Result<GuardedWorkerState, GuardedWorkerError> {
        Ok(GuardedWorkerState::Running)
    }

    fn connect_verified(
        &mut self,
        _endpoint: SocketAddrV4,
        _timeout: Duration,
    ) -> Result<Box<dyn GuardedLoopbackConnection>, GuardedWorkerError> {
        Err(self.connect_result)
    }

    fn terminate_and_prove_quiescence(
        &mut self,
        _deadline: Instant,
    ) -> Result<(), GuardedWorkerError> {
        self.cleanup_result
    }
}

#[test]
fn running_process_requires_guarded_launcher_and_scrubs_environment() {
    let recorded = Arc::new(Mutex::new(None));
    let launcher = RecordingLauncher {
        spec: Arc::clone(&recorded),
        connect_result: GuardedWorkerError::LoopbackOwnerMismatch,
        cleanup_result: Ok(()),
    };
    let (executable, current_dir, model) = absolute_fixture_paths();
    let launch = launch_spec(
        &executable,
        &current_dir,
        &model,
        41_337,
        LlamaWorkerLimits::default(),
    )
    .expect("launch");
    let _running = RunningProcess::spawn(
        &launcher,
        launch,
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 41_337),
        "test-local-bearer-value".into(),
    )
    .expect("guarded spawn");
    let spec = recorded.lock().expect("spec lock").take().expect("spec");
    assert_eq!(spec.executable, executable);
    assert_eq!(spec.current_dir, current_dir);
    assert_eq!(
        spec.environment
            .get(std::ffi::OsStr::new("LLAMA_API_KEY"))
            .and_then(|value| value.to_str()),
        Some("test-local-bearer-value")
    );
    assert!(
        spec.environment
            .keys()
            .all(|key| key == "LLAMA_API_KEY" || cfg!(windows) && key == "SystemRoot")
    );
}

#[test]
fn owner_mismatch_fails_before_any_authenticated_transport_exists() {
    let recorded = Arc::new(Mutex::new(None));
    let launcher = RecordingLauncher {
        spec: recorded,
        connect_result: GuardedWorkerError::LoopbackOwnerMismatch,
        cleanup_result: Ok(()),
    };
    let (executable, current_dir, model) = absolute_fixture_paths();
    let launch = launch_spec(
        &executable,
        &current_dir,
        &model,
        41_337,
        LlamaWorkerLimits::default(),
    )
    .expect("launch");
    let mut running = RunningProcess::spawn(
        &launcher,
        launch,
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 41_337),
        "test-local-bearer-value".into(),
    )
    .expect("guarded spawn");
    assert!(matches!(
        running.connect_verified(Duration::from_secs(1)),
        Err(LlamaWorkerError::LoopbackOwnerMismatch)
    ));
}

#[test]
fn unproved_cleanup_is_retained_and_blocks_replacement() {
    let process = RecordingProcess {
        connect_result: GuardedWorkerError::LoopbackOwnerMismatch,
        cleanup_result: Err(GuardedWorkerError::CleanupUnproven),
    };
    let mut state = WorkerState {
        running: Some(RunningProcess {
            process: Box::new(process),
            endpoint: SocketAddrV4::new(Ipv4Addr::LOCALHOST, 41_337),
            api_key: "test-local-bearer-value".into(),
        }),
        ..WorkerState::default()
    };
    assert_eq!(
        terminate_running_state(&mut state),
        Err(LlamaWorkerError::CleanupUnproven)
    );
    assert!(state.running.is_none());
    assert!(state.unclean.is_some());
}
