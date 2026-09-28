//! Certified compatibility lines for managed provider CLIs.
//!
//! A managed profile's isolation depends on how a provider CLI loads configuration, credentials
//! and flags, so KalCode accepts only releases it has certified. Certification is per
//! *compatibility line*: `MAJOR.MINOR` (for 0.x releases that is `0.MINOR`). A version is
//! supported when it is a release build (no pre-release or build suffix) in a certified line at or
//! above that line's certified floor. Newer patch releases in a certified line are accepted so a
//! provider patch cannot break signed-in users; a new line (or major) fails closed until it is
//! certified on the real binary and added here.

use crate::version::Version;

/// The certified lines of one managed provider CLI.
#[derive(Debug)]
pub struct VersionWindow {
    /// The CLI's user-facing name (`Codex CLI`).
    pub cli_name: &'static str,
    /// The managed profile family named in refusals (`Codex`).
    pub profile_name: &'static str,
    /// The official npm package, used in the install command a refusal names.
    pub npm_package: &'static str,
    /// One certified floor per line, in ascending order. The last is the newest certified
    /// release, which a refusal tells the person to install.
    pub floors: &'static [Version],
}

impl VersionWindow {
    /// Whether `version` is a release build in a certified line at or above that line's floor.
    pub fn supports(&self, version: &Version) -> bool {
        version.suffix.is_empty()
            && self.floors.iter().any(|floor| {
                floor.major == version.major
                    && floor.minor == version.minor
                    && version.patch >= floor.patch
            })
    }

    /// The newest certified release.
    pub fn newest(&self) -> Option<&Version> {
        self.floors.iter().max()
    }

    /// The supported lines, e.g. `0.155.x (0.155.1 or later), 0.156.x or 0.157.x`.
    pub fn supported_range(&self) -> String {
        let lines: Vec<String> = self
            .floors
            .iter()
            .map(|floor| {
                if floor.patch == 0 {
                    format!("{}.{}.x", floor.major, floor.minor)
                } else {
                    format!("{}.{}.x ({floor} or later)", floor.major, floor.minor)
                }
            })
            .collect();
        match lines.split_last() {
            None => String::new(),
            Some((last, [])) => last.clone(),
            Some((last, rest)) => format!("{} or {last}", rest.join(", ")),
        }
    }

    /// The command that installs the newest certified release.
    pub fn install_command(&self) -> Option<String> {
        self.newest()
            .map(|newest| format!("npm install -g {}@{newest}", self.npm_package))
    }

    /// A refusal naming the found version, the supported range and the install command.
    pub fn refusal(&self, found: &Version) -> String {
        let mut message = format!(
            "{cli} {found} isn't supported for managed {profile} profiles. KalCode supports {cli} \
             {range}; pre-release builds aren't supported.",
            cli = self.cli_name,
            profile = self.profile_name,
            range = self.supported_range(),
        );
        if let Some(command) = self.install_command() {
            message.push_str(&format!(
                " Install the newest supported version with `{command}`, then try again."
            ));
        }
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: VersionWindow = VersionWindow {
        cli_name: "Example CLI",
        profile_name: "Example",
        npm_package: "@example/cli",
        floors: &[
            Version::new(0, 9, 2),
            Version::new(0, 10, 0),
            Version::new(1, 2, 0),
        ],
    };

    fn version(text: &str) -> Version {
        Version::parse(text).expect("version")
    }

    #[test]
    fn a_line_is_major_minor_and_patches_at_or_above_the_floor_are_supported() {
        for supported in ["0.9.2", "0.9.40", "0.10.0", "0.10.3", "1.2.0", "1.2.9"] {
            assert!(WINDOW.supports(&version(supported)), "{supported}");
        }
        for refused in [
            "0.9.1",
            "0.8.9",
            "0.11.0",
            "1.0.0",
            "1.1.9",
            "1.3.0",
            "2.2.0",
            "0.10.1-rc.1",
            "0.10.0+build",
        ] {
            assert!(!WINDOW.supports(&version(refused)), "{refused}");
        }
    }

    #[test]
    fn refusal_names_version_range_and_newest_install_command() {
        assert_eq!(
            WINDOW.refusal(&version("0.11.0")),
            "Example CLI 0.11.0 isn't supported for managed Example profiles. KalCode supports \
             Example CLI 0.9.x (0.9.2 or later), 0.10.x or 1.2.x; pre-release builds aren't \
             supported. Install the newest supported version with \
             `npm install -g @example/cli@1.2.0`, then try again."
        );
    }
}
