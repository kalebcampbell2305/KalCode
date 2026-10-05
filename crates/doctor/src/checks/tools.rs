//! Developer tools: `git`, `node`, `pnpm`, `npm`, `python`, `cargo`, `rustc`, `bun`, `deno`,
//! `docker`. Each is resolved to an absolute executable on the absolute `PATH` entries (never the
//! current folder) and asked for `--version` through the Z2 launch rules
//! (`kalcode_providers::process::run_probe`: argv only, never a shell string; `.cmd` shims
//! resolved to their real target; `env_clear` + a sanitized allow-list;
//! `NoDefaultCurrentDirectoryInExePath=1`; a timeout that kills the whole process tree). The
//! probe runs in KalCode's data folder, so a project's `package.json` or toolchain file can't
//! redirect it, and package-manager shims are told not to download anything.
//!
//! `git` is not probed again when the Git core (Z6a) has already located it.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use kalcode_providers::env::{EnvPolicy, absolute_path_entries, sanitized_env};
use kalcode_providers::process::{ProcessError, ProcessSpec, run_probe};
use kalcode_providers::version::Version;

use super::{CheckDef, CheckOutput, FindingExt, count, def, finding, show_command};
use crate::context::{HostFacts, RunContext, display};
use crate::types::{DoctorArea, DoctorFinding, FindingSeverity};

/// A developer tool the Doctor knows.
#[derive(Debug, Clone, Copy)]
pub struct Tool {
    /// Check and finding id segment (`tools.<id>`), and the KalVoice tool name.
    pub id: &'static str,
    /// Executable name without extension.
    pub exe: &'static str,
    pub name: &'static str,
    /// What it's for, in one line.
    pub purpose: &'static str,
    pub missing_severity: FindingSeverity,
    pub install_windows: &'static str,
    pub install_macos: &'static str,
    pub install_linux: &'static str,
}

pub const TOOLS: &[Tool] = &[
    Tool {
        id: "git",
        exe: "git",
        name: "Git",
        purpose: "KalCode's Git status, history and checkpoints use it.",
        missing_severity: FindingSeverity::Warning,
        install_windows: "winget install --id Git.Git -e",
        install_macos: "brew install git",
        install_linux: "sudo apt install git",
    },
    Tool {
        id: "node",
        exe: "node",
        name: "Node.js",
        purpose: "JavaScript projects and many provider CLIs run on it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id OpenJS.NodeJS.LTS -e",
        install_macos: "brew install node",
        install_linux: "sudo apt install nodejs",
    },
    Tool {
        id: "pnpm",
        exe: "pnpm",
        name: "pnpm",
        purpose: "Projects with a pnpm-lock.yaml install their packages with it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id pnpm.pnpm -e",
        install_macos: "brew install pnpm",
        install_linux: "npm install --global pnpm",
    },
    Tool {
        id: "npm",
        exe: "npm",
        name: "npm",
        purpose: "Node.js's package manager; it comes with Node.js.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id OpenJS.NodeJS.LTS -e",
        install_macos: "brew install node",
        install_linux: "sudo apt install npm",
    },
    Tool {
        id: "python",
        exe: "python",
        name: "Python",
        purpose: "Python projects and many build scripts use it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id Python.Python.3.13 -e",
        install_macos: "brew install python",
        install_linux: "sudo apt install python3",
    },
    Tool {
        id: "cargo",
        exe: "cargo",
        name: "Cargo",
        purpose: "Rust projects build with it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id Rustlang.Rustup -e",
        install_macos: "brew install rustup",
        install_linux: "sudo apt install rustup",
    },
    Tool {
        id: "rustc",
        exe: "rustc",
        name: "The Rust compiler",
        purpose: "Rust projects need it (rustup installs it with Cargo).",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id Rustlang.Rustup -e",
        install_macos: "brew install rustup",
        install_linux: "sudo apt install rustup",
    },
    Tool {
        id: "bun",
        exe: "bun",
        name: "Bun",
        purpose: "Projects with a bun.lock run and install with it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id Oven-sh.Bun -e",
        install_macos: "brew install oven-sh/bun/bun",
        install_linux: "npm install --global bun",
    },
    Tool {
        id: "deno",
        exe: "deno",
        name: "Deno",
        purpose: "Deno projects run with it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id DenoLand.Deno -e",
        install_macos: "brew install deno",
        install_linux: "npm install --global deno",
    },
    Tool {
        id: "docker",
        exe: "docker",
        name: "Docker",
        purpose: "Projects with containers build and run them with it.",
        missing_severity: FindingSeverity::Info,
        install_windows: "winget install --id Docker.DockerDesktop -e",
        install_macos: "brew install --cask docker",
        install_linux: "sudo apt install docker.io",
    },
];

