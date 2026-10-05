//! One provider-neutral tool classifier: a provider's tool name plus its structured tool input
//! gives the shared working status (RUNNING COMMAND, EDITING, TESTING or RUNNING TOOL).
//!
//! It reads only the structured hook record: the tool name and the `command` field the provider
//! is about to run. Model prose, terminal output and PTY bytes never reach it. Test detection is
//! deliberately conservative: a whole-word test runner as the program of a command segment
//! (`cargo test`, `pnpm vitest`, `python -m pytest` …). Anything it doesn't recognise is plain
//! RUNNING COMMAND, never a guess.
//!
//! Tool names (verified or documented per provider):
//! - Claude Code: `Bash`, `PowerShell`; `Edit`, `Write`, `MultiEdit`, `NotebookEdit`.
//! - Codex 0.160 hooks: `Bash` (its shell tool, every platform), `apply_patch`; `shell`,
//!   `local_shell`, `exec_command` and `unified_exec` cover its other shell tool spellings.
//! - Gemini CLI: `run_shell_command`; `replace`, `write_file`, `edit`.

use kalcode_contracts::threads::ThreadStatus;
use serde_json::Value;

const SHELL_TOOLS: &[&str] = &[
    "Bash",
    "PowerShell",
    "shell",
    "local_shell",
    "exec_command",
    "unified_exec",
    "run_shell_command",
];

const EDIT_TOOLS: &[&str] = &[
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "apply_patch",
    "replace",
    "write_file",
    "edit",
];

/// Whether the tool edits files (any provider).
pub(crate) fn is_edit_tool(tool: &str) -> bool {
    EDIT_TOOLS.contains(&tool)
}

/// The working status for a tool the provider is about to run.
pub(crate) fn classify(tool: &str, input: Option<&Value>) -> ThreadStatus {
    if is_edit_tool(tool) {
        return ThreadStatus::Editing;
    }
    if !SHELL_TOOLS.contains(&tool) {
        return ThreadStatus::RunningTool;
    }
    match input.and_then(shell_command) {
        Some(command) if runs_tests(&command) => ThreadStatus::Testing,
        _ => ThreadStatus::RunningCommand,
    }
}

