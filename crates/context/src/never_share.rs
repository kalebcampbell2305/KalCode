//! "Never share" rules: KalCode's built-in sensitive names plus user patterns.
//!
//! Every rule is matched against a path folded by [`crate::paths::normalize_for_match`]
//! (lowercase, `/` separators, look-alike characters mapped to ASCII). Built-in rules cannot be
//! disabled. Rules for key material and credential stores are *secret* (never overridable);
//! heuristic rules for data exports and Git internals are *confidential* (per-item
//! confirmation).

use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};

use crate::error::{ContextError, Result};
use crate::model::Sensitivity;
use crate::paths::normalize_for_match;

/// A built-in rule that matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinHit {
    pub rule: &'static str,
    pub sensitivity: Sensitivity,
    pub description: &'static str,
}

const fn hit(
    rule: &'static str,
    sensitivity: Sensitivity,
    description: &'static str,
) -> BuiltinHit {
    BuiltinHit {
        rule,
        sensitivity,
        description,
    }
}

/// Directories whose whole content is credential material.
const SECRET_DIRS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".password-store",
    ".gcloud",
    ".vault",
    "private-keys-v1.d",
];

/// Exact file names that hold credentials or tokens.
const SECRET_FILES: &[&str] = &[
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".pgpass",
    ".htpasswd",
    ".dockercfg",
    ".envrc",
    ".boto",
    ".s3cfg",
    ".vault-token",
    ".terraformrc",
    "terraform.rc",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "credentials",
    "credentials.json",
    "credentials.toml",
    "credentials.yml",
    "credentials.yaml",
    "credentials.xml",
    "secrets.json",
    "secrets.yml",
    "secrets.yaml",
    "secrets.toml",
    "service-account.json",
    "application_default_credentials.json",
    "keychain-db",
    "known_hosts",
    "authorized_keys",
    // SEC-LATENT additions: CLI and cloud credential stores.
    ".yarnrc",
    ".flaskenv",
    ".my.cnf",
    ".mylogin.cnf",
    "pgpass.conf",
    "auth.json",
    ".dockerconfigjson",
    "credentials.tfrc.json",
    "credentials.csv",
    "credentials.db",
    "access_tokens.db",
    "legacy_credentials",
    "accesstokens.json",
    "azureprofile.json",
    "msal_token_cache.json",
    "msal_token_cache.bin",
    "service_principal_entries.json",
    ".databrickscfg",
    "rclone.conf",
    "kubeconfig",
    "secring.gpg",
    "secring.kbx",
    "shadow",
    // Browser and password-manager stores and exports.
    "login data",
    "login data for account",
    "web data",
    "cookies",
    "cookies.sqlite",
    "logins.json",
    "signons.sqlite",
    "key3.db",
    "key4.db",
    "passwords.csv",
];

/// File extensions for key material and credential containers.
const SECRET_EXTENSIONS: &[&str] = &[
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".p8",
    ".jks",
    ".keystore",
    ".ppk",
    ".kdbx",
    ".tfvars",
    ".ovpn",
    ".keytab",
    ".kdb",
    ".keychain",
    ".keychain-db",
    ".agilekeychain",
    ".opvault",
    ".1pux",
    ".1pif",
    ".kubeconfig",
];

/// `.env` variants that are conventionally committed templates without values. Their content
/// is still scanned for secrets like any other file.
const ENV_TEMPLATES: &[&str] = &[
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".env.defaults",
    ".env.schema",
];

/// Words that mark personal or customer data in an export file name.
const EXPORT_SUBJECTS: &[&str] = &[
    "customer",
    "client",
    "user",
    "member",
    "subscriber",
    "contact",
    "lead",
    "patient",
    "employee",
    "order",
    "account",
    "payment",
    "invoice",
    "people",
];
const EXPORT_MARKERS: &[&str] = &["export", "dump", "backup", "extract", "pii", "gdpr"];
const DATA_EXTENSIONS: &[&str] = &[
    ".csv", ".tsv", ".xlsx", ".xls", ".json", ".jsonl", ".ndjson", ".sql", ".parquet", ".xml",
];

