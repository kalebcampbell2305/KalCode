# One-time, elevated: grows the build PC's gate runner into a gate worker pool (AGENTS.md "Permanent
# parallel gate worker pool rule"; owner directive 2026-10-04: at least 6 coding agents finish work at once).
#
# Adds -Workers more runner instances next to the existing kalcode-win-gate (default 5, so the pool totals 6).
# Each one is kalcode-win-gate-w<n> in C:\kalcode-ci\runner-w<n>, with the label kalcode-gate, running as a
# Windows service under the SAME low-privilege kalcode-ci account and toolchain that setup-gate-runner.ps1
# installed. Each runner's .env is the existing runner's .env plus:
#   KALCODE_GATE_SLOT=<n>          gate.yml moves every gate port by 10 x slot (kalcode-win-gate is slot 0)
#   KALCODE_GATE_EVIDENCE_DIR      shared pass evidence: a gate already passed for an identical tree is reused
#   KALCODE_GATE_LOCK_DIR          machine-wide heavy-gate tokens (gate.yml "Gate" step)
#   KALCODE_GATE_CONCURRENCY=3     independent gates run concurrently inside one gate
# Heavy Rust gates hold one of KALCODE_GATE_HEAVY_SLOTS tokens (default 3; 24 cores / 64 GB can't build six
# Rust workspaces at once without slowing the owner's KalCode) and need KALCODE_GATE_MIN_FREE_GB free memory.
# Light gates (tooling, website, docs) never wait, so six changes can validate side by side.
#
# kalcode-ci's password is random and held only by the service control manager. Registering a service needs
# it, so this sets ONE new random password and updates the logon of EVERY kalcode-ci runner service, the
# existing one included (a running service keeps its logon until restarted). Idle services restart to load
# their new .env; a busy one is left running and picks it up at its next restart.
#
# Usage (elevated PowerShell; one registration token covers every worker, it is valid for an hour):
#   $t = gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token
#   Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File $PWD\tooling\runners\windows\add-gate-workers.ps1 -RegistrationToken $t"

param(
    [Parameter(Mandatory = $true)][string]$RegistrationToken,
    [ValidateRange(1, 9)][int]$Workers = 5,
    [ValidateRange(1, 9)][int]$HeavySlots = 3,
    [ValidateRange(1, 64)][int]$MinFreeGb = 10,
    [string]$RunnerVersion = '2.337.0',
    [string]$Root = 'C:\kalcode-ci',
    [string]$Account = 'kalcode-ci'
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script elevated (Run as administrator).'
}
$primary = Join-Path $Root 'runner'
$primaryEnv = Join-Path $primary '.env'
if (-not (Test-Path $primaryEnv)) { throw "No gate runner at $primary; run setup-gate-runner.ps1 first." }
if (-not (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue)) { throw "No local account $Account." }

$ciHome = Join-Path $Root 'home'
$evidence = Join-Path $ciHome 'gate-evidence'
$locks = Join-Path $ciHome 'gate-locks'
New-Item -ItemType Directory -Force -Path $evidence, $locks | Out-Null

# The pool settings every runner gets; the existing runner's own entries are replaced, never duplicated.
$poolKeys = 'KALCODE_GATE_SLOT', 'KALCODE_GATE_EVIDENCE_DIR', 'KALCODE_GATE_LOCK_DIR', 'KALCODE_GATE_CONCURRENCY',
    'KALCODE_GATE_HEAVY_SLOTS', 'KALCODE_GATE_MIN_FREE_GB'
$baseEnv = @(Get-Content -Path $primaryEnv | Where-Object { $_ -and ($poolKeys -notcontains ($_ -split '=', 2)[0]) })
function Write-RunnerEnv([string]$dir, [int]$slot) {
    $baseEnv + @(
        "KALCODE_GATE_SLOT=$slot"
        "KALCODE_GATE_EVIDENCE_DIR=$evidence"
        "KALCODE_GATE_LOCK_DIR=$locks"
        'KALCODE_GATE_CONCURRENCY=3'
        "KALCODE_GATE_HEAVY_SLOTS=$HeavySlots"
        "KALCODE_GATE_MIN_FREE_GB=$MinFreeGb"
    ) | Set-Content -Encoding ascii -Path (Join-Path $dir '.env')
}

# 1. One new password, applied to the account and to every existing kalcode-ci runner service at once.
#    Letters and digits only: config.cmd is a batch file, so cmd metacharacters would break it.
$alphabet = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = 'Kc7' + (-join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] }))
Set-LocalUser -Name $Account -Password (ConvertTo-SecureString $password -AsPlainText -Force) -PasswordNeverExpires $true
$services = @(Get-CimInstance Win32_Service | Where-Object {
    $_.Name -like 'actions.runner.*' -and $_.StartName -match "(^|\\)$([regex]::Escape($Account))$"
})
foreach ($svc in $services) {
    & sc.exe config $svc.Name obj= ".\$Account" password= $password | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "could not update the logon of $($svc.Name) ($LASTEXITCODE)" }
}

# 2. The existing runner is slot 0.
Write-RunnerEnv $primary 0

# 3. The workers: same runner version, same account, label kalcode-gate, one service each.
$zip = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion.zip"
if (-not (Test-Path $zip)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip
}
$ErrorActionPreference = 'Continue' # config.cmd writes progress to stderr; its exit code is checked instead
foreach ($n in 1..$Workers) {
    $name = "kalcode-win-gate-w$n"
    $dir = Join-Path $Root "runner-w$n"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (-not (Test-Path (Join-Path $dir 'config.cmd'))) { Expand-Archive -Force -Path $zip -DestinationPath $dir }
    Write-RunnerEnv $dir $n
    if (Test-Path (Join-Path $dir '.runner')) { Write-Host "$name is already registered; .env refreshed."; continue }
    icacls $dir /grant:r "${Account}:(OI)(CI)M" /T /Q | Out-Null
    Push-Location $dir
    try {
        & .\config.cmd --unattended --replace `
            --url https://github.com/kalebcampbell2305/KalCode --token $RegistrationToken `
            --name $name --labels kalcode-gate --work _work `
            --runasservice --windowslogonaccount ".\$Account" --windowslogonpassword $password
        if ($LASTEXITCODE -ne 0) { throw "$name configuration failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    Write-Host "$name is installed and running as a service (slot $n)."
}
icacls $Root /grant:r "${Account}:(OI)(CI)M" /T /Q | Out-Null

# 4. Restart idle pre-existing services so they load their new .env; never interrupt a running gate.
foreach ($svc in $services) {
    # RunnerService.exe and Runner.Worker.exe both live in the runner's bin folder.
    $exe = if ($svc.PathName -match '^"([^"]+)"') { $Matches[1] } else { ($svc.PathName -split ' ')[0] }
    $bin = (Split-Path -Parent $exe) + '\'
    $busy = @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    if ($busy) {
        Write-Host "$($svc.Name) is running a job; it keeps its current settings until its next restart."
    } else {
        Restart-Service -Name $svc.Name
        Write-Host "$($svc.Name) restarted with its pool settings."
    }
}
Write-Host "Gate worker pool: kalcode-win-gate + $Workers workers, $HeavySlots heavy-gate tokens, $MinFreeGb GB free memory per heavy gate."
