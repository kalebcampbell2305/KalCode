//! Test-support stand-in for a provider CLI. It never contacts any service.
//!
//! Tests copy this executable into a temporary folder under the provider's executable name
//! (`claude.exe`, `codex`, ...) next to a `fake-provider.json` that selects its behaviour, then
//! put that folder on the `PATH` KalCode's detection searches. In session mode it replays the
//! documented stream-JSON fixtures in `tests/fixtures/claude/` so the whole
//! provider event pipeline runs without a real provider. Codex mode additionally exposes the
//! command/flag surface and isolated app-server handshake used by compatibility negotiation.
//!
//! In interactive mode (started with `--settings`, as a provider pane starts `claude`) it shows
//! a minimal TUI and fires the hooks from KalCode's settings file with the documented payloads
//! (see `interactive` below). With `hook` as its first argument it stands in for the
//! `kalcode-hook` helper, running the same library code.
//!
//! It records what it was started with (`last-args.json`, and the *names* of its environment
//! variables in `last-env.json`) so tests can assert on argv and environment sanitization.

use std::ffi::OsStr;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

const INIT: &str = include_str!("../../tests/fixtures/claude/init.jsonl");
const TURN_TEXT: &str = include_str!("../../tests/fixtures/claude/turn_text.jsonl");
const TURN_TOOLS: &str = include_str!("../../tests/fixtures/claude/turn_tools.jsonl");
const TURN_MALFORMED: &str = include_str!("../../tests/fixtures/claude/turn_malformed.jsonl");
const INTERRUPTED: &str = include_str!("../../tests/fixtures/claude/interrupted.jsonl");
const CODEX_TEXT: &str = include_str!("../../tests/fixtures/codex/turn_text.jsonl");
const CODEX_TOOLS: &str = include_str!("../../tests/fixtures/codex/turn_tools.jsonl");
const CODEX_FAILED: &str = include_str!("../../tests/fixtures/codex/turn_failed.jsonl");
const GEMINI_TEXT: &str = include_str!("../../tests/fixtures/gemini/turn_text.jsonl");
const GEMINI_TOOLS: &str = include_str!("../../tests/fixtures/gemini/turn_tools.jsonl");
const GEMINI_QUOTA: &str = include_str!("../../tests/fixtures/gemini/quota.jsonl");

fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;

        let mut command = command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    command
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Where this run records its artifacts (`runs.log`, `last-args.json`, ...): the folder of the
/// live fixture configuration, else the executable's own folder.
static ARTIFACT_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn artifact_dir() -> PathBuf {
    ARTIFACT_DIR.get().cloned().unwrap_or_else(exe_dir)
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

/// Loads the fixture configuration: `fake-provider.json` beside the executable, else the one in
/// a distribution-shaped install's `codex-resources/` (what a real Codex distribution carries
/// beside `bin/`, and what KalCode copies into its immutable managed runtime snapshot).
///
/// A distribution resource may instead name the live fixture folder (`{"fixtureDir": ...}`).
/// Then a copy KalCode snapshotted elsewhere reads the same live configuration and records its
/// artifacts there, exactly like the installed copy, and never writes into the snapshot: a real
/// provider never modifies its own installation, and KalCode verifies snapshots are unchanged.
fn config() -> Value {
    let bin = exe_dir();
    if let Some(config) = read_json(&bin.join("fake-provider.json")) {
        let _ = ARTIFACT_DIR.set(bin);
        return config;
    }
    let Some(resource) = bin
        .parent()
        .and_then(|root| read_json(&root.join("codex-resources").join("fake-provider.json")))
    else {
        return Value::Null;
    };
    match resource.get("fixtureDir").and_then(Value::as_str) {
        Some(fixture) => {
            let fixture = PathBuf::from(fixture);
            let config = read_json(&fixture.join("fake-provider.json")).unwrap_or(Value::Null);
            let _ = ARTIFACT_DIR.set(fixture);
            config
        }
        None => resource,
    }
}

fn get_str<'a>(config: &'a Value, key: &str, default: &'a str) -> &'a str {
    config.get(key).and_then(Value::as_str).unwrap_or(default)
}

fn provider_version<'a>(config: &'a Value, kind: &str, default: &'a str) -> &'a str {
    config
        .get("version")
        .and_then(Value::as_str)
        .or_else(|| {
            config
                .get("versions")
                .and_then(|versions| versions.get(kind))
                .and_then(Value::as_str)
        })
        .unwrap_or(default)
}

fn codex_semver(config: &Value) -> &str {
    provider_version(config, "codex", "codex-cli 0.160.0")
        .split_ascii_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        })
        .unwrap_or("0.160.0")
}