/// Backup, copy and editor decorations stripped before matching, so `.env~`, `.env - Copy`,
/// `#.env#`, `id_rsa.bak` and `server.key.orig` match like the original name.
const BACKUP_SUFFIXES: &[&str] = &[
    "~",
    " - copy",
    " copy",
    "-copy",
    "_copy",
    ".copy",
    ".bak",
    ".backup",
    ".old",
    ".orig",
    ".save",
    ".saved",
    ".swp",
    ".swo",
    ".tmp",
    ".prev",
    ".previous",
    ".1",
    ".2",
];

/// The name and every undecorated form of it (`.env - Copy (2).bak` → `.env - Copy (2)` →
/// `.env - Copy` → `.env`).
fn name_variants(name: &str) -> Vec<String> {
    let mut out = vec![name.to_owned()];
    let mut current = name.to_owned();
    for _ in 0..8 {
        let mut next = current.trim().to_owned();
        if let Some(rest) = next.strip_prefix("copy of ") {
            next = rest.to_owned();
        }
        if next.len() > 2 && next.starts_with('#') && next.ends_with('#') {
            next = next[1..next.len() - 1].to_owned();
        }
        if let Some(rest) = next.strip_prefix(".#") {
            next = rest.to_owned();
        }
        // ` (2)` numbered copies.
        if next.ends_with(')')
            && let Some(open) = next.rfind(" (")
            && next[open + 2..next.len() - 1]
                .chars()
                .all(|c| c.is_ascii_digit())
        {
            next.truncate(open);
        }
        if let Some(suffix) = BACKUP_SUFFIXES
            .iter()
            .find(|suffix| next.len() > suffix.len() && next.ends_with(*suffix))
        {
            next.truncate(next.len() - suffix.len());
        }
        if next == current || next.is_empty() {
            break;
        }
        out.push(next.clone());
        current = next;
    }
    out
}

/// Matches `normalized` (already folded) against the built-in catalogue. The strongest match
/// wins: secret rules are checked first. Backup and copy decorations are ignored.
pub fn builtin_match(normalized: &str) -> Option<BuiltinHit> {
    let components: Vec<&str> = normalized.split('/').filter(|c| !c.is_empty()).collect();
    let name = *components.last()?;
    let parents = &components[..components.len() - 1];
    let variants = name_variants(name);
    variants
        .iter()
        .filter_map(|variant| builtin_match_name(parents, variant))
        .max_by_key(|hit| hit.sensitivity)
}

fn builtin_match_name(parents: &[&str], name: &str) -> Option<BuiltinHit> {
    if parents.iter().any(|dir| SECRET_DIRS.contains(dir)) || SECRET_DIRS.contains(&name) {
        return Some(hit(
            "credential_directory",
            Sensitivity::Secret,
            "a credential directory (.ssh, .aws, .gnupg, …)",
        ));
    }
    if parents.windows(2).any(|w| w == [".config", "gcloud"])
        || (parents.last() == Some(&"gh") && name == "hosts.yml")
        || (parents.last() == Some(&".docker") && name == "config.json")
        || (parents.last() == Some(&".config") && name == "hub")
        || (parents.last() == Some(&".m2")
            && name.starts_with("settings")
            && name.ends_with(".xml"))
        || (parents.last() == Some(&".gradle") && name == "gradle.properties")
        || (parents.windows(2).any(|w| w == ["sops", "age"]) && name == "keys.txt")
        || is_kube_config(name)
        || is_credential_export(name)
    {
        return Some(hit(
            "cloud_credentials",
            Sensitivity::Secret,
            "a cloud or CLI credential file",
        ));
    }
    if is_env_file(name) {
        return Some(hit(
            "env_file",
            Sensitivity::Secret,
            "an environment file (.env*) that usually holds secrets",
        ));
    }
    if is_private_key_name(name) {
        return Some(hit(
            "private_key_file",
            Sensitivity::Secret,
            "a private key file (id_*)",
        ));
    }
    if SECRET_FILES.contains(&name) {
        return Some(hit(
            "credential_file",
            Sensitivity::Secret,
            "a credential or token file",
        ));
    }
    if SECRET_EXTENSIONS.iter().any(|ext| name.ends_with(ext)) {
        return Some(hit(
            "key_material",
            Sensitivity::Secret,
            "key material or a credential container (*.pem, *.key, *.p12, …)",
        ));
    }
    if name.ends_with(".json")
        && (name.contains("service-account")
            || name.contains("service_account")
            || name.starts_with("client_secret")
            || name.ends_with("-credentials.json")
            || name.ends_with("_credentials.json"))
    {
        return Some(hit(
            "cloud_credentials",
            Sensitivity::Secret,
            "a cloud service-account or client-secret file",
        ));
    }
    if parents.contains(&".git") || name == ".git" {
        return Some(hit(
            "git_internal",
            Sensitivity::Confidential,
            "Git's internal directory (it can hold remote credentials)",
        ));
    }
    if is_data_export(name) {
        return Some(hit(
            "data_export",
            Sensitivity::Confidential,
            "a data export or dump that may hold customer data",
        ));
    }
    None
}

