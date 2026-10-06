# One elevated, idempotent step that gives every main-PC gate worker's Rust toolchain the
# aarch64-apple-darwin standard library, so the rust gate can cross-check the macOS update helper
# (`cargo check -p kalcode-update-helper --target aarch64-apple-darwin`).
#
# The gate accounts cannot add it themselves: slot 0 (kalcode-ci) owns C:\kalcode-ci\home\rustup, but
# w1..w5 share the pool's read-only C:\ProgramData\KalCodeGatePool\tools\rustup, where
# `rustup target add` exits 1 (gate 37386934450). New files inherit each home's existing ACLs.
# Refuses while any gate job runs on this PC. Never changes accounts, services, runner registrations
# or the toolchain channel. Writes a receipt into the pool's reports folder.
#
# Usage (elevated):
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-gate-rust-targets.ps1
param([string]$Target = 'aarch64-apple-darwin', [string]$Report = '')
$ErrorActionPreference = 'Stop'
$pool = 'C:\ProgramData\KalCodeGatePool'
$reports = Join-Path $pool 'reports'
if (-not $Report) { $Report = Join-Path $reports ('rust-target-install-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json') }
$result = [ordered]@{ schema = 'kalcode-gate-rust-target-install/v1'; state = 'PREFLIGHT'; at = [DateTime]::UtcNow.ToString('o')
    target = $Target; errorCode = $null; homes = @() }
function Refuse([string]$Code) { $result.errorCode = $Code; throw "Gate rust target install refused: $Code" }
function Assert-Plain([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and
            ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Refuse 'reparse_path' }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
# Slot 0 has its own toolchain; w1..w5 share the pool's (setup-gate-runner.ps1, setup-gate-worker-pool.ps1).
$homes = @(
    @{ name = 'slot0'; rustup = 'C:\kalcode-ci\home\rustup'; cargo = 'C:\kalcode-ci\home\cargo' },
    @{ name = 'pool'; rustup = (Join-Path $pool 'tools\rustup'); cargo = (Join-Path $pool 'tools\cargo') }
)
$runnerRoots = @('C:\kalcode-ci\runner') + @(1..5 | ForEach-Object { "C:\kalcode-ci-pool\worker-w$_\runner" })
function Assert-NoGateJob {
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'")) {
        if (-not $process.ExecutablePath) { Refuse 'unknown_job_process_owner' }
        foreach ($root in $runnerRoots) {
            if ($process.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { Refuse "gate_job_running_$(Split-Path -Leaf (Split-Path -Parent $root))" }
        }
    }
}
function Invoke-Rustup([hashtable]$RustHome, [string[]]$Arguments) {
    $saved = @($env:RUSTUP_HOME, $env:CARGO_HOME)
    try {
        $env:RUSTUP_HOME = $RustHome.rustup; $env:CARGO_HOME = $RustHome.cargo
        $output = & (Join-Path $RustHome.cargo 'bin\rustup.exe') @Arguments 2>&1 | ForEach-Object { "$_" }
        return @{ code = $LASTEXITCODE; output = @($output) }
    } finally { $env:RUSTUP_HOME = $saved[0]; $env:CARGO_HOME = $saved[1] }
}
try {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ([Environment]::MachineName -ne 'DESKTOP-KOOB7VV') { Refuse 'wrong_host' }
    if ($Target -notmatch '^[a-z0-9_]+(-[a-z0-9_]+){2,3}$') { Refuse 'bad_target' }
    Assert-NoGateJob

    foreach ($rustHome in $homes) {
        Assert-Plain $rustHome.rustup; Assert-Plain $rustHome.cargo
        if (-not (Test-Path -LiteralPath (Join-Path $rustHome.cargo 'bin\rustup.exe'))) { Refuse "rustup_missing_$($rustHome.name)" }
        $before = Invoke-Rustup $rustHome @('target', 'list', '--installed', '--toolchain', 'stable')
        if ($before.code) { Refuse "target_list_failed_$($rustHome.name)" }
        $had = $before.output -contains $Target
        if (-not $had) {
            Assert-NoGateJob
            $add = Invoke-Rustup $rustHome @('target', 'add', $Target, '--toolchain', 'stable')
            if ($add.code) { $result.homes += [ordered]@{ home = $rustHome.name; output = $add.output }; Refuse "target_add_failed_$($rustHome.name)" }
        }
        $after = Invoke-Rustup $rustHome @('target', 'list', '--installed', '--toolchain', 'stable')
        if ($after.code -or -not ($after.output -contains $Target)) { Refuse "target_unconfirmed_$($rustHome.name)" }
        $version = Invoke-Rustup $rustHome @('run', 'stable', 'rustc', '--version')
        $result.homes += [ordered]@{ home = $rustHome.name; rustupHome = $rustHome.rustup; added = (-not $had)
            rustc = ($version.output -join ' '); installed = @($after.output) }
    }
    $result.state = 'INSTALLED'
} catch {
    $result.state = 'FAILED'
    if (-not $result.errorCode) { $result.errorCode = $_.Exception.Message }
} finally {
    $receipt = $result | ConvertTo-Json -Depth 5
    try {
        if (Test-Path -LiteralPath $reports) { Assert-Plain $Report; Set-Content -LiteralPath $Report -Value $receipt -Encoding UTF8 }
    } catch { Write-Warning "Receipt not written: $($_.Exception.Message)" }
    Write-Output $receipt
}
if ($result.state -ne 'INSTALLED') { exit 1 }
