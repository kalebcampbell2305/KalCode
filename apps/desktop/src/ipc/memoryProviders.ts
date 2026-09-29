/**
 * Provider catalog and fake detection for the in-memory transport (unit tests and the `ui-test`
 * build only). Static values mirror `crates/providers/src/catalog.rs` and
 * `crates/providers/src/claude/argv.rs`, `codex/argv.rs` and `gemini/mod.rs` (Windows build) so the
 * UI is tested against real copy.
 *
 * Fake machines: by default Claude Code and Codex are installed and signed in, and Gemini CLI is
 * installed (its sign-in can't be checked). `providers-none`: nothing installed.
 * `providers-outdated`: Claude Code too old and signed out. `providers-signed-out`: Codex signed
 * out, Gemini CLI not installed. `providers-backoff`: the default machine (Provider Health shows a
 * reported rate limit, see ./memory/health.ts).
 */
import type { PermissionMapping, ProviderDetection, ProviderStatus } from "@kalcode/protocol";

export type ProviderScenario =
  | "default"
  | "providers-error"
  | "providers-none"
  | "providers-outdated"
  | "providers-signed-out"
  | "providers-backoff";

const stricter = (mode: PermissionMapping["mode"], providerSetting: string, notes: string): PermissionMapping => ({
  mode,
  fidelity: "approximate_stricter",
  providerSetting,
  notes,
});

const remoteDenied = "18-credential-file-rules,112-remote-action-rules";
const askFirstDenied = `Edit,Write,NotebookEdit,WebFetch,WebSearch,${remoteDenied}`;
const claudeEnforced =
  "KalCode always denies git push, package publishes, deploy and cloud CLIs, gh and ssh, and reading credential files such as .env and SSH keys, whatever your Claude Code settings allow.";
const claudeNotYet =
  "Other commands follow Claude Code's own rules, including your Claude Code user settings (allow rules and hooks), and a push written in an unusual form is decided by them. KalCode doesn't ask you about each of these actions, and Custom rules don't apply to them.";

/** Mirrors `crates/providers/src/codex/argv.rs` `permission_setting` (generated from the argv). */
function codexSetting(mode: PermissionMapping["mode"]): string {
  const sandbox =
    mode === "bypass"
      ? "--sandbox workspace-write -c sandbox_workspace_write.network_access=false"
      : "--sandbox read-only --skip-git-repo-check";
  return `${sandbox} -c approval_policy='never' -c web_search='disabled' -c shell_environment_policy.inherit='core' --ignore-rules`;
}

const codexNotEnforced =
  "Codex has no deny-rule flag: KalCode can't stop reads of credential files inside the workspace, and remote actions are stopped by the sandbox's network block, not by KalCode rules.";
const geminiNotEnforced =
  "Gemini CLI has no deny-rule flag KalCode can pass per session: reads of credential files aren't blocked by KalCode, and settings of a folder you trusted in Gemini CLI still apply.";

