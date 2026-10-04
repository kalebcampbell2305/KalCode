/**
 * Provider catalog and fake detection for the in-memory transport (unit tests and the `ui-test`
 * build only). Static values mirror `crates/providers/src/catalog.rs` and
 * `crates/providers/src/claude/argv.rs`, `codex/argv.rs` and `gemini/mod.rs` (Windows build) so the
 * UI is tested against real copy.
 *
 * Fake machines: by default Claude Code, Codex and Gemini CLI are installed. Codex reports its
 * sign-in state; Claude and Gemini defer it to a real session. `providers-none`: nothing installed.
 * `providers-outdated`: Claude Code is too old. `providers-signed-out`: Codex is signed
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
    mode === "plan"
      ? "--sandbox read-only --skip-git-repo-check -c approval_policy='never'"
      : mode === "bypass"
        ? "--sandbox danger-full-access -c approval_policy='never'"
        : `--sandbox workspace-write -c approval_policy='${mode === "auto" ? "never" : "on-request"}'`;
  const policy = [
    "--ignore-rules",
    "--ignore-user-config",
    "mcp_servers={}",
    "web_search='disabled'",
    "shell_environment_policy.inherit='core'",
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.writable_roots=[]",
    "windows.sandbox='unelevated'",
    "features.apps=false",
    "features.plugins=false",
    "features.remote_plugin=false",
    "features.hooks=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "features.skill_mcp_dependency_install=false",
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.computer_use=false",
    "features.in_app_browser=false",
    "features.image_generation=false",
    "features.code_mode_host=true",
    "features.auth_elicitation=false",
    "features.tool_call_mcp_elicitation=false",
  ];
  return `${sandbox} ${policy.map((value) => (value.startsWith("--") ? value : `-c ${value}`)).join(" ")}`;
}

const codexNotEnforced =
  "Codex has no deny-rule flag: KalCode can't stop reads of credential files that its native sandbox permits.";
const geminiNotEnforced =
  "Gemini Plan retains core project read tools, so it is not a secret-file privacy boundary. Managed profiles accept only the certified Gemini CLI 0.61.0 configuration behavior.";

export function providerCatalog(): ProviderStatus[] {
  return [
    {
      id: "claude-code",
      displayName: "Claude Code",
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
            `--setting-sources user --permission-mode auto --permission-prompts none --disallowedTools ${remoteDenied}`,
            `Claude Code's background classifier checks edits, shell commands and network requests. If Auto is unavailable for the selected account, model or organization, Claude Code falls back to Manual; prompts are refused in this headless session. ${claudeEnforced} ${claudeNotYet}`,
          ),
          stricter(
            "bypass",
            "--setting-sources user --permission-mode bypassPermissions --permission-prompts none --disallowedTools 18-credential-file-rules",
            "Everything runs without asking (Claude Code's bypassPermissions mode), with your Claude Code user settings; only credential files stay unreadable.",
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
            `Workspace writes use Codex's native on-request approval prompt; connected tools and web search remain disabled. ${codexNotEnforced}`,
          ),
          stricter(
            "auto",
            codexSetting("auto"),
            `Workspace writes run without approval prompts inside Codex's native sandbox; connected tools and web search remain disabled. ${codexNotEnforced}`,
          ),
          stricter(
            "bypass",
            codexSetting("bypass"),
            `Uses Codex's explicit danger-full-access sandbox with approval prompts disabled; connected tools and web search remain disabled. ${codexNotEnforced}`,
          ),
        ],
      },
      adapter: "implemented",
      modelSource: "not_discoverable",
      integration:
        "Headless mode (codex exec --json) with JSON Lines events, one process per turn resumed by thread id",
      signInCommand: "codex login",
      installCommand: "npm install -g @openai/codex@0.160.0",
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
          stricter(
            "auto",
            "--approval-mode auto_edit",
            `File edits are approved automatically; shell commands and other tools still require confirmation. yolo mode is never used. ${geminiNotEnforced}`,
          ),
          stricter(
            "bypass",
            "--approval-mode yolo",
            `Everything runs without approval prompts (Gemini CLI's yolo mode). ${geminiNotEnforced}`,
          ),
        ],
      },
      adapter: "implemented",
      modelSource: "documented_aliases",
      integration: "Headless mode with --output-format stream-json, one process per turn resumed by session id",
      signInCommand: "gemini",
      installCommand: "npm install -g @google/gemini-cli@0.61.0",
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
          auth: "unknown",
          message: "KalCode needs version 2.1.259 or later to run Claude Code threads.",
        }
      : {
          state: "installed",
          displayPath: "~\\.local\\bin\\claude.exe",
          version: "2.1.282",
          auth: "unknown",
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