/// The tool with this id (`node`) or name (`Node.js`, case-insensitive).
pub fn find(name: &str) -> Option<&'static Tool> {
    TOOLS
        .iter()
        .find(|t| t.id.eq_ignore_ascii_case(name) || t.name.eq_ignore_ascii_case(name))
}

/// Tool-specific variables a `--version` probe may need, on top of the base allow-list (no
/// secrets: install locations only).
const TOOL_ENV: EnvPolicy = EnvPolicy {
    provider_prefixes: &[],
    provider_names: &[
        "RUSTUP_HOME",
        "CARGO_HOME",
        "RUSTUP_TOOLCHAIN",
        "NVM_HOME",
        "NVM_SYMLINK",
        "NVM_DIR",
        "VOLTA_HOME",
        "PNPM_HOME",
        "BUN_INSTALL",
        "DENO_DIR",
        "DENO_INSTALL",
        "PYENV",
        "PYENV_ROOT",
        "PYENV_HOME",
        "DOCKER_CONFIG",
    ],
    inherit_all: false,
};

/// Set on every probe: never download a package manager or a toolchain to answer `--version`.
const NO_DOWNLOADS: &[(&str, &str)] = &[
    ("COREPACK_ENABLE_NETWORK", "0"),
    ("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0"),
    ("RUSTUP_AUTO_INSTALL", "0"),
    ("NO_UPDATE_NOTIFIER", "1"),
    ("DENO_NO_UPDATE_CHECK", "1"),
];

/// Largest `--version` output read.
const MAX_OUTPUT: usize = 16 * 1024;

pub fn checks() -> Vec<CheckDef> {
    TOOLS
        .iter()
        .map(|tool| {
            def(
                format!("tools.{}", tool.id),
                DoctorArea::DevTools,
                tool.name,
                move |ctx| check(ctx, tool),
            )
        })
        .collect()
}

/// File extensions a bare name may have, in order (Windows: PATHEXT restricted to kinds the OS
/// starts directly; elsewhere the bare name).
pub fn extensions(host: &HostFacts) -> Vec<String> {
    if !host.windows {
        return vec![String::new()];
    }
    const STARTABLE: &[&str] = &[".exe", ".com", ".cmd", ".bat"];
    let pathext = host
        .var("PATHEXT")
        .and_then(OsStr::to_str)
        .unwrap_or(".COM;.EXE;.BAT;.CMD");
    let mut out: Vec<String> = pathext
        .split(';')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| STARTABLE.contains(&e.as_str()))
        .collect();
    if out.is_empty() {
        out = STARTABLE.iter().map(|s| (*s).to_owned()).collect();
    }
    out
}

/// Every copy of `exe` on the absolute PATH entries, in PATH order (first one wins in a shell).
pub fn all_on_path(host: &HostFacts, exe: &str) -> Vec<PathBuf> {
    let dirs = absolute_path_entries(host.var("PATH").unwrap_or_default());
    let exts = extensions(host);
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in &dirs {
        for ext in &exts {
            let candidate = dir.join(format!("{exe}{ext}"));
            if candidate.is_file() && !out.iter().any(|p| same_path(p, &candidate, host.windows)) {
                out.push(candidate);
            }
        }
    }
    out
}

