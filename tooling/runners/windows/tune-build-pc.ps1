# One elevated, idempotent step on the build PC (DESKTOP-KOOB7VV) that stops the nonpaged-pool leak
# and the TCP ephemeral-port exhaustion that destabilise long-running gates.
#
# Root cause (measured 2026-10-06, two independent methods). Nonpaged pool reached 9.25 GB after
# ~44 h uptime. The top pool tags were NtFC (15.2M outstanding, 4.1 GB) and File (5.6M, 2.2 GB), with
# the Filter Manager stream-context tags (FMsl/FMsc) tracking them. NtFC is NTFS's own File-Control-
# Block tag (it is present only in ntfs.sys) and File is the I/O manager's FILE_OBJECT tag: ~15M NTFS
# FCBs and ~5.6M file objects are being PINNED in kernel pool, not leaked by any one process (process
# handles came to only ~246k). The pin scales with build file churn - cargo/rustc/node open and close
# millions of files per gate under the runner work root and the kc-* worktrees - and Windows Defender's
# on-access scanner (WdFilter, altitude 328010) holds a reference to each through its stream context.
# The pool only fully clears on reboot. That exhausted nonpaged pool is what produced
# net::ERR_NO_BUFFER_SPACE (WSAENOBUFS) and Tcpip 4231 (ephemeral ports) during lane gates. gameflt is
# ruled out: it is not the allocator of NtFC.
#
# It measures first, then (default):
#  - adds Defender PROCESS exclusions for the build toolchain (rustc, cargo, rust-analyzer, link, cl,
#    mspdbsrv, node). Process exclusions are location-independent, so they stop the scan of every
#    per-worktree target\ and node_modules without naming the ~200 kc-* worktrees one by one;
#  - adds Defender PATH exclusions for the persistent build trees (the gate runner work roots, the
#    Cargo and rustup homes for both the interactive user and each gate account, and each gate
#    account's %TEMP%);
#  - sets the IPv4/IPv6 TCP dynamic port range to 20000-65534 (45,535 ports) and TcpTimedWaitDelay=30
#    (both persist; a reboot applies them - reported as rebootRequired);
#  - makes the High performance power plan active;
#  - measures again and writes a receipt.
#
# Trade-off: Defender no longer scans files the build toolchain writes or the build roots. Only build
# and gate work writes there, the gate account is low-privilege and only same-repository branches are
# gated (never forks) - the same trade-off tune-gate-pc2.ps1 already makes on PC2.
#
# Refuses while a gate or release job runs (any Runner.Worker.exe); changing Defender preferences mid
# gate thrashes the scan cache. Never reboots by itself. -Undo restores Windows defaults.
#
# Usage (elevated PowerShell on the build PC, with no gate job running):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tune-build-pc.ps1            # measure, apply, measure
#   powershell -NoProfile -ExecutionPolicy Bypass -File tune-build-pc.ps1 -MeasureOnly
#   powershell -NoProfile -ExecutionPolicy Bypass -File tune-build-pc.ps1 -Undo
param(
    [switch]$MeasureOnly,
    [switch]$Undo,
    [string]$ExpectHost = 'DESKTOP-KOOB7VV',
    [string[]]$GateAccounts = @('kalcode-ci'),
    [string[]]$WorkRoots = @('C:\kalcode-ci', 'C:\kalcode-ci-pool'),
    [string]$Out = 'C:\kc-handoff\pool-trace'
)
$ErrorActionPreference = 'Stop'
$PROC = @('rustc.exe', 'cargo.exe', 'rust-analyzer.exe', 'link.exe', 'cl.exe', 'mspdbsrv.exe', 'node.exe')
$TCP_KEY = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters'
$result = [ordered]@{ schema = 'kalcode-build-pc-tuning/v1'; at = [DateTime]::UtcNow.ToString('o'); host = $env:COMPUTERNAME
    mode = $(if ($Undo) { 'undo' } elseif ($MeasureOnly) { 'measure' } else { 'apply' }); state = 'PREFLIGHT'; errorCode = $null
    nonpagedPoolGBBefore = $null; nonpagedPoolGBAfter = $null; exclusionPaths = @(); exclusionProcesses = @()
    tcp = [ordered]@{ before = $null; after = $null }; powerPlan = $null; rebootRequired = $false }
function Refuse([string]$Code) { $result.errorCode = $Code; throw "Build PC tuning refused: $Code" }
function PoolGB { try { [math]::Round((Get-Counter '\Memory\Pool Nonpaged Bytes').CounterSamples.CookedValue / 1GB, 2) } catch { $null } }
function TcpState {
    $range = (& netsh int ipv4 show dynamicport tcp 2>$null | Out-String).Trim()
    $delay = (Get-ItemProperty -Path $TCP_KEY -Name TcpTimedWaitDelay -ErrorAction SilentlyContinue).TcpTimedWaitDelay
    [ordered]@{ ipv4DynamicPort = $range; timedWaitDelay = $(if ($null -eq $delay) { 'default' } else { $delay }) }
}

