//! Scope helpers: a canonical order (so decisions are deterministic), human labels, and the
//! scope groups the policy refers to.

use kalcode_contracts::permissions::PermissionScope;

/// Every built-in scope, in canonical order. Decisions list scopes in this order.
pub const ALL_SCOPES: [PermissionScope; 19] = [
    PermissionScope::FilesystemRead,
    PermissionScope::FilesystemWrite,
    PermissionScope::FilesystemOutsideWorkspace,
    PermissionScope::TerminalReadOnly,
    PermissionScope::TerminalExecute,
    PermissionScope::PackageInstall,
    PermissionScope::GitRead,
    PermissionScope::GitCommit,
    PermissionScope::GitPush,
    PermissionScope::NetworkDocs,
    PermissionScope::NetworkOther,
    PermissionScope::BrowserNavigate,
    PermissionScope::BrowserInteract,
    PermissionScope::CredentialsAccess,
    PermissionScope::MessagingSend,
    PermissionScope::DeployProduction,
    PermissionScope::CloudModify,
    PermissionScope::BillingSpend,
    PermissionScope::Destructive,
];

/// Position of `scope` in [`ALL_SCOPES`].
pub fn rank(scope: PermissionScope) -> usize {
    ALL_SCOPES
        .iter()
        .position(|s| *s == scope)
        .unwrap_or(ALL_SCOPES.len())
}

/// Dotted wire name (`"git.push"`).
pub fn wire_name(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::FilesystemRead => "filesystem.read",
        PermissionScope::FilesystemWrite => "filesystem.write",
        PermissionScope::FilesystemOutsideWorkspace => "filesystem.outside_workspace",
        PermissionScope::TerminalReadOnly => "terminal.read_only",
        PermissionScope::TerminalExecute => "terminal.execute",
        PermissionScope::PackageInstall => "package.install",
        PermissionScope::GitRead => "git.read",
        PermissionScope::GitCommit => "git.commit",
        PermissionScope::GitPush => "git.push",
        PermissionScope::NetworkDocs => "network.docs",
        PermissionScope::NetworkOther => "network.other",
        PermissionScope::BrowserNavigate => "browser.navigate",
        PermissionScope::BrowserInteract => "browser.interact",
        PermissionScope::CredentialsAccess => "credentials.access",
        PermissionScope::MessagingSend => "messaging.send",
        PermissionScope::DeployProduction => "deploy.production",
        PermissionScope::CloudModify => "cloud.modify",
        PermissionScope::BillingSpend => "billing.spend",
        PermissionScope::Destructive => "destructive",
    }
}

/// Short, sentence-case description of what a scope allows ("Running commands").
pub fn label(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::FilesystemRead => "Reading files in the workspace",
        PermissionScope::FilesystemWrite => "Changing files in the workspace",
        PermissionScope::FilesystemOutsideWorkspace => "Using files outside the workspace",
        PermissionScope::TerminalReadOnly => "Running read-only commands",
        PermissionScope::TerminalExecute => "Running commands",
        PermissionScope::PackageInstall => "Installing packages",
        PermissionScope::GitRead => "Reading Git history",
        PermissionScope::GitCommit => "Changing the local Git repository",
        PermissionScope::GitPush => "Pushing to a Git remote",
        PermissionScope::NetworkDocs => "Reading documentation online",
        PermissionScope::NetworkOther => "Network access",
        PermissionScope::BrowserNavigate => "Opening web pages",
        PermissionScope::BrowserInteract => "Interacting with web pages",
        PermissionScope::CredentialsAccess => "Accessing credentials and secrets",
        PermissionScope::MessagingSend => "Sending messages",
        PermissionScope::DeployProduction => "Deploying or publishing",
        PermissionScope::CloudModify => "Changing remote or cloud resources",
        PermissionScope::BillingSpend => "Spending money",
        PermissionScope::Destructive => "Destructive operations",
    }
}

/// Scopes that ask in Auto mode even when the policy would otherwise cover them, and that can
/// never be granted beyond a single approval.
pub fn is_always_ask(scope: PermissionScope) -> bool {
    scope.is_remote_consequential()
        || matches!(
            scope,
            PermissionScope::Destructive
                | PermissionScope::CredentialsAccess
                | PermissionScope::FilesystemOutsideWorkspace
        )
}

/// Sorts and de-duplicates scopes into canonical order.
pub fn normalize(scopes: &mut Vec<PermissionScope>) {
    scopes.sort_by_key(|s| rank(*s));
    scopes.dedup();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_match_serde() {
        for scope in ALL_SCOPES {
            let json = serde_json::to_string(&scope).expect("json");
            assert_eq!(json, format!("\"{}\"", wire_name(scope)));
        }
    }

    #[test]
    fn remote_consequential_scopes_are_always_ask() {
        for scope in ALL_SCOPES {
            if scope.is_remote_consequential() {
                assert!(is_always_ask(scope), "{scope:?}");
            }
        }
    }

    #[test]
    fn normalize_orders_and_dedups() {
        let mut scopes = vec![
            PermissionScope::Destructive,
            PermissionScope::FilesystemRead,
            PermissionScope::Destructive,
        ];
        normalize(&mut scopes);
        assert_eq!(
            scopes,
            vec![
                PermissionScope::FilesystemRead,
                PermissionScope::Destructive
            ]
        );
    }
}