fn is_env_file(name: &str) -> bool {
    if ENV_TEMPLATES.contains(&name) {
        return false;
    }
    const DEPLOY: &[&str] = &[
        "production",
        "prod",
        "local",
        "development",
        "dev",
        "staging",
        "stage",
        "test",
        "secret",
        "secrets",
    ];
    name == ".env"
        || name.starts_with(".env.")
        || name.starts_with(".env-")
        || name.starts_with(".env_")
        || (name.ends_with(".env") && name.len() > 4)
        || name
            .strip_prefix("env.")
            .is_some_and(|rest| DEPLOY.contains(&rest))
}

/// `kubeconfig`, `kubeconfig.yaml`, `kubeconfig-prod`, `admin.kubeconfig`, `prod-kubeconfig`.
fn is_kube_config(name: &str) -> bool {
    name.starts_with("kubeconfig")
        || name.ends_with(".kubeconfig")
        || name.ends_with("-kubeconfig")
        || name.ends_with("_kubeconfig")
}

/// Console and password-manager exports and service-account keys identified by name.
fn is_credential_export(name: &str) -> bool {
    (name.ends_with(".json") && name.contains("firebase-adminsdk"))
        || name.ends_with("accesskeys.csv")
        || name.ends_with("_credentials.csv")
        || name.ends_with("-credentials.csv")
        || (name.ends_with(".csv") && name.contains("password"))
        || ((name.ends_with(".csv") || name.ends_with(".json"))
            && (name.starts_with("bitwarden_export")
                || name.starts_with("lastpass")
                || name.starts_with("dashlane")
                || name.starts_with("keepass")))
        || ((name.ends_with(".asc") || name.ends_with(".gpg") || name.ends_with(".pgp"))
            && (name.contains("private") || name.contains("secret")))
}

/// `id_rsa`, `id_ed25519`, `id_ecdsa_sk`, … and any other `id_*` name without an extension.
/// Public halves (`*.pub`) are not keys. Names with an extension (`id_generator.rs`) are not
/// matched; that trade-off keeps the rule from blocking ordinary source files.
fn is_private_key_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("id_") else {
        return false;
    };
    !rest.is_empty() && !rest.contains('.')
}

fn is_data_export(name: &str) -> bool {
    if name.ends_with(".sql.gz") || name.ends_with(".dump") || name.ends_with(".sql.bak") {
        return true;
    }
    let Some(ext) = DATA_EXTENSIONS.iter().find(|ext| name.ends_with(*ext)) else {
        return false;
    };
    let stem = &name[..name.len() - ext.len()];
    let subject = EXPORT_SUBJECTS.iter().any(|s| stem.contains(s));
    let marker = EXPORT_MARKERS.iter().any(|m| stem.contains(m));
    (subject && marker) || (*ext == ".sql" && marker)
}

/// Where a user pattern applies.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PatternScope {
    /// Every workspace (`context_never_share.scope_id = ''`).
    Global,
    Workspace {
        workspace_id: String,
    },
}

impl PatternScope {
    pub fn scope_id(&self) -> &str {
        match self {
            Self::Global => "",
            Self::Workspace { workspace_id } => workspace_id,
        }
    }
}

/// A user-defined "never share" pattern (gitignore-like glob). A pattern without `/` matches
/// the name at any depth; a pattern ending in `/` matches a directory and everything under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeverSharePattern {
    pub scope: PatternScope,
    pub pattern: String,
    /// `Confidential` or `Secret`; anything else is raised to `Confidential`.
    pub sensitivity: Sensitivity,
}

/// Longest accepted pattern.
pub const MAX_PATTERN_LEN: usize = 256;

