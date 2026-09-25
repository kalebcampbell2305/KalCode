//! Test-support stand-in for a provider CLI. It never contacts any service.
//!
//! Tests copy this executable into a temporary folder under the provider's executable name
//! (`claude.exe`, `codex`, ...) next to a `fake-provider.json` that selects its behaviour, then
//! put that folder on the `PATH` KalCode's detection searches. In session mode it replays the
//! documented stream-JSON fixtures in `tests/fixtures/claude/` so the whole
//! spawn → parse → normalize → event pipeline runs without a real provider.
//!
//! It records what it was started with (`last-args.json`, and the *names* of its environment
//! variables in `last-env.json`) so tests can assert on argv and environment sanitization.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

const INIT: &str = include_str!("../../tests/fixtures/claude/init.jsonl");
const TURN_TEXT: &str = include_str!("../../tests/fixtures/claude/turn_text.jsonl");
const TURN_TOOLS: &str = include_str!("../../tests/fixtures/claude/turn_tools.jsonl");
const TURN_MALFORMED: &str = include_str!("../../tests/fixtures/claude/turn_malformed.jsonl");
const INTERRUPTED: &str = include_str!("../../tests/fixtures/claude/interrupted.jsonl");

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config() -> Value {
    std::fs::read_to_string(exe_dir().join("fake-provider.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn get_str<'a>(config: &'a Value, key: &str, default: &'a str) -> &'a str {
    config.get(key).and_then(Value::as_str).unwrap_or(default)
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

/// Appends one line per start to `runs.log` beside the executable: its file name and
/// arguments. Tests use it to prove which copy ran (and that planted copies never did).
fn record_run(args: &[String]) {
    let name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let line = serde_json::json!({ "exe": name, "args": args }).to_string();
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exe_dir().join("runs.log"))
    {
        let _ = writeln!(file, "{line}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    record_run(&args);
    if args.first().map(String::as_str) == Some("--fake-grandchild") {
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    let config = config();

    if args.iter().any(|a| a == "--version") {
        sleep_ms(get_i64(&config, "versionDelayMs", 0));
        println!("{}", get_str(&config, "version", "2.1.300 (Claude Code)"));
        exit(get_i64(&config, "versionExit", 0));
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
        record_invocation(&args);
        session(&config, &args);
        return;
    }
    eprintln!("fake provider: unsupported arguments");
    exit(2);
}

fn record_invocation(args: &[String]) {
    let dir = exe_dir();
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
            && let Ok(child) = std::process::Command::new(exe)
                .arg("--fake-grandchild")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        {
            let _ = std::fs::write(exe_dir().join("grandchild.pid"), child.id().to_string());
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