fn codex_capability(config: &Value, name: &str) -> bool {
    config
        .get("codexCapabilities")
        .and_then(|capabilities| capabilities.get(name))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn codex_help(config: &Value, args: &[String]) -> Option<String> {
    if args == ["--help"] {
        let mut commands = Vec::new();
        if codex_capability(config, "exec") {
            commands.push("  exec        Run Codex non-interactively");
        }
        if codex_capability(config, "interactiveResume") {
            commands.push("  resume      Resume an interactive session");
        }
        if codex_capability(config, "mcp") {
            commands.push("  mcp         Manage MCP servers");
        }
        if codex_capability(config, "appServer") {
            commands.push("  app-server  Run the Codex app server");
        }
        let mut options = Vec::new();
        if codex_capability(config, "configOverride") {
            options.push("  -c, --config <key=value>          Override a configuration value");
        }
        if codex_capability(config, "workingDirectory") {
            options.push("  -C, --cd <DIR>                    Set the working directory");
        }
        if codex_capability(config, "rootSandbox") {
            options.push("  -s, --sandbox <MODE>              Select the sandbox policy");
        }
        if codex_capability(config, "approvalPolicy") {
            options.push("  -a, --ask-for-approval <POLICY>   Select the approval policy");
        }
        if codex_capability(config, "modelSelection") {
            options.push("  -m, --model <MODEL>                Select the model");
        }
        if codex_capability(config, "noDaemon") {
            options.push("      --no-daemon                    Run without the desktop daemon");
        }
        return Some(format!(
            "Usage: codex [OPTIONS] [PROMPT]\n\nCommands:\n{}\n\nOptions:\n{}\n",
            commands.join("\n"),
            options.join("\n")
        ));
    }
    if args == ["exec", "--help"] {
        let mut commands = Vec::new();
        if codex_capability(config, "resume") {
            commands.push("  resume  Resume a previous non-interactive session");
        }
        let mut options = Vec::new();
        if codex_capability(config, "configOverride") {
            options.push("  -c, --config <key=value>  Override a configuration value");
        }
        if codex_capability(config, "modelSelection") {
            options.push("  -m, --model <MODEL>       Select the model");
        }
        if codex_capability(config, "sandbox") {
            options.push("  -s, --sandbox <MODE>      Select the sandbox policy");
        }
        if codex_capability(config, "skipGitRepoCheck") {
            options.push("  --skip-git-repo-check    Allow execution outside a Git repository");
        }
        if codex_capability(config, "execJson") {
            options.push("  --json                  Emit JSONL events");
        }
        if codex_capability(config, "structuredOutput") {
            options.push("  --output-schema <FILE>  Validate the final response");
        }
        return Some(format!(
            "Usage: codex exec [OPTIONS] [PROMPT]\n\nCommands:\n{}\n\nOptions:\n{}\n",
            commands.join("\n"),
            options.join("\n")
        ));
    }
    if args == ["exec", "resume", "--help"] {
        let mut options = Vec::new();
        if codex_capability(config, "configOverride") {
            options.push("  --config <key=value>  Override a configuration value");
        }
        if codex_capability(config, "execJson") {
            options.push("  --json                Emit JSONL events");
        }
        return Some(format!(
            "Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n\nOptions:\n{}\n",
            options.join("\n")
        ));
    }
    if args == ["resume", "--help"] {
        return Some(
            "Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n\nOptions:\n  --last  Resume the most recent session\n"
                .into(),
        );
    }
    if args == ["app-server", "--help"] {
        let mut options = Vec::new();
        if codex_capability(config, "configOverride") {
            options.push("  --config <key=value>  Override a configuration value");
        }
        if codex_capability(config, "appServerStdio") {
            options.push("  --stdio              Serve the protocol over stdin/stdout");
        }
        return Some(format!(
            "Usage: codex app-server [OPTIONS]\n\nOptions:\n{}\n",
            options.join("\n")
        ));
    }
    None
}

/// Writes the read-only Codex 0.161 app-server config schema used by compatibility negotiation.
/// The shape mirrors the native CLI's generated `ConfigReadResponse.json`; scenarios can narrow
/// its string enum or make the output structurally invalid without executing provider code.
fn codex_config_schema(config: &Value, args: &[String]) -> bool {
    if args.len() != 4
        || args[0] != "app-server"
        || args[1] != "generate-json-schema"
        || args[2] != "--out"
    {
        return false;
    }
    let output = PathBuf::from(&args[3]);
    let mode = get_str(config, "codexConfigSchemaMode", "native");
    let path = if mode == "wrong-path" {
        output.join("ConfigReadResponse.json")
    } else {
        output.join("v2").join("ConfigReadResponse.json")
    };
    if std::fs::create_dir_all(path.parent().unwrap_or(&output)).is_err() {
        exit(8);
    }
    if mode == "malformed" {
        if std::fs::write(path, b"{not-json").is_err() {
            exit(8);
        }
        return true;
    }

    let property = if mode == "missing-property" {
        serde_json::json!({})
    } else {
        serde_json::json!({
            "model_reasoning_effort": {
                "anyOf": [
                    {"$ref": "#/definitions/ReasoningEffort"},
                    {"type": "null"}
                ]
            }
        })
    };
    let mut reasoning = serde_json::json!({
        "description": "Reasoning effort accepted by this deterministic Codex fixture.",
        "minLength": 1,
        "type": "string"
    });
    if let Some(efforts) = config
        .get("codexReasoningEfforts")
        .and_then(Value::as_array)
    {
        let Some(reasoning) = reasoning.as_object_mut() else {
            exit(8);
        };
        reasoning.insert("enum".into(), Value::Array(efforts.clone()));
    }
    let schema = serde_json::json!({
        "definitions": {
            "Config": {"properties": property},
            "ReasoningEffort": reasoning
        }
    });
    let encoded = match serde_json::to_vec(&schema) {
        Ok(encoded) => encoded,
        Err(_) => exit(8),
    };
    if std::fs::write(path, encoded).is_err() {
        exit(8);
    }
    true
}

fn get_i64(config: &Value, key: &str, default: i64) -> i64 {
    config.get(key).and_then(Value::as_i64).unwrap_or(default)
}

fn sleep_ms(ms: i64) {
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(u64::try_from(ms).unwrap_or(0)));
    }
}

