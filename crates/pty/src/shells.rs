//! Shell detection. Read-only: looks for shells that are already installed and never installs,
//! downloads or changes anything.

use std::path::PathBuf;

/// A shell KalCode can start. `id` is what the WebView refers to; the path never leaves native.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellInfo {
    /// Stable identifier, e.g. `pwsh`, `powershell`, `cmd`, `git-bash`, `zsh`, `bash`.
    pub id: String,
    /// Display name, e.g. "PowerShell 7".
    pub name: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The platform default (first choice for new terminals).
    pub default: bool,
}

/// Shells present on this machine, default first.
pub fn detect_shells() -> Vec<ShellInfo> {
    let mut shells = platform_shells();
    if let Some(first) = shells.first_mut() {
        first.default = true;
    }
    shells
}

fn shell(id: &str, name: &str, program: PathBuf, args: &[&str]) -> ShellInfo {
    ShellInfo {
        id: id.to_owned(),
        name: name.to_owned(),
        program,
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        default: false,
    }
}

#[cfg(windows)]
fn platform_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    // Only a real executable: a `pwsh.cmd` or `.bat` earlier on PATH is not PowerShell.
    let pwsh = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("pwsh.exe"))
            .find(|p| p.is_file())
    });
    if let Some(pwsh) = pwsh {
        shells.push(shell("pwsh", "PowerShell 7", pwsh, &["-NoLogo"]));
    }
    let system_root =
        std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    let powershell = system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if powershell.is_file() {
        shells.push(shell(
            "powershell",
            "Windows PowerShell",
            powershell,
            &["-NoLogo"],
        ));
    }
    let cmd = std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    if let Some(cmd) =
        cmd.or_else(|| Some(system_root.join(r"System32\cmd.exe")).filter(|p| p.is_file()))
    {
        shells.push(shell("cmd", "Command Prompt", cmd, &[]));
    }
    let git_bash = ["ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|dir| PathBuf::from(dir).join(r"Git\bin\bash.exe"))
        .find(|p| p.is_file());
    if let Some(bash) = git_bash {
        shells.push(shell("git-bash", "Git Bash", bash, &["--login", "-i"]));
    }
    shells
}

#[cfg(not(windows))]
fn platform_shells() -> Vec<ShellInfo> {
    let known = [
        ("zsh", "Zsh"),
        ("bash", "Bash"),
        ("fish", "Fish"),
        ("sh", "sh"),
    ];
    let mut shells: Vec<ShellInfo> = known
        .iter()
        .filter_map(|(id, name)| {
            ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
                .iter()
                .map(|dir| std::path::Path::new(dir).join(id))
                .find(|p| p.is_file())
                .map(|path| shell(id, name, path, &["-l"]))
        })
        .collect();
    // The user's login shell goes first when it is one we found.
    if let Some(login) = std::env::var_os("SHELL").map(PathBuf::from)
        && let Some(index) = shells
            .iter()
            .position(|s| s.program == login || login.ends_with(&s.id))
    {
        let preferred = shells.remove(index);
        shells.insert(0, preferred);
    }
    shells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_at_least_one_shell_and_marks_one_default() {
        let shells = detect_shells();
        assert!(!shells.is_empty(), "no shells detected");
        assert_eq!(shells.iter().filter(|s| s.default).count(), 1);
        assert!(shells[0].default);
        for shell in &shells {
            assert!(shell.program.is_file(), "{shell:?}");
        }
        let mut ids: Vec<&str> = shells.iter().map(|s| s.id.as_str()).collect();
        ids.dedup();
        assert_eq!(ids.len(), shells.len(), "ids are unique");
    }
}