try {
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Refuse 'windows_uac_required' }
    if ($env:COMPUTERNAME -ne $ExpectHost) { Refuse 'wrong_host' }
    if (@(Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'").Count) { Refuse 'gate_job_running' }

    # The persistent trees to exclude by path. Per-worktree target\ dirs are covered by the PROCESS
    # exclusions below, so they are deliberately not enumerated here.
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($r in $WorkRoots) { if (Test-Path -LiteralPath $r) { [void]$paths.Add($r) } }
    $cargo = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $rustup = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $env:USERPROFILE '.rustup' }
    foreach ($p in @($cargo, $rustup)) { if (Test-Path -LiteralPath $p) { [void]$paths.Add($p) } }
    foreach ($account in $GateAccounts) {
        $user = Get-LocalUser -Name $account -ErrorAction SilentlyContinue
        if (-not $user) { continue }
        $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value }).LocalPath
        if (-not $profilePath) { continue }
        foreach ($sub in @('.cargo', '.rustup', 'AppData\Local\Temp')) {
            $p = Join-Path $profilePath $sub
            if (Test-Path -LiteralPath $p) { [void]$paths.Add($p) }
        }
    }
    $paths = @($paths | Select-Object -Unique)

    $result.nonpagedPoolGBBefore = PoolGB
    $result.tcp.before = TcpState
    if ($MeasureOnly) {
        $result.exclusionPaths = $paths
        $result.exclusionProcesses = $PROC
        $result.state = 'MEASURED'
        return
    }

    if (-not (Get-Command Add-MpPreference -ErrorAction SilentlyContinue)) { Refuse 'defender_cmdlets_missing' }
    $existingPaths = @((Get-MpPreference).ExclusionPath)
    $existingProcs = @((Get-MpPreference).ExclusionProcess)
    foreach ($path in $paths) {
        if ($Undo) { if ($existingPaths -contains $path) { Remove-MpPreference -ExclusionPath $path } }
        else { if ($existingPaths -notcontains $path) { Add-MpPreference -ExclusionPath $path } }
    }
    foreach ($proc in $PROC) {
        if ($Undo) { if ($existingProcs -contains $proc) { Remove-MpPreference -ExclusionProcess $proc } }
        else { if ($existingProcs -notcontains $proc) { Add-MpPreference -ExclusionProcess $proc } }
    }
    $confirmedPaths = @((Get-MpPreference).ExclusionPath)
    $confirmedProcs = @((Get-MpPreference).ExclusionProcess)
    foreach ($path in $paths) {
        $want = -not $Undo
        if (($confirmedPaths -contains $path) -ne $want) { Refuse "path_exclusion_unconfirmed:$path" }
    }
    foreach ($proc in $PROC) {
        $want = -not $Undo
        if (($confirmedProcs -contains $proc) -ne $want) { Refuse "process_exclusion_unconfirmed:$proc" }
    }
    $result.exclusionPaths = $paths | ForEach-Object { [ordered]@{ path = $_; excluded = (-not $Undo) } }
    $result.exclusionProcesses = $PROC | ForEach-Object { [ordered]@{ process = $_; excluded = (-not $Undo) } }

    # TCP: widen the ephemeral range and shorten TIME_WAIT so a gate's many short-lived sockets do not
    # exhaust the range (Tcpip 4231). Both persist in the registry and take effect on the next reboot.
    $startPort = if ($Undo) { 49152 } else { 20000 }
    $numPorts = if ($Undo) { 16384 } else { 45535 }
    foreach ($family in @('ipv4', 'ipv6')) {
        & netsh int $family set dynamicport tcp start=$startPort num=$numPorts | Out-Null
    }
    if ($Undo) {
        Remove-ItemProperty -Path $TCP_KEY -Name TcpTimedWaitDelay -ErrorAction SilentlyContinue
    } else {
        Set-ItemProperty -Path $TCP_KEY -Name TcpTimedWaitDelay -Value 30 -Type DWord
    }
    $result.tcp.after = TcpState
    $result.rebootRequired = $true

    $scheme = if ($Undo) { 'SCHEME_BALANCED' } else { 'SCHEME_MIN' }
    & powercfg /setactive $scheme 2>&1 | Out-Null
    $result.powerPlan = [ordered]@{ requested = $scheme; ok = ($LASTEXITCODE -eq 0); active = ((& powercfg /getactivescheme) -join ' ').Trim() }

    $result.nonpagedPoolGBAfter = PoolGB
    $result.state = if ($Undo) { 'UNDONE' } else { 'TUNED' }
} catch {
    $result.state = 'FAILED'
    if (-not $result.errorCode) { $result.errorCode = $_.Exception.Message }
} finally {
    $receipt = $result | ConvertTo-Json -Depth 6
    try {
        if (-not (Test-Path -LiteralPath $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
        Set-Content -LiteralPath (Join-Path $Out ('build-pc-tuning-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.json')) -Value $receipt -Encoding UTF8
    } catch { Write-Warning "Receipt not written: $($_.Exception.Message)" }
    Write-Output $receipt
}
if ($result.state -eq 'FAILED') { exit 1 }
