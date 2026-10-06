use super::model::AccountAuthority;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandAuthorization {
    Allowed,
    Denied(&'static str),
}

pub fn authorize_command(command: &str, authority: AccountAuthority) -> CommandAuthorization {
    if is_bootstrap_command(command) {
        return CommandAuthorization::Allowed;
    }
    if !is_active_command(command) {
        return CommandAuthorization::Denied("command_not_authorized");
    }
    match authority {
        AccountAuthority::Bootstrapping => CommandAuthorization::Denied("account_bootstrapping"),
        AccountAuthority::SignedOut => CommandAuthorization::Denied("authentication_required"),
        AccountAuthority::AuthenticatedUnactivated => {
            CommandAuthorization::Denied("account_not_activated")
        }
        AccountAuthority::Active => CommandAuthorization::Allowed,
    }
}

fn is_bootstrap_command(command: &str) -> bool {
    matches!(
        command,
        "account_bootstrap"
            | "runtime_status"
            | "runtime_retry"
            | "updater_status"
            // Live Update's health report must work on every screen, sign-in included.
            | "live_update_status"
            | "live_update_ui_ready"
            | "live_update_begin_reload"
            | "live_update_handoff_ready"
            | "boot"
            | "window_ready"
            | "settings_get"
            | "settings_update"
            | "diagnostics_get"
            | "diagnostics_open_log_dir"
            | "diagnostics_open_data_dir"
            | "secure_store_check"
            | "account_status"
            | "account_email_start"
            | "account_email_poll"
            | "account_social_start"
            | "account_auth_cancel"
            | "account_activate_free"
            | "account_checkout"
            | "account_portal"
            | "account_refresh"
            | "account_logout"
            | "account_usage"
    )
}

fn is_active_command(command: &str) -> bool {
    crate::command_registry::COMMANDS.contains(&command)
        || (crate::environment::TEST_HOOKS_ENABLED && command == "test_permission_probe")
}
