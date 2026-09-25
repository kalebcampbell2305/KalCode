//! `kalcode-hook`: the helper KalCode's session settings run for each provider hook.
//! See `kalcode_hook_bridge::helper` and docs/campaigns/Z7-W4-THREATS.md.

use std::io::Write;

use kalcode_hook_bridge::helper::{self, HelperEnv};

fn main() {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    // Release builds abort on panic, and an abort's exit code does not block a tool call. So a
    // panic exits explicitly: 2 (block) for PreToolUse, 0 (no-op) for status events.
    let blocking = helper::is_blocking_invocation(&args);
    std::panic::set_hook(Box::new(move |_| {
        std::process::exit(if blocking { 2 } else { 0 });
    }));
    let env = HelperEnv::from_process();
    let rendered = helper::run(&args, &mut std::io::stdin().lock(), &env);
    if !rendered.stdout.is_empty() {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(rendered.stdout.as_bytes());
        let _ = out.flush();
    }
    if !rendered.stderr.is_empty() {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(rendered.stderr.as_bytes());
        let _ = err.flush();
    }
    std::process::exit(rendered.exit_code);
}
