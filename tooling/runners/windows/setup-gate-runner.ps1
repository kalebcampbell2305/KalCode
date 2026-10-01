# One-time, elevated: installs the KalCode PR/CI gate runner on the owner's Windows PC.
#
# The gate runner runs untrusted-by-default code (any branch or PR), so it runs as its own
# low-privilege local account, `kalcode-ci`, as a Windows service. That account cannot read the
# owner's profile, so it never sees the Azure signing login, the DPAPI updater key, Wrangler or
# gh credentials. It has its own Rust toolchain, pnpm, npm cache and Playwright browsers under
# C:\kalcode-ci, used by nothing else (a PR cannot poison the release runner's caches).
#
# Usage (elevated PowerShell; the registration token comes from
#   gh api -X POST repos/kalebcampbell2305/KalCode/actions/runners/registration-token --jq .token):
#   powershell -ExecutionPolicy Bypass -File setup-gate-runner.ps1 -RegistrationToken <token>

param(
    [Parameter(Mandatory = $true)][string]$RegistrationToken,
    [string]$RunnerVersion = '2.337.0',
    [string]$PnpmVersion = '10.33.2',
    [string]$Root = 'C:\kalcode-ci',
    [string]$Account = 'kalcode-ci'
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script elevated (Run as administrator).'
}

# 1. The account: a standard user with a random password nobody keeps. Only the service
#    control manager holds it.
Add-Type -AssemblyName System.Web
$password = [System.Web.Security.Membership]::GeneratePassword(40, 8)
$secure = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $Account -Password $secure -PasswordNeverExpires $true
} else {
    New-LocalUser -Name $Account -Password $secure -PasswordNeverExpires -UserMayNotChangePassword `
        -Description 'KalCode gate runner (no signing credentials)' | Out-Null
}

# 2. Its own tree. Only the account, SYSTEM and Administrators have access.
$ciHome = Join-Path $Root 'home'
$runner = Join-Path $Root 'runner'
New-Item -ItemType Directory -Force -Path $ciHome, $runner | Out-Null
icacls $Root /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${Account}:(OI)(CI)M" | Out-Null

$env:RUSTUP_HOME = Join-Path $ciHome 'rustup'
$env:CARGO_HOME = Join-Path $ciHome 'cargo'
$npmPrefix = Join-Path $ciHome 'npm'

# 3. Toolchain the account owns: rustup (the repo's rust-toolchain.toml picks the channel on
#    first use), pnpm pinned to the repo's packageManager.
# rustup picks its behaviour from its file name, so it must stay rustup-init.exe.
$rustupDir = Join-Path $env:TEMP 'kalcode-ci-rustup'
New-Item -ItemType Directory -Force -Path $rustupDir | Out-Null
$rustupInit = Join-Path $rustupDir 'rustup-init.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $rustupInit
& $rustupInit -y --no-modify-path --profile minimal --default-toolchain stable -c rustfmt -c clippy | Out-Null
if ($LASTEXITCODE -ne 0) { throw "rustup-init failed ($LASTEXITCODE)" }
& npm install --global --prefix $npmPrefix "pnpm@$PnpmVersion" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed ($LASTEXITCODE)" }

# 4. The runner, as a service running as the account. Its .env is the job environment: the
#    account's own toolchain and caches, nothing from the owner's profile.
$zip = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion.zip"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip
Expand-Archive -Force -Path $zip -DestinationPath $runner
@(
    "RUSTUP_HOME=$($env:RUSTUP_HOME)"
    "CARGO_HOME=$($env:CARGO_HOME)"
    "npm_config_cache=$(Join-Path $ciHome 'npm-cache')"
    "PNPM_HOME=$npmPrefix"
    "PLAYWRIGHT_BROWSERS_PATH=$(Join-Path $ciHome 'ms-playwright')"
    "CARGO_TARGET_DIR=$(Join-Path $Root 'target')"
    "PATH=$(Join-Path $env:CARGO_HOME 'bin');$npmPrefix;C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\Git\usr\bin;C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
    'GIT_CONFIG_NOSYSTEM=1'
) | Set-Content -Encoding ascii -Path (Join-Path $runner '.env')
icacls $Root /grant:r "${Account}:(OI)(CI)M" /T /Q | Out-Null

Push-Location $runner
try {
    & .\config.cmd --unattended --replace `
        --url https://github.com/kalebcampbell2305/KalCode --token $RegistrationToken `
        --name kalcode-win-gate --labels kalcode-gate --work _work `
        --runasservice --windowslogonaccount ".\$Account" --windowslogonpassword $password
    if ($LASTEXITCODE -ne 0) { throw "runner configuration failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host 'kalcode-win-gate is installed and running as a service.'