fn same_path(a: &Path, b: &Path, windows: bool) -> bool {
    if windows {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// Folders a tool is commonly installed in, to tell "not installed" from "not on PATH".
fn known_dirs(host: &HostFacts, tool: &Tool) -> Vec<PathBuf> {
    let var = |name: &str| host.var(name).map(PathBuf::from);
    let home = if host.windows {
        var("USERPROFILE")
    } else {
        var("HOME")
    };
    let mut out = Vec::new();
    if host.windows {
        let program_files = var("ProgramFiles");
        let local = var("LOCALAPPDATA");
        let roaming = var("APPDATA");
        match tool.id {
            "git" => out.extend(program_files.map(|p| p.join("Git").join("cmd"))),
            "node" => out.extend(program_files.map(|p| p.join("nodejs"))),
            "npm" => {
                out.extend(program_files.map(|p| p.join("nodejs")));
                out.extend(roaming.map(|p| p.join("npm")));
            }
            "pnpm" => {
                out.extend(local.map(|p| p.join("pnpm")));
                out.extend(roaming.map(|p| p.join("npm")));
            }
            "python" => {
                if let Some(programs) = local.map(|p| p.join("Programs").join("Python")) {
                    out.extend(subdirs(&programs));
                }
            }
            "cargo" | "rustc" => out.extend(home.map(|h| h.join(".cargo").join("bin"))),
            "bun" => out.extend(home.map(|h| h.join(".bun").join("bin"))),
            "deno" => out.extend(home.map(|h| h.join(".deno").join("bin"))),
            "docker" => out.extend(program_files.map(|p| {
                p.join("Docker")
                    .join("Docker")
                    .join("resources")
                    .join("bin")
            })),
            _ => {}
        }
    } else {
        out.push(PathBuf::from("/usr/local/bin"));
        out.push(PathBuf::from("/opt/homebrew/bin"));
        if let Some(home) = home {
            match tool.id {
                "cargo" | "rustc" => out.push(home.join(".cargo").join("bin")),
                "bun" => out.push(home.join(".bun").join("bin")),
                "deno" => out.push(home.join(".deno").join("bin")),
                _ => out.push(home.join(".local").join("bin")),
            }
        }
    }
    out
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .take(20)
                .collect()
        })
        .unwrap_or_default()
}

fn install_command(host: &HostFacts, tool: &Tool) -> String {
    if host.windows {
        tool.install_windows.to_owned()
    } else if cfg!(target_os = "macos") {
        tool.install_macos.to_owned()
    } else {
        tool.install_linux.to_owned()
    }
}

/// The command that appends `dir` to the user's PATH (shown, never run).
pub fn add_to_path_command(host: &HostFacts, dir: &Path) -> (String, &'static str) {
    let _ = dir;
    if host.windows {
        (
            "Open Settings > System > About > Advanced system settings > Environment Variables, then add the tool's install folder to your user PATH.".into(),
            "Windows Settings",
        )
    } else {
        (
            "Add the tool's install folder to PATH in your shell profile, then restart KalCode."
                .into(),
            "Your shell profile",
        )
    }
}

