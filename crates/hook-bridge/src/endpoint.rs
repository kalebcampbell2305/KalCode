//! The bridge's local endpoint: a per-run, randomly named Windows named pipe, or a Unix socket in
//! a freshly created owner-only directory. Never a TCP port.

use std::fmt;
use std::path::{Path, PathBuf};

use crate::key::{is_hex_of_len, random_id};

#[cfg(windows)]
const PIPE_PREFIX: &str = r"\\.\pipe\kalcode-hook-";
#[cfg(unix)]
const DIR_PREFIX: &str = "kalcode-hook-";
#[cfg(unix)]
const SOCKET_NAME: &str = "s";

/// Where the bridge listens. Only the shapes KalCode creates are accepted by [`Endpoint::parse`].
#[derive(Clone, PartialEq, Eq)]
pub struct Endpoint(String);

impl fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Endpoint({})", self.0)
    }
}

impl Endpoint {
    /// A new endpoint name. On Unix this also creates its private directory (mode 0700) under
    /// `runtime_dir` (normally `$XDG_RUNTIME_DIR`, else the temp folder); an existing directory
    /// is refused so a pre-planted one can't be reused.
    pub fn generate(runtime_dir: Option<&Path>) -> std::io::Result<Self> {
        let id = random_id()?;
        #[cfg(windows)]
        {
            let _ = runtime_dir;
            Ok(Self(format!("{PIPE_PREFIX}{id}")))
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let base = runtime_dir
                .map(Path::to_path_buf)
                .or_else(|| std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from))
                .filter(|p| p.is_absolute())
                .unwrap_or_else(std::env::temp_dir);
            // 16 hex characters keep the socket path well under the 104-byte limit on macOS.
            let dir = base.join(format!("{DIR_PREFIX}{}", &id[..16]));
            std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
            Ok(Self(dir.join(SOCKET_NAME).to_string_lossy().into_owned()))
        }
    }

    /// Accepts only endpoints of the shape [`Endpoint::generate`] produces.
    pub fn parse(text: &str) -> Option<Self> {
        #[cfg(windows)]
        {
            let id = text.strip_prefix(PIPE_PREFIX)?;
            is_hex_of_len(id, 32).then(|| Self(text.to_owned()))
        }
        #[cfg(unix)]
        {
            let path = Path::new(text);
            if !path.is_absolute() || path.file_name()? != SOCKET_NAME {
                return None;
            }
            let dir = path.parent()?.file_name()?.to_str()?;
            let id = dir.strip_prefix(DIR_PREFIX)?;
            is_hex_of_len(id, 16).then(|| Self(text.to_owned()))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn path(&self) -> PathBuf {
        PathBuf::from(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_endpoints_parse_and_others_do_not() {
        let dir = tempfile::tempdir().expect("dir");
        let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
        assert_eq!(Endpoint::parse(endpoint.as_str()), Some(endpoint.clone()));
        for bad in [
            "",
            "kalcode-hook-x",
            r"\\.\pipe\other",
            r"\\server\pipe\kalcode-hook-00000000000000000000000000000000",
            "/tmp/kalcode-hook-zz/s",
            "relative/kalcode-hook-0000000000000000/s",
        ] {
            assert_eq!(Endpoint::parse(bad), None, "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn socket_directory_is_private_and_must_be_new() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let endpoint = Endpoint::generate(Some(dir.path())).expect("endpoint");
        let parent = endpoint.path().parent().expect("parent").to_path_buf();
        let mode = std::fs::metadata(&parent)
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        // A directory that already exists is never reused.
        let err = std::fs::DirBuilder::new()
            .create(&parent)
            .expect_err("exists");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }
}