#[derive(Debug, Clone)]
struct CompiledPattern {
    source: NeverSharePattern,
    matchers: Vec<GlobMatcher>,
}

/// Compiles gitignore-like patterns into glob matchers over folded relative paths.
#[derive(Debug, Clone, Default)]
pub struct PatternSet {
    patterns: Vec<CompiledPattern>,
}

impl PatternSet {
    pub fn new(patterns: &[NeverSharePattern]) -> Result<Self> {
        let mut compiled = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            let mut source = pattern.clone();
            if source.sensitivity < Sensitivity::Confidential {
                source.sensitivity = Sensitivity::Confidential;
            }
            compiled.push(CompiledPattern {
                matchers: compile(&source.pattern)?,
                source,
            });
        }
        Ok(Self { patterns: compiled })
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    pub fn patterns(&self) -> impl Iterator<Item = &NeverSharePattern> {
        self.patterns.iter().map(|p| &p.source)
    }

    /// Every pattern that matches `normalized` (a folded relative path) or one of its parent
    /// directories.
    pub fn matches(&self, normalized: &str) -> Vec<&NeverSharePattern> {
        let prefixes = path_and_parents(normalized);
        self.patterns
            .iter()
            .filter(|p| {
                prefixes
                    .iter()
                    .any(|candidate| p.matchers.iter().any(|m| m.is_match(candidate)))
            })
            .map(|p| &p.source)
            .collect()
    }
}

/// Validates one user pattern and returns its matchers.
pub fn validate_pattern(pattern: &str) -> Result<()> {
    compile(pattern).map(|_| ())
}

fn compile(pattern: &str) -> Result<Vec<GlobMatcher>> {
    let invalid = |reason: &str| ContextError::InvalidPattern {
        pattern: pattern.chars().take(MAX_PATTERN_LEN).collect(),
        reason: reason.to_owned(),
    };
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err(invalid("it is empty"));
    }
    if trimmed.len() > MAX_PATTERN_LEN {
        return Err(invalid("it is longer than 256 characters"));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(invalid("it contains control characters"));
    }
    if trimmed.starts_with('!') {
        return Err(invalid(
            "negated patterns can't re-allow a path; never-share rules only add restrictions",
        ));
    }
    let folded = normalize_for_match(trimmed);
    let anchored = folded.starts_with('/');
    let body = folded.trim_start_matches('/').trim_end_matches('/');
    if body.is_empty() {
        return Err(invalid("it matches nothing"));
    }
    let mut globs = vec![body.to_owned()];
    if !anchored && !body.contains('/') {
        globs.push(format!("**/{body}"));
    }
    globs
        .into_iter()
        .map(|glob| {
            GlobBuilder::new(&glob)
                .literal_separator(true)
                .case_insensitive(true)
                .backslash_escape(true)
                .build()
                .map(|g| g.compile_matcher())
                .map_err(|e| invalid(&e.kind().to_string()))
        })
        .collect()
}

/// `a/b/c` → `["a/b/c", "a/b", "a"]`.
fn path_and_parents(normalized: &str) -> Vec<&str> {
    let trimmed = normalized.trim_matches('/');
    let mut out = vec![trimmed];
    let mut rest = trimmed;
    while let Some(index) = rest.rfind('/') {
        rest = &rest[..index];
        out.push(rest);
    }
    out
}

/// A plain list of gitignore-like globs (user exclusions, mission scope). Matches a path or
/// any of its parent directories, case-insensitively, after look-alike folding.
#[derive(Debug, Clone, Default)]
pub struct GlobList {
    entries: Vec<(String, Vec<GlobMatcher>)>,
}

impl GlobList {
    pub fn new<S: AsRef<str>>(patterns: &[S]) -> Result<Self> {
        let entries = patterns
            .iter()
            .map(|p| compile(p.as_ref()).map(|m| (p.as_ref().to_owned(), m)))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { entries })
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// The first pattern matching `relative` (raw; folded here) or one of its parents.
    pub fn first_match(&self, relative: &str) -> Option<&str> {
        let normalized = normalize_for_match(relative);
        let prefixes = path_and_parents(&normalized);
        self.entries
            .iter()
            .find(|(_, matchers)| {
                prefixes
                    .iter()
                    .any(|candidate| matchers.iter().any(|m| m.is_match(candidate)))
            })
            .map(|(pattern, _)| pattern.as_str())
    }
}

