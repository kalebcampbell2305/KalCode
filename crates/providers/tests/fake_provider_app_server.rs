//! Read-only Codex app-server contract exposed by the no-network provider fixture.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{Value, json};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");

fn fixture_dir() -> std::io::Result<tempfile::TempDir> {
    if cfg!(windows) {
        return tempfile::tempdir();
    }
    let parent = Path::new(FAKE).parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "fake provider executable has no parent",
        )
    })?;
    tempfile::Builder::new()
        .prefix("kalcode-fake-provider-app-server-")
        .tempdir_in(parent)
}

fn publish_as_codex(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    if cfg!(windows) {
        std::fs::copy(FAKE, &path)?;
    } else {
        std::fs::hard_link(FAKE, &path)?;
    }
    Ok(path)
}

struct AppServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl AppServer {
    fn start(executable: &Path, codex_home: &Path) -> std::io::Result<Self> {
        let mut child = Command::new(executable)
            .arg("app-server")
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("missing fake app-server stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("missing fake app-server stdout"))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        writeln!(
            self.stdin,
            "{}",
            json!({"id": id, "method": method, "params": params})
        )
        .expect("write fake app-server request");
        self.stdin.flush().expect("flush fake app-server request");
        let mut line = String::new();
        self.stdout
            .read_line(&mut line)
            .expect("read fake app-server response");
        let response: Value = serde_json::from_str(&line).expect("valid fake app-server JSON");
        assert_eq!(response["id"], id);
        response["result"].clone()
    }

    fn finish(self) {
        drop(self.stdin);
        let output = self
            .child
            .wait_with_output()
            .expect("wait for fake app-server");
        assert!(output.status.success(), "{output:?}");
    }
}

#[test]
fn codex_model_list_is_exact_account_scoped_and_paginated() {
    let fixture = fixture_dir().expect("fixture directory");
    let codex_home = fixture.path().join("codex-home");
    std::fs::create_dir(&codex_home).expect("managed Codex home");
    std::fs::write(
        fixture.path().join("fake-provider.json"),
        r#"{"versions":{"codex":"codex-cli 0.160.0"}}"#,
    )
    .expect("fake provider config");
    let executable = publish_as_codex(fixture.path()).expect("Codex fixture alias");
    let mut server = AppServer::start(&executable, &codex_home).expect("start fake app-server");

    let initialized = server.request(1, "initialize", json!({}));
    assert_eq!(
        initialized["codexHome"],
        codex_home.to_string_lossy().as_ref()
    );

    let first = server.request(
        2,
        "model/list",
        json!({"cursor": null, "includeHidden": false, "limit": 100}),
    );
    assert_eq!(first["nextCursor"], "page-2");
    assert_eq!(first["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(first["data"][0]["id"], "catalog-entry-a");
    assert_eq!(first["data"][0]["model"], "codex-test-exact-a");
    assert_eq!(first["data"][0]["isDefault"], true);
    assert_eq!(first["data"][0]["defaultReasoningEffort"], "high");
    assert_eq!(
        first["data"][0]["supportedReasoningEfforts"]
            .as_array()
            .map(Vec::len),
        Some(2)
    );

    let second = server.request(
        3,
        "model/list",
        json!({"cursor": "page-2", "includeHidden": false, "limit": 100}),
    );
    assert!(second["nextCursor"].is_null());
    assert_eq!(second["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(second["data"][0]["id"], "catalog-entry-b");
    assert_eq!(second["data"][0]["model"], "codex-test-exact-b");
    assert_eq!(second["data"][0]["isDefault"], false);
    assert_eq!(second["data"][0]["defaultReasoningEffort"], "medium");
    assert_ne!(
        first["data"][0]["supportedReasoningEfforts"],
        second["data"][0]["supportedReasoningEfforts"]
    );

    server.finish();
}