/// The command a shell tool runs: a string (`command` or `cmd`), or an argv array.
fn shell_command(input: &Value) -> Option<String> {
    let field = input.get("command").or_else(|| input.get("cmd"))?;
    match field {
        Value::String(command) => Some(command.clone()),
        Value::Array(parts) => {
            let parts: Option<Vec<&str>> = parts.iter().map(Value::as_str).collect();
            Some(
                parts?
                    .iter()
                    .map(|part| {
                        if part.contains(char::is_whitespace) {
                            format!("\"{part}\"")
                        } else {
                            (*part).to_owned()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        }
        _ => None,
    }
}

/// Longest command inspected; larger commands are plain RUNNING COMMAND.
const MAX_COMMAND_CHARS: usize = 16 * 1024;
/// How deep `bash -lc "…"` style wrappers are followed.
const MAX_WRAPPER_DEPTH: usize = 3;

/// Whether any segment of a shell command runs a test runner.
pub(crate) fn runs_tests(command: &str) -> bool {
    runs_tests_at(command, 0)
}

fn runs_tests_at(command: &str, depth: usize) -> bool {
    if depth > MAX_WRAPPER_DEPTH || command.chars().count() > MAX_COMMAND_CHARS {
        return false;
    }
    segments(command)
        .iter()
        .any(|words| segment_runs_tests(words, depth))
}

/// Splits a command into segments of words at unquoted `;`, `&`, `|` and newlines. Quotes group
/// words (and are removed); nothing is expanded.
fn segments(command: &str) -> Vec<Vec<String>> {
    let mut segments = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    for character in command.chars() {
        match quote {
            Some(open) if character == open => quote = None,
            Some(_) => word.push(character),
            None => match character {
                '\'' | '"' => {
                    quote = Some(character);
                    in_word = true;
                }
                ';' | '&' | '|' | '\n' | '\r' | '(' | ')' | '{' | '}' => {
                    if in_word {
                        words.push(std::mem::take(&mut word));
                        in_word = false;
                    }
                    if !words.is_empty() {
                        segments.push(std::mem::take(&mut words));
                    }
                }
                c if c.is_whitespace() => {
                    if in_word {
                        words.push(std::mem::take(&mut word));
                        in_word = false;
                    }
                }
                c => {
                    word.push(c);
                    in_word = true;
                }
            },
        }
    }
    if in_word {
        words.push(word);
    }
    if !words.is_empty() {
        segments.push(words);
    }
    segments
}

/// The program name of a word: its file name, lowercase, without a Windows executable suffix.
fn program(word: &str) -> String {
    let name = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let lower = name.to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stem) = lower.strip_suffix(suffix) {
            return stem.to_owned();
        }
    }
    lower
}

/// The first word that isn't an option (`-x`, `--x`, `+toolchain`).
fn first_operand(words: &[String]) -> Option<&str> {
    words
        .iter()
        .map(String::as_str)
        .find(|word| !word.starts_with('-') && !word.starts_with('+'))
}

fn is_test_script(name: &str) -> bool {
    name == "test" || name.starts_with("test:")
}

fn segment_runs_tests(words: &[String], depth: usize) -> bool {
    // Leading environment assignments (`RUST_LOG=debug cargo test`).
    let assignment = |word: &String| {
        word.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
        })
    };
    let start = words
        .iter()
        .position(|word| !assignment(word))
        .unwrap_or(words.len());
    let words = &words[start..];
    let Some(first) = words.first() else {
        return false;
    };
    let rest = &words[1..];
    let name = program(first);
    match name.as_str() {
        // Shell wrappers: classify the script they run.
        "bash" | "sh" | "zsh" | "dash" | "fish" | "pwsh" | "powershell" | "cmd" => rest
            .iter()
            .position(|word| {
                matches!(
                    word.to_ascii_lowercase().as_str(),
                    "-c" | "-lc" | "-ic" | "/c" | "/k" | "-command" | "-c:"
                )
            })
            .and_then(|index| rest.get(index + 1..))
            .is_some_and(|script| runs_tests_at(&script.join(" "), depth + 1)),
        // Runners that pass through to another program.
        "env" | "time" | "nice" | "sudo" | "npx" | "bunx" | "pnpx" | "dotenv" => {
            let inner: Vec<String> = rest
                .iter()
                .skip_while(|word| word.starts_with('-') || word.contains('='))
                .cloned()
                .collect();
            segment_runs_tests(&inner, depth)
        }
        "cargo" => matches!(first_operand(rest), Some("test" | "nextest" | "t")),
        "npm" | "pnpm" | "yarn" | "bun" => match first_operand(rest) {
            Some("test" | "t") => true,
            Some("run" | "run-script") => {
                let after = rest
                    .iter()
                    .skip_while(|word| word.as_str() != "run" && word.as_str() != "run-script")
                    .skip(1)
                    .cloned()
                    .collect::<Vec<_>>();
                first_operand(&after).is_some_and(is_test_script)
            }
            Some("exec" | "dlx" | "x") => {
                let after = rest
                    .iter()
                    .skip_while(|word| !matches!(word.as_str(), "exec" | "dlx" | "x"))
                    .skip(1)
                    .cloned()
                    .collect::<Vec<_>>();
                segment_runs_tests(&after, depth)
            }
            // `pnpm vitest`, `yarn playwright test`: a package binary run directly.
            Some(other) => {
                let after = rest
                    .iter()
                    .skip_while(|word| word.as_str() != other)
                    .skip(1)
                    .cloned()
                    .collect::<Vec<_>>();
                is_runner_program(&program(other), &after)
            }
            None => false,
        },
        "go" | "dotnet" | "swift" | "deno" | "mix" | "flutter" | "dart" | "zig" => {
            first_operand(rest) == Some("test")
        }
        "mvn" | "mvnw" => rest.iter().any(|word| word == "test" || word == "verify"),
        "gradle" | "gradlew" => rest
            .iter()
            .any(|word| word == "test" || word.ends_with(":test") || word == "check"),
        "make" => first_operand(rest).is_some_and(is_test_script),
        "python" | "python3" | "py" => {
            let mut iter = rest.iter();
            while let Some(word) = iter.next() {
                if word == "-m" {
                    return iter
                        .next()
                        .is_some_and(|module| matches!(module.as_str(), "pytest" | "unittest"));
                }
                if !word.starts_with('-') {
                    return false;
                }
            }
            false
        }
        "uv" | "poetry" | "pipenv" | "hatch" | "pdm" | "rye" => {
            let after = rest
                .iter()
                .skip_while(|word| word.as_str() != "run")
                .skip(1)
                .cloned()
                .collect::<Vec<_>>();
            !after.is_empty() && segment_runs_tests(&after, depth)
        }
        "bundle" => first_operand(rest) == Some("exec") && segment_runs_tests(&rest[1..], depth),
        "rake" | "rails" => first_operand(rest).is_some_and(is_test_script),
        other => is_runner_program(other, rest),
    }
}