fn exit(code: i64) -> ! {
    std::process::exit(i32::try_from(code).unwrap_or(1))
}

/// A task containing this token makes an interactive fake pane exit with the configured code,
/// whatever context a launcher adds around it (a Squad member's task is followed by its Squad
/// context, and pasted text reaches the fake through ConPTY as one line).
const EXIT_TOKEN: &str = "FAKE_PROVIDER_EXIT";

/// Appends one line per start to `runs.log` beside the executable: its file name and
/// arguments. Tests use it to prove which copy ran (and that planted copies never did).
///
/// Concurrent starts (fan-out tests launch several panes at once) append to the same file, so
/// each record and its newline go out in ONE append. `writeln!` issues the text and the newline
/// as separate writes, and two processes interleaving between them merge records onto one
/// unparseable line, which tests then miscount as missing launches.
fn record_run(args: &[String], config: &Value) {
    // Immutable managed-runtime tests model native provider distributions, whose read-only
    // capability probes do not rewrite their installation directory. Existing process fixtures
    // keep the historical adjacent run log unless they opt out explicitly.
    if config
        .get("recordAdjacentArtifacts")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return;
    }
    let name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let mut line = serde_json::json!({ "exe": name, "args": args }).to_string();
    line.push('\n');
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(artifact_dir().join("runs.log"))
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Minimal deterministic Codex app-server used by managed-account persistence tests.
/// It implements the read-only account and paginated model discovery calls KalCode uses; it
/// never reads credentials or contacts a provider. The first account read can be delayed so a
/// launcher can prove it preempts background validation instead of waiting for it.
fn codex_app_server(config: &Value) -> ! {
    let Some(codex_home) = std::env::var_os("CODEX_HOME").map(PathBuf::from) else {
        exit(8);
    };
    let reported_home = config
        .get("codexReportedHome")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home.clone());
    let user_agent = format!("codex_cli_rs/{}", codex_semver(config));
    // KalCode's compatibility smoke runs the app-server against a disposable, credential-free
    // home (`.kalcode-codex-compat-*/home`). A real Codex answers that read locally and at once,
    // with no account; the fixture's delayed, signed-in reads model a person's account home.
    let disposable_probe_home = codex_home
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".kalcode-codex-compat-"));
    let marker = codex_home.join(".kalcode-fake-first-account-read");
    let delay_ms = get_i64(config, "codexFirstAccountReadDelayMs", 0);
    let plan = get_str(config, "codexPlan", "pro").to_owned();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            exit(8);
        };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            exit(8);
        };
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            continue;
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };

        let result = match method {
            "initialize" => serde_json::json!({
                "userAgent": &user_agent,
                "codexHome": &reported_home,
                "platformFamily": if cfg!(windows) { "windows" } else { "unix" },
                "platformOs": std::env::consts::OS,
            }),
            "account/read" => {
                if request
                    .get("params")
                    .and_then(|params| params.get("refreshToken"))
                    .and_then(Value::as_bool)
                    != Some(false)
                {
                    exit(8);
                }
                if disposable_probe_home {
                    let response = serde_json::json!({
                        "id": id,
                        "result": {"account": null, "requiresOpenaiAuth": true},
                    });
                    if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                        exit(8);
                    }
                    continue;
                }
                match std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&marker)
                {
                    Ok(mut file) => {
                        if writeln!(file, "entered").is_err() || file.flush().is_err() {
                            exit(8);
                        }
                        sleep_ms(delay_ms);
                        if writeln!(file, "complete").is_err() || file.flush().is_err() {
                            exit(8);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => exit(8),
                }
                serde_json::json!({
                    "account": {
                        "type": "chatgpt",
                        "email": "codex-e2e@example.test",
                        "planType": plan,
                    },
                    "requiresOpenaiAuth": true,
                })
            }
            "model/list" => {
                let params = request.get("params").and_then(Value::as_object);
                if params
                    .and_then(|value| value.get("includeHidden"))
                    .and_then(Value::as_bool)
                    != Some(false)
                    || params
                        .and_then(|value| value.get("limit"))
                        .and_then(Value::as_u64)
                        != Some(100)
                {
                    exit(8);
                }
                match params
                    .and_then(|value| value.get("cursor"))
                    .and_then(Value::as_str)
                {
                    None => serde_json::json!({
                        "data": [{
                            "id": "catalog-entry-a",
                            "model": "codex-test-exact-a",
                            "displayName": "Codex test exact A",
                            "description": "Deterministic default model from the managed account fixture.",
                            "defaultReasoningEffort": "high",
                            "supportedReasoningEfforts": [
                                {"reasoningEffort": "low", "description": "Fast fixture reasoning"},
                                {"reasoningEffort": "high", "description": "Deep fixture reasoning"}
                            ],
                            "isDefault": true,
                            "hidden": false
                        }],
                        "nextCursor": "page-2"
                    }),
                    Some("page-2") => serde_json::json!({
                        "data": [{
                            "id": "catalog-entry-b",
                            "model": "codex-test-exact-b",
                            "displayName": "Codex test exact B",
                            "description": "Deterministic second-page model from the managed account fixture.",
                            "defaultReasoningEffort": "medium",
                            "supportedReasoningEfforts": [
                                {"reasoningEffort": "medium", "description": "Balanced fixture reasoning"},
                                {"reasoningEffort": "xhigh", "description": "Maximum fixture reasoning"}
                            ],
                            "isDefault": false,
                            "hidden": false
                        }],
                        "nextCursor": null
                    }),
                    Some(_) => exit(8),
                }
            }
            // Like the native JSON-RPC server, a request this fixture does not implement (for
            // example `hooks/list`, which hook-capable Codex releases answer) gets an immediate
            // "method not found" error rather than silence, so a caller never waits out its
            // timeout on a live fixture process.
            _ => {
                let response = serde_json::json!({
                    "id": id,
                    "error": {"code": -32601, "message": format!("method not found: {method}")},
                });
                if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                    exit(8);
                }
                continue;
            }
        };
        let response = serde_json::json!({ "id": id, "result": result });
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            exit(8);
        }
    }
    exit(0)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("hook") {
        // Stand-in for `kalcode-hook` in tests (the helper binary lives in another package):
        // the same library code, so the real protocol and failure policy run.
        run_hook_helper(&args[1..]);
    }
    let config = config();
    record_run(&args, &config);
    if args.first().map(String::as_str) == Some("--fake-grandchild") {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    let stem = std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.file_stem()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
        })
        .unwrap_or_default();
    // Started as `node.exe <package script> …` (an npm shim KalCode resolved): behave as the
    // CLI the script belongs to.
    let script = (stem == "node")
        .then(|| args.first().filter(|a| a.ends_with(".js")).cloned())
        .flatten()
        .map(|s| s.to_ascii_lowercase());
    let args: Vec<String> = if script
        .as_deref()
        .is_some_and(|s| s.contains("codex") || s.contains("gemini"))
    {
        args[1..].to_vec()
    } else {
        args
    };
    let named =
        |cli: &str| stem.starts_with(cli) || script.as_deref().is_some_and(|s| s.contains(cli));
    let kind = if named("codex") {
        "codex"
    } else if named("gemini") {
        "gemini"
    } else if named("cursor-agent") {
        "cursor"
    } else {
        "claude"
    };

    if args.iter().any(|a| a == "--version") {
        sleep_ms(get_i64(&config, "versionDelayMs", 0));
        let default = match kind {
            "codex" => "codex-cli 0.160.0",
            "gemini" => "0.21.0",
            "cursor" => "2026.10.01-e373342",
            _ => "2.1.300 (Claude Code)",
        };
        println!("{}", provider_version(&config, kind, default));
        exit(get_i64(&config, "versionExit", 0));
    }
    if kind == "codex"
        && let Some(help) = codex_help(&config, &args)
    {
        print!("{help}");
        exit(get_i64(&config, "helpExit", 0));
    }
    if kind == "codex" && codex_config_schema(&config, &args) {
        exit(get_i64(&config, "codexConfigSchemaExit", 0));
    }
    if kind == "cursor" && args.first().is_some_and(|arg| arg == "status") {
        println!(
            "{{\"status\":\"authenticated\",\"isAuthenticated\":true,\"userInfo\":{{\"email\":\"cursor@example.test\"}}}}"
        );
        exit(0);
    }
    if kind == "cursor" && args.first().is_some_and(|arg| arg == "models") {
        if !artifact_dir().join("cursor-login-completed").exists()
            && let Some(failure) = config.get("cursorModelFailure").and_then(Value::as_str)
        {
            eprintln!("{failure}");
            exit(1);
        }
        println!(
            "Available models\n\ncustom-runtime-v9 - Custom Runtime 9 (default)\nTip: use --model <id>"
        );
        exit(0);
    }
    if kind == "cursor" && args.first().is_some_and(|arg| arg == "login") {
        let _ = std::fs::write(artifact_dir().join("cursor-login-completed"), "signed in");
        exit(0);
    }
    if kind == "codex" && args.iter().any(|arg| arg == "app-server") {
        codex_app_server(&config);
    }
    if kind == "codex" && args.first().map(String::as_str) == Some("exec") {
        record_invocation(&args, &config);
        turns::codex_exec(&config, &args);
    }
    if kind == "gemini" && args.iter().any(|a| a == "--output-format") {
        record_invocation(&args, &config);
        turns::gemini_headless(&config, &args);
    }
    if kind != "claude" && !args.starts_with(&["login".into(), "status".into()]) {
        record_invocation(&args, &config);
        turns::interactive(kind, &config, &args);
    }
    if args.starts_with(&["auth".into(), "status".into()]) {
        // Mirrors `claude auth status`: JSON on stdout, exit 0 signed in / 1 signed out.
        let code = get_i64(&config, "authExit", 0);
        println!(
            "{{\"loggedIn\":{},\"email\":\"person@example.com\"}}",
            code == 0
        );
        exit(code);
    }
    if args.starts_with(&["login".into(), "status".into()]) {
        eprintln!(
            "{}",
            get_str(&config, "loginStatus", "Logged in using ChatGPT")
        );
        exit(get_i64(&config, "loginExit", 0));
    }
    if args.iter().any(|a| a == "-p") {
        record_invocation(&args, &config);
        session(&config, &args);
        return;
    }
    if args.iter().any(|a| a == "--settings") {
        record_invocation(&args, &config);
        interactive::run(&config, &args);
    }
    eprintln!("fake provider: unsupported arguments");
    exit(2);
}

