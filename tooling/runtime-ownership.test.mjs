import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (name) => readFileSync(new URL(`../apps/desktop/src-tauri/src/${name}.rs`, import.meta.url), "utf8");

test("production KalVoice owns its signed components and injects the local interpreter", () => {
  assert.match(source("runtime_coordinator"), /KalVoiceComponentManager::for_runtime/);
  assert.match(source("kalvoice_commands"), /\.with_local_interpreter\(/);
  assert.match(source("kalvoice_commands"), /shutdown_reasoning\(/);
});

test("reasoning download consent has a native signed-catalog metadata route", () => {
  const command = "kalvoice_reasoning_prepare";
  assert.ok(source("command_registry").includes(`"${command}"`));
  assert.ok(source("lib").includes(`kalvoice_commands::${command},`));
  assert.match(source("kalvoice_commands"), /catalog_identity: Option<String>/);
});

test("startup reconciles interrupted context delivery before exposing the core", () => {
  const startup = source("lib");
  const fenced = startup.indexOf(
    "updater_commands::fence_forward_only_macos_upgrade(&state.paths.data_dir, BUILD_VERSION)",
  );
  const opened = startup.indexOf(
    "match open_core_after_update_fence(update_fence, || locator_commands::open_core(config))",
  );
  const reconciled = startup.indexOf("match reconcile_core_startup(&core)", opened);
  const exposed = startup.indexOf("state.core = Some(core)", opened);
  const recovery = startup.indexOf("context_commands::recover_deliveries(core)");
  const guardian = startup.indexOf("core.require_terminal_guardian()", recovery);
  assert.ok(fenced >= 0 && opened > fenced && reconciled > opened && exposed > reconciled);
  assert.ok(recovery >= 0 && guardian > recovery && guardian < opened);
});

test("KalVoice shutdown retains custody until local interpretation settles", () => {
  const voice = source("kalvoice_commands");
  assert.match(voice, /shutdown_local_interpretation\(Duration::ZERO\)/);
  assert.ok(/let local_settled = self\s*\.orchestrator\s*\.shutdown_local_interpretation/.test(voice));
  assert.match(voice, /downloads_settled && background_settled && local_settled/);
});

test("registered provider routes share the account runtime resource authority", () => {
  assert.match(source("thread_commands"), /ResourceAdmissionProvider::wrap\(observed, resources\)/);
  assert.match(source("thread_commands"), /AccountBoundProvider::managed\(\s*governed,/);
  assert.match(source("thread_commands"), /resources: Arc<crate::resource_commands::ResourceGovernorState>/);
  assert.match(source("runtime_coordinator"), /health\.monitor\(\),\s*resources\.clone\(\),/);
});

test("governed utility commands are reachable through the account-owned runtime", () => {
  const commands = [...source("utility_commands").matchAll(/pub (?:async )?fn (utility_\w+)\(/g)].map(
    (match) => match[1],
  );
  assert.ok(commands.includes("utility_effect_continue"));
  for (const command of commands) {
    assert.ok(source("command_registry").includes(`"${command}"`), `${command} must be allowlisted`);
    assert.ok(source("lib").includes(`utility_commands::${command},`), `${command} must have a handler`);
  }
  assert.match(source("runtime_coordinator"), /service!\(crate::utility_commands::UtilityState, utilities\)/);
  assert.match(source("runtime_coordinator"), /utilities\.shutdown_checked\(\)/);
});

test("provider routers and health monitor belong to a runtime instance", () => {
  assert.doesNotMatch(source("provider_pane_commands"), /static INTERACTIVE/);
  assert.doesNotMatch(source("provider_health_commands"), /static MONITOR/);
});

test("desktop startup does not permanently manage process-capable services", () => {
  assert.doesNotMatch(source("lib"), /app\.manage\((providers|provider_auth|threads|panes|locator|health|kalvoice)\)/);
  assert.match(source("lib"), /RuntimeCoordinator/);
});

test("every registered non-bootstrap native command holds epoch admission", () => {
  const bootstrap = new Set([
    "boot",
    "window_ready",
    "settings_get",
    "settings_update",
    "diagnostics_get",
    "diagnostics_open_log_dir",
    "diagnostics_open_data_dir",
    "secure_store_check",
    "runtime_status",
    "updater_status",
    // Retries a failed runtime startup, so it must work while no runtime epoch is admitted.
    "runtime_retry",
    // Registers the main page's KalVoice signal channel in the app-level hub so it survives runtime
    // generations; it starts no work and reads nothing, and only account-gated runtimes send signals.
    "kalvoice_subscribe",
  ]);
  const registered = [...source("lib").matchAll(/(\w+_commands|commands|runtime_coordinator)::(\w+),/g)];
  const unguarded = [];
  for (const [, module, command] of registered) {
    if (bootstrap.has(command) || module === "account_commands") continue;
    const signature = source(module).match(
      new RegExp(`pub (?:async )?fn ${command}\\(([\\s\\S]*?)\\)\\s*(?:->[^\\{]+)?\\{`),
    );
    if (!signature?.[1].includes("RuntimeAccess")) unguarded.push(command);
  }
  assert.deepEqual(unguarded, []);
  assert.ok(registered.length > 130, "the check must inspect the real registered inventory");
});
