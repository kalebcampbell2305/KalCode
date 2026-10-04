import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const source = (name) => readFileSync(new URL(`../apps/desktop/src-tauri/src/${name}.rs`, import.meta.url), "utf8");
// A command module may keep its commands in submodule files (`src/<module>/*.rs`), re-exported from `<module>.rs`.
const moduleSource = (name) => {
  const dir = new URL(`../apps/desktop/src-tauri/src/${name}/`, import.meta.url);
  const nested = existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .filter((file) => String(file).endsWith(".rs"))
        .sort()
        .map((file) => readFileSync(new URL(String(file).replaceAll("\\", "/"), dir), "utf8"))
    : [];
  return [source(name), ...nested].join("\n");
};

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
  const opened = startup.indexOf("locator_commands::open_core(config))");
  const reconciled = startup.indexOf("match reconcile_core_startup(&core)", opened);
  const exposed = startup.indexOf("state.core = Some(core)", opened);
  const recovery = startup.indexOf("context_commands::recover_deliveries(core)");
  const guardian = startup.indexOf("core.require_terminal_guardian()", recovery);
  assert.ok(opened >= 0 && reconciled > opened && exposed > reconciled);
  assert.ok(recovery >= 0 && guardian > recovery && guardian < opened);
});

test("KalVoice shutdown retains custody until local interpretation settles", () => {
  const voice = source("kalvoice_commands");
  assert.match(voice, /shutdown_local_interpretation\(Duration::ZERO\)/);
  assert.ok(/let local_settled = self\s*\.orchestrator\s*\.shutdown_local_interpretation/.test(voice));
  assert.match(voice, /downloads_settled && background_settled && local_settled/);
});

test("provider routing preserves terminal identity before identical account and resource guards", () => {
  const commands = source("thread_commands");
  const guard = commands.match(/let guard = \|provider:[^\n]+\{([\s\S]*?)\n {4}\};/)?.[1];
  assert.ok(guard, "the provider branches must share one guard factory");
  assert.match(guard, /ObservedProvider::wrap\(provider, health\)/);
  assert.match(
    guard,
    /if interactive \{\s*ResourceAdmissionProvider::wrap_interactive\(observed, resources\.clone\(\)\)\s*\} else \{\s*ResourceAdmissionProvider::wrap\(observed, resources\.clone\(\)\)/,
  );
  assert.match(guard, /ResourceAdmissionProvider::wrap\(observed, resources\.clone\(\)\)/);
  assert.match(guard, /AccountBoundProvider::managed\(\s*governed,\s*runtime\.clone\(\),/);
  assert.match(commands, /routes\.route_claude\(headless, guard\)/);
  for (const provider of ["CODEX", "GEMINI_CLI"]) {
    assert.match(commands, new RegExp(`routes\\.route_cli\\(ProviderId::${provider}, headless, guard\\)`));
  }
  const routes = source("provider_pane_commands");
  assert.equal(
    [...routes.matchAll(/Arc::new\(router\.with_session_guards\(guard\)\)/g)].length,
    2,
    "both Claude and CLI routes must keep the router outside the guards",
  );
  const router = readFileSync(new URL("../crates/providers/src/interactive/provider.rs", import.meta.url), "utf8");
  assert.match(
    router,
    /self\.headless = guard\(self\.headless, false\);\s*self\.interactive = self\.interactive\.map\(\|provider\| guard\(provider, true\)\)/,
  );
  const routing = router.slice(router.indexOf("impl AgentProvider for RuntimeRouter"));
  const persisted = routing.indexOf("self.mark(&config.thread_id)?");
  const interactiveStart = routing.indexOf("provider.start_session(config, sink)");
  const headlessStart = routing.indexOf("self.headless.start_session(config, sink)");
  assert.ok(persisted >= 0 && interactiveStart > persisted && headlessStart > persisted);
  assert.match(commands, /resources: Arc<crate::resource_commands::ResourceGovernorState>/);
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
    const signature = moduleSource(module).match(
      new RegExp(`pub (?:async )?fn ${command}\\(([\\s\\S]*?)\\)\\s*(?:->[^\\{]+)?\\{`),
    );
    if (!signature?.[1].includes("RuntimeAccess")) unguarded.push(command);
  }
  assert.deepEqual(unguarded, []);
  assert.ok(registered.length > 130, "the check must inspect the real registered inventory");
});