fn record_invocation(args: &[String], config: &Value) {
    if config
        .get("recordAdjacentArtifacts")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return;
    }
    let dir = artifact_dir();
    let _ = std::fs::write(
        dir.join("last-args.json"),
        serde_json::to_string(args).unwrap_or_default(),
    );
    let mut names: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .collect();
    names.sort();
    let _ = std::fs::write(
        dir.join("last-env.json"),
        serde_json::to_string(&names).unwrap_or_default(),
    );
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let _ = std::fs::write(dir.join("last-cwd.txt"), cwd);
}

fn session_id(args: &[String]) -> String {
    args.iter()
        .position(|a| a == "--session-id" || a == "--resume")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default()
}

struct Out {
    session_id: String,
    cwd: String,
}

impl Out {
    fn emit(&self, fixture: &str) {
        let mut stdout = std::io::stdout().lock();
        for line in fixture.lines().filter(|l| !l.is_empty()) {
            let line = line
                .replace("{SESSION_ID}", &self.session_id)
                .replace("{CWD}", &self.cwd);
            let _ = writeln!(stdout, "{line}");
            let _ = stdout.flush();
        }
    }

    fn raw(&self, line: &str) {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    }
}

fn session(config: &Value, args: &[String]) {
    let scenario = get_str(config, "session", "happy");
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let escaped = serde_json::to_string(&cwd).unwrap_or_default();
    let out = Out {
        session_id: session_id(args),
        cwd: escaped.trim_matches('"').to_owned(),
    };
    if let Some(text) = config.get("stderr").and_then(Value::as_str) {
        eprintln!("{text}");
    }

    if scenario == "hang" {
        // Ignores its input entirely (even end of input) and starts a child of its own, so tests
        // can check that the whole process tree is killed.
        if let Ok(exe) = std::env::current_exe()
            && let Ok(child) = hidden_command(exe)
                .arg("--fake-grandchild")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        {
            let _ = std::fs::write(
                artifact_dir().join("grandchild.pid"),
                child.id().to_string(),
            );
        }
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    let mut started = false;
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("user") => {
                if !started {
                    out.emit(INIT);
                    started = true;
                }
                match scenario {
                    "crash_after_init" => {
                        out.emit(TURN_TEXT.lines().next().unwrap_or(""));
                        eprintln!(
                            "fatal: upstream rejected api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"
                        );
                        exit(3);
                    }
                    "host_request" => {
                        out.raw(r#"{"type":"control_request","request_id":"req_1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf build"}}}"#);
                        continue;
                    }
                    "flood" => {
                        out.raw(&format!(
                            r#"{{"type":"assistant","padding":"{}"}}"#,
                            "x".repeat(9 * 1024 * 1024)
                        ));
                    }
                    _ => {}
                }
                let text = message
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                sleep_ms(get_i64(config, "turnDelayMs", 0));
                out.emit(if text.contains("tools") {
                    TURN_TOOLS
                } else if text.contains("malformed") {
                    TURN_MALFORMED
                } else {
                    TURN_TEXT
                });
            }
            Some("control_request") => {
                let subtype = message
                    .get("request")
                    .and_then(|r| r.get("subtype"))
                    .and_then(Value::as_str);
                if subtype == Some("interrupt") && scenario != "no_interrupt_ack" {
                    let id = message
                        .get("request_id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    out.raw(&format!(
                        r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"{id}","response":{{"still_queued":[]}}}}}}"#
                    ));
                    out.emit(INTERRUPTED);
                }
            }
            _ => {}
        }
    }
    // End of input: exit normally, like `claude -p` with stream-JSON input.
    exit(get_i64(config, "exitCode", 0));
}