fn check(ctx: &RunContext, tool: &'static Tool) -> CheckOutput {
    // Git: the Git core already located and version-checked it (Z6a); don't probe again.
    if tool.id == "git"
        && let Some(git) = ctx.git.as_ref().and_then(|g| g.git().ok())
    {
        let version = git.version();
        return with_shadowing(
            ctx,
            tool,
            CheckOutput::passed(format!(
                "{}.{}.{} · {}",
                version.major,
                version.minor,
                version.patch,
                display(git.executable())
            )),
        );
    }
    let host = &ctx.host;
    let dirs = absolute_path_entries(host.var("PATH").unwrap_or_default());
    let exts = extensions(host);
    let Some(exe) = kalcode_providers::detect::resolve_executable(tool.exe, &dirs, &exts) else {
        return missing(ctx, tool);
    };
    let mut env = sanitized_env(host.vars.iter().cloned(), &TOOL_ENV);
    for (name, value) in NO_DOWNLOADS {
        env.insert(OsString::from(name), OsString::from(value));
    }
    let spec = ProcessSpec {
        program: exe.clone(),
        args: vec![OsString::from("--version")],
        cwd: Some(ctx.core.paths().data_dir.clone()),
        env,
    };
    let timeout = ctx
        .budget
        .remaining(Duration::from_millis(250))
        .min(crate::CHECK_TIMEOUT);
    let shown = display(&exe);
    let store_alias = is_store_alias(&exe);
    match run_probe(&spec, timeout, true, MAX_OUTPUT) {
        Err(ProcessError::TimedOut(_)) => CheckOutput::could_not_check(format!(
            "`{} --version` didn't answer within {} seconds ({shown}).",
            tool.exe,
            timeout.as_secs().max(1)
        )),
        Err(ProcessError::Spawn(_)) => CheckOutput::with(
            "Couldn't start",
            vec![broken(
                tool,
                &shown,
                "The operating system refused to start it.",
            )],
        ),
        Err(_) => CheckOutput::could_not_check("KalCode couldn't run the version check."),
        Ok(out) => {
            let text = format!("{}\n{}", out.stdout, out.stderr);
            let version = Version::find_in(&text);
            if store_alias && (!out.status.success() || version.is_none()) {
                return CheckOutput::with(
                    "Store alias only",
                    vec![
                        finding(
                            format!("tools.{}.store_alias", tool.id),
                            FindingSeverity::Warning,
                            format!("\"{}\" opens the Microsoft Store instead of {}", tool.exe, tool.name),
                            format!(
                                "Windows puts a placeholder named {} on PATH that only points to the Microsoft Store. Install {} (or turn off the App execution alias in Settings > Apps > Advanced app settings).",
                                tool.exe, tool.name
                            ),
                        )
                        .detail("Found", &shown)
                        .fix(show_command(
                            "show.install",
                            "Show the install command",
                            "Shows a command that installs it. KalCode never installs software itself.",
                            install_command(host, tool),
                            "Your terminal",
                        )),
                    ],
                );
            }
            if !out.status.success() {
                return CheckOutput::with(
                    "Didn't run",
                    vec![broken(
                        tool,
                        &shown,
                        &format!("`{} --version` ended with an error.", tool.exe),
                    )],
                );
            }
            let summary = match version {
                Some(v) => format!("{}.{}.{} · {shown}", v.major, v.minor, v.patch),
                None => format!("Installed · {shown}"),
            };
            with_shadowing(ctx, tool, CheckOutput::passed(summary))
        }
    }
}

fn is_store_alias(path: &Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .contains("\\microsoft\\windowsapps\\")
}

fn broken(tool: &Tool, shown: &str, what: &str) -> DoctorFinding {
    finding(
        format!("tools.{}.broken", tool.id),
        FindingSeverity::Warning,
        format!("{} is on PATH but doesn't work", tool.name),
        format!("{what} Reinstalling it usually helps. {}", tool.purpose),
    )
    .detail("Found", shown)
}

/// More than one copy on PATH: the first one runs, which may not be the one you expect.
fn with_shadowing(ctx: &RunContext, tool: &Tool, mut out: CheckOutput) -> CheckOutput {
    let copies = all_on_path(&ctx.host, tool.exe);
    // A `.cmd` shim next to its own `.exe` (same folder) is one installation.
    let mut folders: Vec<PathBuf> = Vec::new();
    for copy in &copies {
        if let Some(parent) = copy.parent()
            && !folders
                .iter()
                .any(|f| same_path(f, parent, ctx.host.windows))
        {
            folders.push(parent.to_path_buf());
        }
    }
    if folders.len() > 1 {
        out.findings.push(
            finding(
                format!("tools.{}.shadowed", tool.id),
                FindingSeverity::Info,
                format!("More than one {} is on PATH", tool.name),
                format!(
                    "{} folders on PATH have {}. Terminals run the first one; the others are hidden behind it. That's fine if it's on purpose (a version manager, for example).",
                    folders.len(),
                    tool.exe
                ),
            )
            .detail("Runs", display(&copies[0]))
            .subjects(copies.iter().map(|c| display(c))),
        );
    }
    out
}

