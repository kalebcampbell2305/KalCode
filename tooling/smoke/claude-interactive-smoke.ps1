<#
.SYNOPSIS
  Owner-approved smoke run of a REAL Claude Code session in a KalCode provider pane (Z7-W4).

.DESCRIPTION
  WRITTEN, NOT RUN. This starts the real `claude` CLI installed on this machine, in a temporary
  folder, and sends ONE short prompt (read a file, reply with one word). It CONSUMES THE
  OWNER'S AI QUOTA and must only be run with the owner's explicit approval.

  It checks what the fake provider cannot (docs/campaigns/Z7-W4-THREATS.md section 5):
    - hooks from KalCode's --settings file load together with --setting-sources user
    - exec-form hook "args" work (no shell)
    - the hook helper finds its key in the environment the provider passes to hooks
    - SessionStart / UserPromptSubmit / PreToolUse / PostToolUse payload shapes
    - a KalCode "allow" from the PreToolUse hook reaches the provider
  Nothing is written to the owner's Claude Code settings or to KalCode's app data.

.EXAMPLE
  pwsh tooling/smoke/claude-interactive-smoke.ps1 -IUnderstandThisUsesQuota
#>
param(
  [switch]$IUnderstandThisUsesQuota
)

$ErrorActionPreference = "Stop"
if (-not $IUnderstandThisUsesQuota) {
  Write-Error "This starts a real Claude Code session and uses AI quota. Re-run with -IUnderstandThisUsesQuota after the owner approves."
  exit 1
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $root
try {
  # The helper the pane's hooks run, built from this checkout.
  cargo build --release -p kalcode-hook-bridge --bin kalcode-hook
  if ($LASTEXITCODE -ne 0) { throw "building kalcode-hook failed" }
  $exe = if ($IsWindows -or $env:OS -eq "Windows_NT") { "kalcode-hook.exe" } else { "kalcode-hook" }
  $helper = Join-Path $root "target\release\$exe"
  if (-not (Test-Path $helper)) { throw "kalcode-hook not found at $helper" }

  $env:KALCODE_REAL_PROVIDER_SMOKE = "1"
  $env:KALCODE_HOOK_PROGRAM = (Resolve-Path $helper).Path
  cargo test -p kalcode-providers --test interactive_real -- --ignored --nocapture real_claude_interactive_smoke
  if ($LASTEXITCODE -ne 0) { throw "the smoke run failed; see the output above" }
  Write-Host "Smoke run passed. Record the result in docs/campaigns/Z7-W4.md (verification items)."
}
finally {
  Remove-Item Env:KALCODE_REAL_PROVIDER_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:KALCODE_HOOK_PROGRAM -ErrorAction SilentlyContinue
  Pop-Location
}