/// Codex `exec --json` and Gemini CLI `stream-json` stand-ins: one process per turn, the prompt
/// read from stdin (recorded in `last-stdin.txt`), fixtures chosen by words in the prompt.
/// Interactive Codex / Gemini CLI panes: a minimal TUI with the documented status channels
/// (Codex `notify` program and OSC 9; Gemini CLI process state only).
mod turns {
    use std::io::{Read, Write};

    use serde_json::Value;

    use super::{Out, artifact_dir, exit, get_i64, hidden_command, sleep_ms};

    const CODEX_FIRST: &str = r#"{"type":"thread.started","thread_id":"{SESSION_ID}"}"#;

    fn read_prompt(config: &Value) -> String {
        let mut text = String::new();
        let _ = std::io::stdin().read_to_string(&mut text);
        if config
            .get("recordAdjacentArtifacts")
            .and_then(Value::as_bool)
            != Some(false)
        {
            let _ = std::fs::write(artifact_dir().join("last-stdin.txt"), &text);
        }
        text
    }

    fn value_after(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    }

    fn out(session_id: String) -> Out {
        let cwd = std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let escaped = serde_json::to_string(&cwd).unwrap_or_default();
        Out {
            session_id,
            cwd: escaped.trim_matches('"').to_owned(),
        }
    }

