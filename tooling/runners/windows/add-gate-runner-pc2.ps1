# One elevated, idempotent step on the second Windows PC (KALEBSLAPTOP): a second gate runner there
# (owner, 2026-10-06), so two lanes' PC2 halves can gate at once instead of queueing on one runner.
#
# It mirrors the first PC2 runner (kalcode-win-gate-2, made by setup-gate-runner.ps1): a new low-privilege
# local account (kalcode-ci-2b) with no credentials, its own root (C:\kalcode-ci-2b: home, toolchain,
# caches, runner, checkout), registered as kalcode-win-gate-2b and run as a Windows service. It also gives
# that account the same Defender exclusions tune-gate-pc2.ps1 gives the first one (its root and %TEMP%).
#
# ACTIVATION IS SEPARATE AND DELIBERATE. The runner registers with the holding label
# kalcode-gate-pc2-pending, so GitHub routes no gate job to it yet. gate.yml and the merge train accept
# kalcode-win-gate-2b (each PC2 runner has its own port block) only once branch ci/gate-pc2-second-runner
# is on main. After that lands, the coordinator activates it from a machine with `gh`:
#   gh api -X PUT repos/kalebcampbell2305/KalCode/actions/runners/<id>/labels -f "labels[]=kalcode-gate-pc2"
# (the id is in this script's receipt and in `gh api repos/kalebcampbell2305/KalCode/actions/runners`).
#
# Registration token: pass -RegistrationToken, or the script fetches one with an authenticated `gh` on
# this PC, or asks for one (paste the output of, on any machine where gh is signed in:
#   gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
# ). Tokens expire after one hour.
#
# Usage (elevated PowerShell on KALEBSLAPTOP; setup-gate-runner.ps1 must sit next to this script):
#   powershell -NoProfile -ExecutionPolicy Bypass -File add-gate-runner-pc2.ps1
param(
    [string]$RegistrationToken = '',
    [string]$Account = 'kalcode-ci-2b',
    [string]$Root = 'C:\kalcode-ci-2b',
    [string]$RunnerName = 'kalcode-win-gate-2b',
    [string]$Label = 'kalcode-gate-pc2-pending'
)
$ErrorActionPreference = 'Stop'
$repo = 'kalebcampbell2305/KalCode'
$result = [ordered]@{ schema = 'kalcode-pc2-second-gate-runner/v1'; at = [DateTime]::UtcNow.ToString('o'); host = $env:COMPUTERNAME
    state = 'PREFLIGHT'; errorCode = $null; account = $Account; root = $Root; runner = $RunnerName; label = $Label
    alreadyInstalled = $false; tokenSource = $null; service = $null; runnerId = $null; exclusions = @(); next = $null }
function Refuse([string]$Code) { $result.errorCode = $Code; throw "Second PC2 gate runner refused: $Code" }

try {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ($env:COMPUTERNAME -ne 'KALEBSLAPTOP') { Refuse 'wrong_host' }
    if ($RunnerName -notin @('kalcode-win-gate-2b')) { Refuse 'runner_name_not_accepted_by_gate_yml' }
    $setup = Join-Path $PSScriptRoot 'setup-gate-runner.ps1'
    if (-not (Test-Path -LiteralPath $setup)) { Refuse 'setup_gate_runner_ps1_missing_next_to_this_script' }
    foreach ($tool in 'node', 'npm', 'git') { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Refuse "missing_$tool" } }

    $serviceName = "actions.runner.$($repo -replace '/', '-').$RunnerName"
    $existing = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
    if ($existing -and (Test-Path -LiteralPath (Join-Path $Root 'runner\.runner'))) {
        # Idempotent: rerunning setup would reset the account password under a running service.
        $result.alreadyInstalled = $true
    } else {
        if (-not $RegistrationToken) {
            $gh = Get-Command gh -ErrorAction SilentlyContinue
            if ($gh) {
                $RegistrationToken = (& $gh.Source api -X POST "repos/$repo/actions/runners/registration-token" --jq .token 2>$null | Out-String).Trim()
                if ($RegistrationToken) { $result.tokenSource = 'gh' }
            }
        } else { $result.tokenSource = 'parameter' }
        if (-not $RegistrationToken) {
            Write-Host "gh is not available or not signed in here. On a machine where gh is signed in, run:"
            Write-Host "  gh api -X POST repos/$repo/actions/runners/registration-token --jq .token"
            $RegistrationToken = (Read-Host 'Paste the registration token').Trim()
            $result.tokenSource = 'pasted'
        }
        if ($RegistrationToken -notmatch '^[A-Za-z0-9]{20,}$') { Refuse 'registration_token_missing_or_malformed' }
        & $setup -RegistrationToken $RegistrationToken -Root $Root -Account $Account -RunnerName $RunnerName -Labels $Label
        if (-not $?) { Refuse 'setup_gate_runner_failed' }
    }

    # The same Defender exclusions tune-gate-pc2.ps1 gives the first gate account: its root and %TEMP%.
    $user = Get-LocalUser -Name $Account -ErrorAction Stop
    $profileDir = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value }).LocalPath
    $paths = @($Root) + @(if ($profileDir) { Join-Path $profileDir 'AppData\Local\Temp' })
    if (Get-Command Add-MpPreference -ErrorAction SilentlyContinue) {
        $current = @((Get-MpPreference).ExclusionPath)
        foreach ($path in $paths) {
            if ($current -notcontains $path) { Add-MpPreference -ExclusionPath $path }
            $result.exclusions += $path
        }
    }

    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if (-not $service) { Refuse 'runner_service_missing_after_setup' }
    if ($service.State -ne 'Running') { Start-Service -Name $serviceName; $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" }
    if ($service.State -ne 'Running') { Refuse 'runner_service_not_running' }
    if ($service.StartName -notmatch [regex]::Escape($Account)) { Refuse 'runner_service_wrong_account' }
    $result.service = [ordered]@{ name = $serviceName; state = $service.State; account = $service.StartName }
    try { $result.runnerId = (Get-Content -Raw -LiteralPath (Join-Path $Root 'runner\.runner') | ConvertFrom-Json).agentId } catch { }
    $result.next = "After ci/gate-pc2-second-runner is on main: gh api -X PUT repos/$repo/actions/runners/$($result.runnerId)/labels -f `"labels[]=kalcode-gate-pc2`""
    $result.state = if ($result.alreadyInstalled) { 'ALREADY_INSTALLED' } else { 'INSTALLED' }
} catch {
    $result.state = 'FAILED'
    if (-not $result.errorCode) { $result.errorCode = $_.Exception.Message }
} finally {
    $receipt = $result | ConvertTo-Json -Depth 5
    try { if (Test-Path -LiteralPath $Root) { Set-Content -LiteralPath (Join-Path $Root ('add-runner-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json')) -Value $receipt -Encoding UTF8 } }
    catch { Write-Warning "Receipt not written: $($_.Exception.Message)" }
    Write-Output $receipt
}
if ($result.state -eq 'FAILED') { exit 1 }