export function providerCatalog(): ProviderStatus[] {
  return [
    {
      id: "claude-code",
      displayName: "Claude Code",
      detection: null,
      detectionErrorCode: null,
      authCheck: "claude auth status",
      capabilities: {
        streaming: true,
        interrupt: true,
        resume: true,
        hostApprovals: false,
        interactive: null,
        models: [
          { id: "default", displayName: "Account default", isDefault: true },
          { id: "opus", displayName: "Opus", isDefault: false },
          { id: "sonnet", displayName: "Sonnet", isDefault: false },
          { id: "haiku", displayName: "Haiku", isDefault: false },
          { id: "fable", displayName: "Fable", isDefault: false },
        ],
        permissionMappings: [
          stricter(
            "plan",
            `--restricted --permission-mode plan --permission-prompts none --disallowedTools ${askFirstDenied}`,
            `Claude Code can read and plan but has no tools that run commands, edit files or fetch web pages, and your Claude Code settings are not loaded. ${claudeEnforced}`,
          ),
          stricter(
            "approve",
            `--setting-sources user --permission-mode default --permission-prompts none --disallowedTools ${askFirstDenied}`,
            `Reads and Claude Code's read-only commands run. Edits and web access are removed, and anything else that would ask is refused, because KalCode doesn't answer Claude Code's approval prompts. ${claudeEnforced} ${claudeNotYet}`,
          ),
          stricter(
            "auto",
            `--setting-sources user --permission-mode default --permission-prompts none --disallowedTools ${askFirstDenied}`,
            `Runs like Approve. Claude Code's own auto mode is not used, because its classifier's decisions are not your KalCode policy. ${claudeEnforced} ${claudeNotYet}`,
          ),
          stricter(
            "bypass",
            `--setting-sources user --permission-mode acceptEdits --permission-prompts none --disallowedTools ${remoteDenied}`,
            `File edits and common file commands in the workspace run without asking; anything else that would ask is refused. Claude Code's bypassPermissions mode is never used. ${claudeEnforced} ${claudeNotYet}`,
          ),
        ],
      },
      adapter: "implemented",
      modelSource: "documented_aliases",
      integration: "Headless mode (claude -p) with stream-JSON input and output",
      signInCommand: "claude auth login",
      installCommand: "irm https://claude.ai/install.ps1 | iex",
      docsUrl: "https://code.claude.com/docs/en/setup",
    },
    {
      id: "codex",
      displayName: "Codex",
      detection: null,
      detectionErrorCode: null,
      authCheck: "codex login status",
      capabilities: {
        streaming: true,
        interrupt: true,
        resume: true,
        hostApprovals: false,
        interactive: null,
        models: [],
        permissionMappings: [
          stricter(
            "plan",
            codexSetting("plan"),
            `Reads and read-only commands inside Codex's read-only sandbox; edits, network and anything that would ask are refused. ${codexNotEnforced}`,
          ),
          stricter(
            "approve",
            codexSetting("approve"),
            `Runs like Plan: edits would need an approval KalCode can't give Codex yet, so they're refused instead of asking. ${codexNotEnforced}`,
          ),
          stricter("auto", codexSetting("auto"), `Runs like Approve. ${codexNotEnforced}`),
          stricter(
            "bypass",
            codexSetting("bypass"),
            `Edits and commands inside the workspace, with network access off. danger-full-access is never used. ${codexNotEnforced}`,
          ),
        ],
      },
      adapter: "implemented",
      modelSource: "not_discoverable",
      integration:
        "Headless mode (codex exec --json) with JSON Lines events, one process per turn resumed by thread id",
      signInCommand: "codex login",
      installCommand: "npm install -g @openai/codex",
      docsUrl: "https://github.com/openai/codex",
    },
    {
      id: "gemini-cli",
      displayName: "Gemini CLI",
      detection: null,
      detectionErrorCode: null,
      authCheck: null,
      capabilities: {
        streaming: true,
        interrupt: true,
        resume: true,
        hostApprovals: false,
        interactive: null,
        models: [
          { id: "auto", displayName: "Auto (default)", isDefault: true },
          { id: "pro", displayName: "Pro", isDefault: false },
          { id: "flash", displayName: "Flash", isDefault: false },
          { id: "flash-lite", displayName: "Flash-Lite", isDefault: false },
        ],
        permissionMappings: [
          stricter("plan", "--approval-mode plan", `Gemini CLI's read-only plan mode. ${geminiNotEnforced}`),
          stricter(
            "approve",
            "--approval-mode default",
            `Tool calls that need confirmation can't be answered in headless mode, so they don't run. ${geminiNotEnforced}`,
          ),
          stricter("auto", "--approval-mode default", `Runs like Approve. ${geminiNotEnforced}`),
          stricter(
            "bypass",
            "--approval-mode auto_edit",
            `File edits are approved automatically; other tools that need confirmation don't run. yolo mode is never used. ${geminiNotEnforced}`,
          ),
        ],
      },
      adapter: "implemented",
      modelSource: "documented_aliases",
      integration: "Headless mode with --output-format stream-json, one process per turn resumed by session id",
      signInCommand: "gemini",
      installCommand: "npm install -g @google/gemini-cli",
      docsUrl: "https://geminicli.com/docs/",
    },
  ];
}

type Fake = Pick<ProviderDetection, "state" | "displayPath" | "version" | "auth" | "message">;

const NOT_INSTALLED: Fake = {
  state: "not_installed",
  displayPath: null,
  version: null,
  auth: "unknown",
  message: null,
};

/** What detection finds on the fake machine for each scenario. */
function fakeMachine(scenario: ProviderScenario): Record<string, Fake> {
  if (scenario === "providers-none") {
    return { "claude-code": NOT_INSTALLED, codex: NOT_INSTALLED, "gemini-cli": NOT_INSTALLED };
  }
  const claude: Fake =
    scenario === "providers-outdated"
      ? {
          state: "outdated",
          displayPath: "~\\.local\\bin\\claude.exe",
          version: "2.1.100",
          auth: "not_authenticated",
          message: "KalCode needs version 2.1.259 or later to run Claude Code threads.",
        }
      : {
          state: "installed",
          displayPath: "~\\.local\\bin\\claude.exe",
          version: "2.1.282",
          auth: "authenticated",
          message: null,
        };
  const signedOut = scenario === "providers-signed-out";
  return {
    "claude-code": claude,
    codex: {
      state: "installed",
      displayPath: "~\\AppData\\Roaming\\npm\\codex.cmd",
      version: "0.155.1",
      auth: signedOut ? "not_authenticated" : "authenticated",
      message: null,
    },
    "gemini-cli": signedOut
      ? NOT_INSTALLED
      : {
          state: "installed",
          displayPath: "~\\AppData\\Roaming\\npm\\gemini.cmd",
          version: "0.12.0",
          // Gemini CLI documents no side-effect-free sign-in check.
          auth: "unknown",
          message: null,
        },
  };
}

const MINIMUM_VERSIONS: Record<string, string | null> = {
  "claude-code": "2.1.259",
  codex: "0.155.0",
  "gemini-cli": null,
};

/** Applies one fake detection to the cached statuses; returns whether each provider changed. */
export function detectFake(
  statuses: ProviderStatus[],
  scenario: ProviderScenario,
  checkedAt: string,
): { next: ProviderStatus[]; changed: ProviderStatus[] } {
  const machine = fakeMachine(scenario);
  const changed: ProviderStatus[] = [];
  const next = statuses.map((status) => {
    const found = machine[status.id] ?? NOT_INSTALLED;
    const detection: ProviderDetection = {
      providerId: status.id,
      displayName: status.displayName,
      minimumVersion: MINIMUM_VERSIONS[status.id] ?? null,
      checkedAt,
      ...found,
    };
    const updated = { ...status, detection, detectionErrorCode: null };
    if (status.detection?.state !== detection.state || status.detection?.version !== detection.version) {
      changed.push(updated);
    }
    return updated;
  });
  return { next, changed };
}