    fn hang() -> ! {
        if let Ok(exe) = std::env::current_exe()
            && let Ok(child) = hidden_command(exe)
                .arg("--fake-grandchild")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        {
            let _ = std::fs::write(
                artifact_dir().join("grandchild.pid"),
                child.id().to_string(),
            );
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }

    pub fn codex_exec(config: &Value, args: &[String]) -> ! {
        let prompt = read_prompt(config);
        let session =
            value_after(args, "resume").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let out = out(session);
        sleep_ms(get_i64(config, "turnDelayMs", 0));
        if prompt.contains("hang") {
            hang();
        }
        if prompt.contains("crash") {
            out.emit(CODEX_FIRST);
            eprintln!(
                "fatal: upstream rejected api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
            );
            exit(3);
        }
        if let Some(marker) = config.get("codexTurnMarker").and_then(Value::as_str) {
            out.emit(CODEX_FIRST);
            out.raw(r#"{"type":"turn.started"}"#);
            out.raw(
                &serde_json::json!({
                    "type": "item.completed",
                    "item": {"id": "runtime-marker", "type": "agent_message", "text": marker}
                })
                .to_string(),
            );
            out.raw(r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#);
            exit(get_i64(config, "exitCode", 0));
        }
        let fixture = if prompt.contains("tools") {
            super::CODEX_TOOLS
        } else if prompt.contains("fail") {
            super::CODEX_FAILED
        } else {
            super::CODEX_TEXT
        };
        out.emit(fixture);
        if prompt.contains("malformed") {
            out.raw("not json at all");
        }
        exit(if prompt.contains("fail") {
            1
        } else {
            get_i64(config, "exitCode", 0)
        })
    }

    pub fn gemini_headless(config: &Value, args: &[String]) -> ! {
        let prompt = read_prompt(config);
        let session =
            value_after(args, "--resume").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let out = out(session);
        sleep_ms(get_i64(config, "turnDelayMs", 0));
        if prompt.contains("hang") {
            hang();
        }
        if prompt.contains("crash") {
            eprintln!("fatal: api_key=AIzaSyA-abcdefghijklmnopqrstuvwxyz012345 rejected");
            exit(1);
        }
        if prompt.contains("quota") {
            out.emit(super::GEMINI_QUOTA);
            exit(1);
        }
        out.emit(if prompt.contains("tools") {
            super::GEMINI_TOOLS
        } else {
            super::GEMINI_TEXT
        });
        exit(get_i64(config, "exitCode", 0))
    }

    fn say(text: &str) {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "{text}\r\n");
        let _ = out.flush();
    }

    /// Parses a TOML literal-string array (`['a','b']`) as KalCode writes `notify`.
    fn literal_array(value: &str) -> Vec<String> {
        value
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|item| item.trim().trim_matches('\'').to_owned())
            .filter(|item| !item.is_empty())
            .collect()
    }

    fn notify_command(args: &[String]) -> Option<Vec<String>> {
        args.iter()
            .enumerate()
            .filter(|(_, a)| *a == "-c")
            .filter_map(|(i, _)| args.get(i + 1))
            .find_map(|c| c.strip_prefix("notify=").map(literal_array))
    }

    #[derive(Default)]
    struct InteractiveInput {
        bracketed: Option<String>,
    }

    impl InteractiveInput {
        fn is_bracketed(&self) -> bool {
            self.bracketed.is_some()
        }

        fn push_line(&mut self, line: &str) -> Option<String> {
            const START: &str = "\x1b[200~";
            const END: &str = "\x1b[201~";

            if let Some(buffer) = self.bracketed.as_mut() {
                if let Some(end) = line.find(END) {
                    buffer.push_str(&line[..end]);
                    return self.bracketed.take();
                }
                buffer.push_str(line);
                return None;
            }
            if let Some(start) = line.find(START) {
                let payload = &line[start + START.len()..];
                if let Some(end) = payload.find(END) {
                    return Some(payload[..end].to_owned());
                }
                self.bracketed = Some(payload.to_owned());
                return None;
            }
            Some(line.trim().to_owned())
        }
    }

    pub fn interactive(kind: &str, config: &Value, args: &[String]) -> ! {
        let name = if kind == "codex" {
            "Codex"
        } else {
            "Gemini CLI"
        };
        say(&format!(
            "KalCode fake provider (interactive {name}). No AI service is contacted."
        ));
        let thread = uuid::Uuid::new_v4().to_string();
        let notify = notify_command(args);
        let mut line = String::new();
        let mut turn = 0u64;
        let mut input = InteractiveInput::default();
        loop {
            if !input.is_bracketed() {
                let mut out = std::io::stdout().lock();
                let _ = write!(out, "> ");
                let _ = out.flush();
            }
            line.clear();
            match std::io::stdin().read_line(&mut line) {
                Ok(0) | Err(_) => exit(0),
                Ok(_) => {}
            }
            let Some(text) = input.push_line(&line) else {
                continue;
            };
            if text == "exit" || text.contains(super::EXIT_TOKEN) {
                exit(get_i64(config, "exitCode", 0));
            }
            if kind == "codex" && text == "approve" {
                // `tui.notifications=['approval-requested']` with `osc9`: an OSC 9 sequence.
                let mut out = std::io::stdout().lock();
                let _ = write!(out, "\x1b]9;Approval requested: cargo build\x07");
                let _ = write!(out, "[fake prompt] Allow cargo build? (y/n) ");
                let _ = out.flush();
                continue;
            }
            say(&format!("(fake) {text}"));
            if kind == "codex"
                && let Some(command) = &notify
                && let Some((program, rest)) = command.split_first()
            {
                turn = turn.saturating_add(1);
                // `notify`: Codex runs the program with the JSON payload as its last argument.
                let payload = serde_json::json!({
                    "type": "agent-turn-complete",
                    "thread-id": thread,
                    "turn-id": format!("turn-{turn}"),
                    "cwd": std::env::current_dir()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default(),
                    "input-messages": [text],
                    "last-assistant-message": "Status: FAILED (prose, never status)",
                });
                let _ = hidden_command(program)
                    .args(rest)
                    .arg(payload.to_string())
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::InteractiveInput;

        #[test]
        fn bracketed_multiline_input_is_one_submitted_turn() {
            let mut input = InteractiveInput::default();
            let submissions = [
                input.push_line("\x1b[200~context marker\n"),
                input.push_line("review details\n"),
                input.push_line("final line\x1b[201~\r\n"),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

            assert_eq!(submissions, ["context marker\nreview details\nfinal line"]);
            assert_eq!(
                input.push_line("ordinary prompt\r\n"),
                Some("ordinary prompt".into())
            );
        }
    }
}

fn run_hook_helper(args: &[String]) -> ! {
    use kalcode_hook_bridge::helper::{self, HelperEnv};
    let blocking = helper::is_blocking_invocation(args);
    std::panic::set_hook(Box::new(move |_| {
        std::process::exit(if blocking { 2 } else { 0 });
    }));
    let rendered = helper::run(
        args,
        &mut std::io::stdin().lock(),
        &HelperEnv::from_process(),
    );
    print!("{}", rendered.stdout);
    eprint!("{}", rendered.stderr);
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(rendered.exit_code);
}

/// Interactive mode: a minimal TUI that behaves like Claude Code's for hooks. It runs the hook
/// commands from the `--settings` file with the documented payload shapes and honours their
/// exit codes and decisions exactly as the hooks reference describes. Prompts are lines typed
/// into the pane:
///
/// - `run <command>`: a Bash tool call; `edit <path>`: a Write tool call;
/// - `say <text>`: prints text only (prose that must never change KalCode's status);
/// - `fail`: a StopFailure (rate limit); `exit`: SessionEnd, then exit.
///
/// When a PreToolUse hook gives no decision or asks, the fake shows its own prompt
/// (`Allow …? (y/n)`) and reads the answer from the pane, as the real TUI would.
mod interactive {
    use std::io::{BufRead, Write};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};

    use super::{exit, get_i64, hidden_command};

    struct Hooks {
        settings: Value,
        session_id: String,
        cwd: String,
        enabled: bool,
    }

    struct HookResult {
        code: i32,
        stdout: String,
        stderr: String,
    }

    impl Hooks {
        fn fire(&self, event: &str, mut payload: Value) -> HookResult {
            let none = HookResult {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            };
            if !self.enabled {
                return none;
            }
            let Some(handler) = self.settings["hooks"][event][0]["hooks"][0].as_object() else {
                return none;
            };
            let Some(program) = handler.get("command").and_then(Value::as_str) else {
                return none;
            };
            let args: Vec<String> = handler
                .get("args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let timeout = handler
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(600);
            if let Some(object) = payload.as_object_mut() {
                object.insert("session_id".into(), json!(self.session_id));
                object.insert("hook_event_name".into(), json!(event));
                object.insert("cwd".into(), json!(self.cwd));
                object.insert("transcript_path".into(), json!("/fake/transcript.jsonl"));
            }
            let Ok(mut child) = hidden_command(program)
                .args(&args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            else {
                // A hook that can't start is a non-blocking error.
                return HookResult { code: 1, ..none };
            };
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(payload.to_string().as_bytes());
            }
            let started = Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if started.elapsed() > Duration::from_secs(timeout) => {
                        // A timed-out hook renders no decision.
                        let _ = child.kill();
                        return none;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                    Err(_) => return none,
                }
            }
            match child.wait_with_output() {
                Ok(output) => HookResult {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                },
                Err(_) => none,
            }
        }
    }

    fn say(text: &str) {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "{text}\r\n");
        let _ = out.flush();
    }

    fn prompt() {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "> ");
        let _ = out.flush();
    }

    fn read_line() -> Option<String> {
        let mut line = String::new();
        match std::io::stdin().lock().read_line(&mut line) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(line.trim().to_owned()),
        }
    }