fn missing(ctx: &RunContext, tool: &Tool) -> CheckOutput {
    let host = &ctx.host;
    let exts = extensions(host);
    let outside = known_dirs(host, tool).into_iter().find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{}{ext}", tool.exe)))
            .find(|p| p.is_file())
    });
    if let Some(found) = outside {
        let dir = found.parent().map(Path::to_path_buf).unwrap_or_default();
        let (command, shell) = add_to_path_command(host, &dir);
        return CheckOutput::with(
            "Installed, not on PATH",
            vec![
                finding(
                    format!("tools.{}.not_on_path", tool.id),
                    FindingSeverity::Warning,
                    format!("{} is installed but not on PATH", tool.name),
                    format!(
                        "{} is in {}, but that folder isn't on PATH, so terminals and provider CLIs can't find \"{}\". Add the folder to PATH, then restart KalCode so it sees the change. {}",
                        tool.name,
                        display(&dir),
                        tool.exe,
                        tool.purpose
                    ),
                )
                .detail("Found", display(&found))
                .fix(show_command(
                    "show.add_to_path",
                    "Show how to add it to PATH",
                    "Shows a command that adds this folder to your PATH. KalCode doesn't change PATH itself.",
                    command,
                    shell,
                )),
            ],
        );
    }
    let path_entries = absolute_path_entries(host.var("PATH").unwrap_or_default()).len();
    CheckOutput::with(
        "Not found",
        vec![
            finding(
                format!("tools.{}.missing", tool.id),
                tool.missing_severity,
                format!("{} wasn't found", tool.name),
                format!(
                    "No folder on PATH has \"{}\". {} If you installed it after KalCode started, restart KalCode so it sees the new PATH.",
                    tool.exe, tool.purpose
                ),
            )
            .detail("Searched", format!("{} on PATH", count(path_entries, "folder", "folders")))
            .fix(show_command(
                "show.install",
                "Show the install command",
                "Shows a command that installs it. KalCode never installs software itself.",
                install_command(host, tool),
                "Your terminal",
            )),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(vars: &[(&str, &str)], windows: bool) -> HostFacts {
        HostFacts {
            vars: vars
                .iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v)))
                .collect(),
            windows,
            webview_version: Err("n/a".into()),
            migrations: &[],
        }
    }

    #[test]
    fn tools_are_found_by_id_or_name() {
        assert_eq!(find("node").map(|t| t.exe), Some("node"));
        assert_eq!(find("Node.js").map(|t| t.id), Some("node"));
        assert!(find("rm").is_none());
        assert_eq!(TOOLS.len(), 10);
    }

    #[test]
    fn extensions_follow_pathext_but_only_startable_kinds() {
        let h = host(&[("PATHEXT", ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1")], true);
        assert_eq!(extensions(&h), vec![".com", ".exe", ".bat", ".cmd"]);
        assert_eq!(extensions(&host(&[], false)), vec![String::new()]);
    }

    #[test]
    fn relative_path_entries_are_never_searched() {
        let dir = tempfile::tempdir().expect("dir");
        let name = if cfg!(windows) { "tool.exe" } else { "tool" };
        std::fs::write(dir.path().join(name), b"x").expect("write");
        let cwd_like = format!(".{}", if cfg!(windows) { ';' } else { ':' });
        let path = format!("{cwd_like}{}", dir.path().display());
        let h = host(&[("PATH", &path), ("PATHEXT", ".EXE")], cfg!(windows));
        let found = all_on_path(&h, "tool");
        assert_eq!(found.len(), 1);
        assert!(found[0].is_absolute());
    }

    #[test]
    fn path_guidance_never_exposes_the_folder() {
        let h = host(&[], true);
        let (cmd, shell) = add_to_path_command(&h, Path::new("C:\\It's here"));
        assert!(!cmd.contains("It's here"), "{cmd}");
        assert_eq!(shell, "Windows Settings");
    }
}