/// Test runners invoked as their own program.
fn is_runner_program(name: &str, rest: &[String]) -> bool {
    match name {
        "pytest" | "py.test" | "vitest" | "jest" | "mocha" | "ava" | "rspec" | "phpunit"
        | "pest" | "ctest" | "tox" | "nox" | "nextest" | "cargo-nextest" | "karma" | "tap"
        | "jasmine" | "invoke-pester" => true,
        "playwright" | "cypress" => matches!(first_operand(rest), Some("test" | "run")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shell(tool: &str, command: &str) -> ThreadStatus {
        classify(tool, Some(&json!({ "command": command })))
    }

    #[test]
    fn shell_tools_of_every_provider_run_commands() {
        for tool in [
            "Bash",
            "PowerShell",
            "shell",
            "exec_command",
            "run_shell_command",
        ] {
            assert_eq!(
                shell(tool, "ls -la"),
                ThreadStatus::RunningCommand,
                "{tool}"
            );
            assert_eq!(
                shell(tool, "cargo test -p kalcode"),
                ThreadStatus::Testing,
                "{tool}"
            );
        }
        assert_eq!(
            classify("exec_command", Some(&json!({"cmd": "pnpm test"}))),
            ThreadStatus::Testing
        );
        assert_eq!(
            classify(
                "shell",
                Some(&json!({"command": ["bash", "-lc", "go test ./..."]}))
            ),
            ThreadStatus::Testing
        );
        assert_eq!(classify("Bash", None), ThreadStatus::RunningCommand);
    }

    #[test]
    fn edit_tools_of_every_provider_edit() {
        for tool in [
            "Edit",
            "Write",
            "MultiEdit",
            "NotebookEdit",
            "apply_patch",
            "replace",
            "write_file",
        ] {
            assert_eq!(classify(tool, None), ThreadStatus::Editing, "{tool}");
        }
        for tool in ["Read", "Grep", "WebFetch", "read_file", "mcp__x__y", "bash"] {
            assert_eq!(classify(tool, None), ThreadStatus::RunningTool, "{tool}");
        }
    }

    #[test]
    fn test_runners_are_recognised() {
        for command in [
            "cargo test",
            "cargo +nightly test --workspace",
            "cargo nextest run",
            "RUST_LOG=debug cargo test -p a",
            "npm test",
            "npm run test:unit",
            "pnpm test -- --watch=false",
            "pnpm vitest run",
            "pnpm exec vitest",
            "yarn jest src",
            "bun test",
            "npx vitest run",
            "npx playwright test",
            "jest --ci",
            "vitest",
            "pytest -q tests/",
            "python -m pytest",
            "python3 -m unittest discover",
            "uv run pytest",
            "go test ./...",
            "dotnet test",
            "mvn -q test",
            "./gradlew test",
            "gradle :app:test",
            "bundle exec rspec",
            "rspec spec/a_spec.rb",
            "cd app && npm test",
            "git status; cargo test",
            "bash -lc \"cargo test -p x\"",
            "powershell -Command \"npm test\"",
            "C:\\tools\\node\\npm.cmd test",
            "Invoke-Pester",
            "make test",
        ] {
            assert!(runs_tests(command), "{command}");
        }
    }

    #[test]
    fn mentions_of_tests_are_not_test_runs() {
        for command in [
            "echo cargo test",
            "echo \"npm test\"",
            "cat test.txt",
            "ls tests/",
            "git commit -m \"add cargo test\"",
            "grep -r pytest .",
            "cargo build",
            "npm install",
            "npm run build",
            "npm run testing-tools",
            "node test.js",
            "mkdir test",
            "rg vitest",
            "python script.py test",
            "cargo run -- test",
            "go build ./...",
            "cargo fmt",
        ] {
            assert!(!runs_tests(command), "{command}");
        }
        assert!(!runs_tests(&"x".repeat(MAX_COMMAND_CHARS + 1)));
    }
}
