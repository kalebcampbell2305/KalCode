<#
.SYNOPSIS
  Owner-approved smoke run of REAL Gemini CLI headless turns through KalCode's adapter
  (PROVIDERS-2).

.DESCRIPTION
  WRITTEN, NOT RUN. Gemini CLI is not installed on the verification machine; install it first
  (`npm install -g @google/gemini-cli`) and sign in with its own flow (`gemini`).

  This starts the real `gemini` CLI with `--output-format stream-json --approval-mode plan`, in an
  empty temporary folder, and sends TWO one-word prompts on stdin (the second with
  `--resume <session id>`). It CONSUMES THE OWNER'S AI QUOTA and must only be run with the
  owner's explicit approval.

  It checks what the fixtures cannot (docs/campaigns/PROVIDERS-2.md, verification items):
    - headless mode from piped stdin without -p, with stream-json output
    - `--approval-mode plan` is accepted by the installed version
    - the real event shapes: init (session_id, model), message deltas, result with stats
    - `--resume <uuid>` continues the same session
    - how an untrusted temporary folder behaves in headless mode (folder trust)

.EXAMPLE
  pwsh tooling/smoke/gemini-headless-smoke.ps1 -IUnderstandThisUsesQuota
#>
param(
  [switch]$IUnderstandThisUsesQuota
)

$ErrorActionPreference = "Stop"
if (-not $IUnderstandThisUsesQuota) {
  Write-Error "This starts a real Gemini CLI session and uses AI quota. Re-run with -IUnderstandThisUsesQuota after the owner approves."
  exit 1
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $root
try {
  cargo test -p kalcode-providers --test turns_real -- --ignored --nocapture real_gemini_detection
  if ($LASTEXITCODE -ne 0) { throw "Gemini CLI isn't installed; nothing was sent" }

  $env:KALCODE_REAL_PROVIDER_SMOKE = "1"
  cargo test -p kalcode-providers --test turns_real -- --ignored --nocapture real_gemini_session_smoke
  if ($LASTEXITCODE -ne 0) { throw "the smoke run failed; see the output above" }
  Write-Host "Smoke run passed. Record the result in docs/campaigns/PROVIDERS-2.md (verification items)."
}
finally {
  Remove-Item Env:KALCODE_REAL_PROVIDER_SMOKE -ErrorAction SilentlyContinue
  Pop-Location
}
