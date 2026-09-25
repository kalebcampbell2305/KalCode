<#
.SYNOPSIS
  Owner-approved smoke run of a REAL Codex session in a KalCode provider pane (PROVIDERS-2).

.DESCRIPTION
  WRITTEN, NOT RUN. This starts the real `codex` TUI in a pseudo-terminal, in an empty temporary
  folder, in Plan mode (`-s read-only -a on-request`), types one short prompt and then one that
  needs approval (which is declined in Codex's own prompt). It CONSUMES THE OWNER'S AI QUOTA and
  must only be run with the owner's explicit approval.

  It checks what the fake provider cannot (docs/PROVIDER_PANES.md section 7):
    - `-c notify=[...]` runs KalCode's hook helper with the documented payload
      (agent-turn-complete, thread-id)
    - `-c tui.notifications=['approval-requested']` with `tui.notification_method='osc9'` and
      `tui.notification_condition='always'` raises OSC 9 under ConPTY
    - nothing is written in Plan mode
  Nothing is written to the owner's Codex configuration.

.EXAMPLE
  pwsh tooling/smoke/codex-interactive-smoke.ps1 -IUnderstandThisUsesQuota
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
  cargo build --release -p kalcode-hook-bridge --bin kalcode-hook
  if ($LASTEXITCODE -ne 0) { throw "building kalcode-hook failed" }
  $exe = if ($IsWindows -or $env:OS -eq "Windows_NT") { "kalcode-hook.exe" } else { "kalcode-hook" }
  $helper = Join-Path $root "target\release\$exe"
  if (-not (Test-Path $helper)) { throw "kalcode-hook not found at $helper" }

  $env:KALCODE_REAL_PROVIDER_SMOKE = "1"
  $env:KALCODE_HOOK_PROGRAM = (Resolve-Path $helper).Path
  cargo test -p kalcode-providers --test interactive_cli_real -- --ignored --nocapture real_codex_interactive_smoke
  if ($LASTEXITCODE -ne 0) { throw "the smoke run failed; see the output above" }
  Write-Host "Smoke run passed. Record the result in docs/campaigns/PROVIDERS-2.md (verification items)."
}
finally {
  Remove-Item Env:KALCODE_REAL_PROVIDER_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:KALCODE_HOOK_PROGRAM -ErrorAction SilentlyContinue
  Pop-Location
}