    fn value_after(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    }

    /// Runs one tool call through the hooks; returns whether it ran.
    fn tool_call(hooks: &Hooks, n: u32, tool: &str, input: Value) -> bool {
        let tool_use_id = format!("toolu_fake_{n}");
        let pre = hooks.fire(
            "PreToolUse",
            json!({"tool_name": tool, "tool_input": input, "tool_use_id": tool_use_id}),
        );
        if pre.code == 2 {
            say(&format!("BLOCKED BY HOOK: {}", pre.stderr.trim()));
            return false;
        }
        let decision = if pre.code == 0 && pre.stdout.trim_start().starts_with('{') {
            serde_json::from_str::<Value>(&pre.stdout)
                .ok()
                .and_then(|v| {
                    v["hookSpecificOutput"]["permissionDecision"]
                        .as_str()
                        .map(str::to_owned)
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        let allowed = match decision.as_str() {
            "allow" => true,
            "deny" => {
                say("DENIED BY HOOK");
                false
            }
            // No decision or "ask": the provider's own prompt, answered in the pane.
            _ => {
                hooks.fire(
                    "PermissionRequest",
                    json!({"tool_name": tool, "tool_input": input, "tool_use_id": tool_use_id}),
                );
                let mut out = std::io::stdout().lock();
                let _ = write!(out, "[fake prompt] Allow {tool}? (y/n) ");
                let _ = out.flush();
                drop(out);
                let yes = read_line().is_some_and(|a| a.eq_ignore_ascii_case("y"));
                if !yes {
                    say("DENIED IN PROVIDER PROMPT");
                }
                yes
            }
        };
        if allowed {
            say(&format!("RAN {tool}"));
            hooks.fire(
                "PostToolUse",
                json!({"tool_name": tool, "tool_input": input, "tool_use_id": tool_use_id,
                       "tool_output": {"stdout": "fake output"}}),
            );
        }
        allowed
    }

    pub fn run(config: &Value, args: &[String]) -> ! {
        let settings = value_after(args, "--settings")
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(Value::Null);
        let resumed = args.iter().any(|a| a == "--resume");
        let hooks = Hooks {
            settings,
            session_id: value_after(args, "--session-id")
                .or_else(|| value_after(args, "--resume"))
                .unwrap_or_default(),
            cwd: std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            enabled: config.get("hooks").and_then(Value::as_bool).unwrap_or(true),
        };
        say("KalCode fake provider (interactive). No AI service is contacted.");
        hooks.fire(
            "SessionStart",
            json!({"source": if resumed { "resume" } else { "startup" }}),
        );
        prompt();
        let mut calls = 0u32;
        while let Some(line) = read_line() {
            if line.is_empty() {
                prompt();
                continue;
            }
            if line == "exit" || line.contains(super::EXIT_TOKEN) {
                hooks.fire("SessionEnd", json!({"reason": "prompt_input_exit"}));
                exit(get_i64(config, "exitCode", 0));
            }
            hooks.fire("UserPromptSubmit", json!({"prompt": line}));
            if let Some(command) = line.strip_prefix("run ") {
                calls += 1;
                tool_call(&hooks, calls, "Bash", json!({"command": command}));
            } else if let Some(path) = line.strip_prefix("edit ") {
                calls += 1;
                tool_call(
                    &hooks,
                    calls,
                    "Write",
                    json!({"file_path": path, "content": "x"}),
                );
            } else if let Some(text) = line.strip_prefix("say ") {
                say(text);
            } else if line == "auth-fail" {
                hooks.fire(
                    "StopFailure",
                    json!({"error": "authentication_failed", "error_details": "synthetic expired session"}),
                );
                prompt();
                continue;
            } else if line == "fail" {
                hooks.fire(
                    "StopFailure",
                    json!({"error_type": "rate_limit", "error_message": "slow down"}),
                );
                prompt();
                continue;
            } else {
                say("(fake) ok");
            }
            hooks.fire(
                "Stop",
                json!({"last_assistant_message": "Status: DONE", "tool_use_count": calls}),
            );
            prompt();
        }
        exit(0)
    }
}
