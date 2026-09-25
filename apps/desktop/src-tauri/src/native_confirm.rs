//! The native confirmation dialog (ADVANCED.md §3 D8, Trust Kernel K10): the Tauri
//! implementation of [`kalcode_core::confirm::NativeConfirmer`].
//!
//! The dialog is an OS window owned by the native side; the WebView cannot read it, draw over it
//! or press its buttons. Its text comes from [`NativeConfirmation`], composed in Rust from
//! structured facts. Showing blocks until the person answers, so callers run it off the main
//! thread (`tauri::async_runtime::spawn_blocking`).
//!
//! Wiring into Bypass enablement and remote-consequential approvals is Trust Kernel phase 1
//! (TK-1); this module is the helper and its test hook only.

use kalcode_core::confirm::{DialogAnswer, NativeConfirmation, NativeConfirmer};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::environment;

/// Shows confirmations as native message dialogs, parented to the main window when it exists.
pub struct TauriConfirmer<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriConfirmer<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> NativeConfirmer for TauriConfirmer<R> {
    fn show(&self, confirmation: &NativeConfirmation) -> DialogAnswer {
        // Test builds only: the E2E suite cannot press a native dialog's buttons.
        if let Some(accept) = environment::e2e_native_confirm() {
            return answer(accept);
        }
        let mut dialog = self
            .app
            .dialog()
            .message(confirmation.message())
            .title(confirmation.title())
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                confirmation.confirm_label().to_owned(),
                confirmation.cancel_label().to_owned(),
            ));
        match self.app.get_webview_window("main") {
            Some(window) => dialog = dialog.parent(&window),
            // No window to attach to: still ask, as a top-level dialog.
            None => tracing::warn!(event = "confirm.native_no_parent_window"),
        }
        answer(dialog.blocking_show())
    }
}

fn answer(confirmed: bool) -> DialogAnswer {
    if confirmed {
        DialogAnswer::Confirmed
    } else {
        DialogAnswer::Declined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_dialog_is_a_refusal() {
        assert_eq!(answer(true), DialogAnswer::Confirmed);
        assert_eq!(answer(false), DialogAnswer::Declined);
    }
}
