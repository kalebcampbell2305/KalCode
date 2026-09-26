//! Shared test helpers. Secret-shaped fixtures are assembled at run time from a prefix and a
//! deterministic pseudo-random body, so the repository never contains a literal credential
//! (and other secret scanners have nothing to flag).
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// Deterministic xorshift generator.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    pub fn string(&mut self, alphabet: &[u8], len: usize) -> String {
        (0..len)
            .map(|_| alphabet[(self.next() % alphabet.len() as u64) as usize] as char)
            .collect()
    }
}

pub const BASE62: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
pub const HEX: &[u8] = b"0123456789abcdef";
pub const UPPER_DIGITS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0234567";

/// A random body with guaranteed upper, lower and digit characters.
pub fn body(seed: u64, len: usize) -> String {
    let mut rng = Rng::new(seed);
    let mut s = rng.string(BASE62, len.saturating_sub(3));
    s.push_str("Q7x");
    s
}

pub fn hex(seed: u64, len: usize) -> String {
    Rng::new(seed).string(HEX, len)
}

/// `prefix + body`.
pub fn token(prefix: &str, seed: u64, len: usize) -> String {
    format!("{prefix}{}", body(seed, len))
}

/// A temp workspace with its canonical root.
pub struct Ws {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
}

impl Ws {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("ws");
        std::fs::create_dir_all(&root).expect("mkdir");
        Self { dir, root }
    }

    pub fn write(&self, relative: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&path, content).expect("write");
        path
    }

    /// A sibling folder outside the workspace.
    pub fn outside(&self) -> PathBuf {
        let path = self.dir.path().join("outside");
        std::fs::create_dir_all(&path).expect("mkdir");
        path
    }

    pub fn path(&self) -> &Path {
        &self.root
    }
}

/// Creates a directory junction (Windows) or a directory symlink (Unix). Returns false when the
/// platform refused (the caller skips that case).
pub fn link_dir(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = std::process::Command::new("cmd");
        command
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

/// Creates a file symlink. Windows needs developer mode or elevation; returns false if refused.
pub fn link_file(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

/// Secret samples in context: `(text, secret)`. Used by round-trip and property tests.
pub fn samples() -> Vec<(String, String)> {
    let mut rng = Rng::new(4242);
    let mut out = Vec::new();
    let s = token("sk-ant-api03-", 101, 40);
    out.push((format!("PROVIDER_KEY_X={s}\n"), s));
    let s = token("ghp_", 102, 36);
    out.push((format!("  \"token\": \"{s}\",\n"), s));
    let s = token("glpat-", 103, 24);
    out.push((
        format!("remote = https://ci:{s}@git.example.com/x.git\n"),
        s,
    ));
    let s = format!("AKIA{}", rng.string(UPPER_DIGITS, 16));
    out.push((format!("[default]\naws_access_key_id = {s}\n"), s));
    let s = body(104, 40);
    out.push((format!("aws_secret_access_key = {s}\n"), s));
    let s = format!(
        "eyJhbGciOiJIUzI1NiJ9.eyJ{}.{}",
        body(105, 30),
        body(106, 43)
    );
    out.push((format!("Authorization: Bearer {s}\r\n"), s));
    let s = body(107, 64);
    out.push((
        format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{s}\n{}\n-----END OPENSSH PRIVATE KEY-----\ntrailer\n",
            body(108, 64)
        ),
        s,
    ));
    let s = body(109, 32);
    out.push((format!("const secret = \"{s}\";\n"), s));
    let s = body(110, 24);
    out.push((format!("DATABASE_URL=postgres://app:{s}@localhost/db\n"), s));
    out
}