/// A never-share decision for one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NeverShareHit {
    Builtin(BuiltinHit),
    Pattern(NeverSharePattern),
}

impl NeverShareHit {
    pub fn sensitivity(&self) -> Sensitivity {
        match self {
            Self::Builtin(hit) => hit.sensitivity,
            Self::Pattern(pattern) => pattern.sensitivity,
        }
    }
}

/// Built-in rules plus the user's global and workspace patterns.
#[derive(Debug, Clone, Default)]
pub struct NeverShareRules {
    patterns: PatternSet,
}

impl NeverShareRules {
    pub fn new(patterns: &[NeverSharePattern]) -> Result<Self> {
        Ok(Self {
            patterns: PatternSet::new(patterns)?,
        })
    }

    /// Built-in rules only.
    pub fn builtin() -> Self {
        Self::default()
    }

    pub fn patterns(&self) -> impl Iterator<Item = &NeverSharePattern> {
        self.patterns.patterns()
    }

    /// All hits for a relative path (raw; folded here).
    pub fn check(&self, relative: &str) -> Vec<NeverShareHit> {
        let normalized = normalize_for_match(relative);
        let mut hits = Vec::new();
        if let Some(builtin) = builtin_match(&normalized) {
            hits.push(NeverShareHit::Builtin(builtin));
        }
        hits.extend(
            self.patterns
                .matches(&normalized)
                .into_iter()
                .cloned()
                .map(NeverShareHit::Pattern),
        );
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sensitivity(path: &str) -> Option<Sensitivity> {
        builtin_match(&normalize_for_match(path)).map(|h| h.sensitivity)
    }

    #[test]
    fn builtin_catalogue() {
        use Sensitivity::*;
        let cases: &[(&str, Option<Sensitivity>)] = &[
            (".env", Some(Secret)),
            ("app/.env.production", Some(Secret)),
            ("prod.env", Some(Secret)),
            (".env.example", None),
            (".envrc", Some(Secret)),
            ("keys/id_rsa", Some(Secret)),
            ("keys/id_rsa.pub", None),
            ("src/id_generator.rs", None),
            ("certs/server.PEM", Some(Secret)),
            ("a/.ssh/config", Some(Secret)),
            ("home/.aws/credentials", Some(Secret)),
            (".npmrc", Some(Secret)),
            ("infra/terraform.tfstate", Some(Secret)),
            ("gcp/my-service-account-prod.json", Some(Secret)),
            (".git/config", Some(Confidential)),
            ("exports/customers_export_2026.csv", Some(Confidential)),
            ("db/backup.sql", Some(Confidential)),
            ("src/customer.rs", None),
            ("data/users.csv", None),
            ("README.md", None),
        ];
        for (path, expected) in cases {
            assert_eq!(sensitivity(path), *expected, "{path}");
        }
    }

    #[test]
    fn user_patterns_match_names_dirs_and_case() {
        let rules = NeverShareRules::new(&[
            NeverSharePattern {
                scope: PatternScope::Global,
                pattern: "*.sqlite".into(),
                sensitivity: Sensitivity::Confidential,
            },
            NeverSharePattern {
                scope: PatternScope::Workspace {
                    workspace_id: "w".into(),
                },
                pattern: "private/".into(),
                sensitivity: Sensitivity::Secret,
            },
            NeverSharePattern {
                scope: PatternScope::Global,
                pattern: "/docs/internal/*.md".into(),
                sensitivity: Sensitivity::Public,
            },
        ])
        .expect("rules");
        assert_eq!(rules.check("data/App.SQLITE").len(), 1);
        assert_eq!(rules.check("Private/notes/today.txt").len(), 1);
        assert_eq!(rules.check("docs/internal/plan.md").len(), 1);
        assert!(rules.check("other/docs/internal/plan.md").is_empty());
        // Public was raised to Confidential: a never-share pattern always restricts.
        assert_eq!(
            rules.check("docs/internal/plan.md")[0].sensitivity(),
            Sensitivity::Confidential
        );
    }

    #[test]
    fn invalid_patterns_are_refused() {
        for bad in ["", "   ", "!keep.txt", "a[", "/"] {
            assert!(validate_pattern(bad).is_err(), "{bad:?}");
        }
    }
}
