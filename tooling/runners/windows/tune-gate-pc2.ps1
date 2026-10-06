# One elevated, idempotent step on the second Windows PC (KALEBSLAPTOP) that makes its gate runner
# start processes at a normal speed. Measured 2026-10-06: each git process took ~1.3 s there against
# ~0.14 s on the build PC (merge-train test 5: 172 git calls, 220 s vs 24.6 s; gate 37410227962), so
# git- and process-heavy checks ran 3-8x slower and timed out.
#
# It measures first, then:
#  - adds Microsoft Defender path exclusions for the gate runner's tree (C:\kalcode-ci: work checkouts,
#    caches, the account's own toolchain) and the gate account's %TEMP%, where tests create thousands of
#    short-lived repos and files;
#  - makes the High performance power plan active (the laptop's balanced plan parks cores);
#  - measures again and writes a receipt with both timings.
# Trade-off: Defender no longer scans files written under those two paths. Only the gate account
# writes there, it runs as a low-privilege user without credentials (tooling/runners/README.md), and
# only same-repository branches are gated (never forks). Undo with -Undo.
#
# Usage (elevated PowerShell on KALEBSLAPTOP, with no gate job running):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tune-gate-pc2.ps1            # measure, apply, measure
#   powershell -NoProfile -ExecutionPolicy Bypass -File tune-gate-pc2.ps1 -MeasureOnly
#   powershell -NoProfile -ExecutionPolicy Bypass -File tune-gate-pc2.ps1 -Undo
param([switch]$MeasureOnly, [switch]$Undo, [string]$Account = 'kalcode-ci', [string]$Root = 'C:\kalcode-ci')
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ schema = 'kalcode-gate-pc2-tuning/v1'; at = [DateTime]::UtcNow.ToString('o'); host = $env:COMPUTERNAME
    state = 'PREFLIGHT'; errorCode = $null; exclusions = @(); powerPlan = $null; before = $null; after = $null }
function Refuse([string]$Code) { $result.errorCode = $Code; throw "PC2 gate tuning refused: $Code" }

function Measure-ProcessStart {
    # 30 `git --version` starts plus 10 throwaway `git init` repositories, in the gate account's %TEMP%
    # (the same paths the gate's tests use).
    $git = (Get-Command git -ErrorAction Stop).Source
    $scratch = Join-Path $script:temp ('kc-tuning-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $scratch | Out-Null
    try {
        $spawn = [Diagnostics.Stopwatch]::StartNew()
        foreach ($i in 1..30) { & $git --version | Out-Null }
        $spawn.Stop()
        $init = [Diagnostics.Stopwatch]::StartNew()
        foreach ($i in 1..10) { & $git init -q (Join-Path $scratch "r$i") | Out-Null }
        $init.Stop()
        return [ordered]@{ gitStartMs = [math]::Round($spawn.Elapsed.TotalMilliseconds / 30, 1)
            gitInitMs = [math]::Round($init.Elapsed.TotalMilliseconds / 10, 1) }
    } finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

try {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ($env:COMPUTERNAME -ne 'KALEBSLAPTOP') { Refuse 'wrong_host' }
    $user = Get-LocalUser -Name $Account -ErrorAction SilentlyContinue
    if (-not $user) { Refuse 'gate_account_missing' }
    $gateProfile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value }).LocalPath
    if (-not $gateProfile) { Refuse 'gate_profile_missing' }
    $script:temp = Join-Path $gateProfile 'AppData\Local\Temp'
    if (-not (Test-Path -LiteralPath $script:temp)) { Refuse 'gate_temp_missing' }
    if (-not (Test-Path -LiteralPath $Root)) { Refuse 'gate_root_missing' }
    if (@(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'").Count) { Refuse 'gate_job_running' }
    $paths = @($Root, $script:temp)

    $result.before = Measure-ProcessStart
    if ($MeasureOnly) { $result.state = 'MEASURED'; return }

    if (-not (Get-Command Add-MpPreference -ErrorAction SilentlyContinue)) { Refuse 'defender_cmdlets_missing' }
    $existing = @((Get-MpPreference).ExclusionPath)
    foreach ($path in $paths) {
        if ($Undo) {
            if ($existing -contains $path) { Remove-MpPreference -ExclusionPath $path }
            $result.exclusions += [ordered]@{ path = $path; excluded = $false }
        } else {
            if ($existing -notcontains $path) { Add-MpPreference -ExclusionPath $path }
            $result.exclusions += [ordered]@{ path = $path; excluded = $true }
        }
    }
    $confirmed = @((Get-MpPreference).ExclusionPath)
    foreach ($entry in $result.exclusions) {
        if (($confirmed -contains $entry.path) -ne $entry.excluded) { Refuse "exclusion_unconfirmed:$($entry.path)" }
    }

    # High performance (SCHEME_MIN); Balanced (SCHEME_BALANCED) on -Undo. Some laptops hide the High
    # performance scheme; that is reported, not fatal.
    $scheme = if ($Undo) { 'SCHEME_BALANCED' } else { 'SCHEME_MIN' }
    & powercfg /setactive $scheme 2>&1 | Out-Null
    $result.powerPlan = [ordered]@{ requested = $scheme; ok = ($LASTEXITCODE -eq 0); active = ((& powercfg /getactivescheme) -join ' ').Trim() }

    $result.after = Measure-ProcessStart
    $result.state = if ($Undo) { 'UNDONE' } else { 'TUNED' }
} catch {
    $result.state = 'FAILED'
    if (-not $result.errorCode) { $result.errorCode = $_.Exception.Message }
} finally {
    $receipt = $result | ConvertTo-Json -Depth 5
    try {
        if ($script:temp -and (Test-Path -LiteralPath $Root)) {
            Set-Content -LiteralPath (Join-Path $Root ('pc2-tuning-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json')) -Value $receipt -Encoding UTF8
        }
    } catch { Write-Warning "Receipt not written: $($_.Exception.Message)" }
    Write-Output $receipt
}
if ($result.state -eq 'FAILED') { exit 1 }
