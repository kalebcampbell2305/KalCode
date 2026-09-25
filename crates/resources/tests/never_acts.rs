//! Architecture guard (RG-06): the governor never terminates, suspends or re-prioritises a
//! process. The crate's source must not call any API that could.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::Path;

const FORBIDDEN: &[&str] = &[
    ".kill(",
    "kill_with(",
    "TerminateProcess",
    "SuspendThread",
    "NtSuspendProcess",
    "DebugActiveProcess",
    "SetPriorityClass",
    "taskkill",
    "libc::kill",
    "SIGSTOP",
    "std::process::Command",
    "Command::new",
];

fn scan(dir: &Path, findings: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            scan(&path, findings);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let text = std::fs::read_to_string(&path).unwrap();
            for (n, line) in text.lines().enumerate() {
                for pattern in FORBIDDEN {
                    if line.contains(pattern) {
                        findings.push(format!("{}:{}: {pattern}", path.display(), n + 1));
                    }
                }
            }
        }
    }
}

#[test]
fn source_contains_no_process_control() {
    let mut findings = Vec::new();
    scan(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut findings,
    );
    assert!(
        findings.is_empty(),
        "process control found:\n{}",
        findings.join("\n")
    );
}
