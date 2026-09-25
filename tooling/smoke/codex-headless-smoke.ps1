<#
.SYNOPSIS
  Owner-approved smoke run of REAL Codex headless turns through KalCode's adapter (PROVIDERS-2).

.DESCRIPTION
  WRITTEN, NOT RUN. This starts the real `codex` CLI installed on this machine (`codex exec
  --json`), in an empty temporary folder, in Plan mode (read-only sandbox, approval_policy
  never), and sends TWO one-word prompts (the second resumes the first thread). It CONSUMES THE
  OWNER'S AI QUOTA and must only be run with the owner's explicit approval.

  It checks what the fixtures cannot (docs/campaigns/PROVIDERS-2.md, verification items):
    - codex-cli accepts every flag KalCode passes (-c approval_policy='never',
      -c web_search='disabled', -c shell_environment_policy.inherit='core', --ignore-rules,
      --sandbox read-only, --skip-git-repo-check) and reads the prompt from stdin (`-`)
    - the real JSONL shapes: thread.started, turn.started, item.completed agent_message,
      turn.completed with usage
    - `exec ... resume <thread id> -` continues the same thread
  Nothing is written to the owner's Codex configuration.

.EXAMPLE
  pwsh tooling/smoke/codex-headless-smoke.ps1 -IUnderstandThisUsesQuota
#>
param(
  [switch]$IUnderstandThisUsesQuota
)

$ErrorActionPreference = "Stop"
if (-not $IUnderstandThisUsesQuota) {
  Write-Error "This starts a real Codex session and uses AI quota. Re-run with -IUnderstandThisUsesQuota after the owner approves."
  exit 1
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $root
try {
  # Detection first (no prompt, no quota): --version and `codex login status`.
  cargo test -p kalcode-providers --test turns_real -- --ignored --nocapture real_codex_detection
  if ($LASTEXITCODE -ne 0) { throw "Codex isn't installed and signed in; nothing was sent" }

  $env:KALCODE_REAL_PROVIDER_SMOKE = "1"
  cargo test -p kalcode-providers --test turns_real -- --ignored --nocapture real_codex_session_smoke
  if ($LASTEXITCODE -ne 0) { throw "the smoke run failed; see the output above" }
  Write-Host "Smoke run passed. Record the result in docs/campaigns/PROVIDERS-2.md (verification items)."
}
finally {
  Remove-Item Env:KALCODE_REAL_PROVIDER_SMOKE -ErrorAction SilentlyContinue
  Pop-Location
}
